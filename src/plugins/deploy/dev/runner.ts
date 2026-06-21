/**
 * @file deploy plugin — dev watch/recompile orchestrator.
 *
 * One long-lived session: cold-build the Moku site, optionally apply local D1 migrations, spawn
 * `wrangler dev --live-reload` ONCE, then watch the site sources and rebuild on change (wrangler's
 * asset server live-reloads the browser). Build failures keep the session serving the last good
 * build. Tears down cleanly on SIGINT. Side-effecting work is injected via DevDeps so the
 * orchestration is unit-testable without real processes, watchers, or signals.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { spawn } from "node:child_process";

import { createBrandConsole } from "@moku-labs/common/cli";

import { d1Plugin } from "../../d1";
import { renderMigrateSummary, renderSeedSummary } from "../infra/render";
import { runWrangler } from "../runner";
import { parseMigrationsApplied, runConfiguredSeed } from "../seed";
import type { Ctx, MigrationOutcome, OnChange, WebBuild } from "../types";
import { buildSite, fileCountOf } from "./build";
import { watchPaths } from "./watch";

/** Grace period (ms) before escalating a hung `wrangler dev` shutdown from SIGINT to SIGKILL. */
const STOP_GRACE_MS = 4000;

/** Injectable side effects so runDev is testable without real processes/watchers/signals. */
export type DevDeps = {
  /** Rebuild the Moku site via the resolved web build (call-time hook → config → command); returns the file count. */
  build: (ctx: Ctx, webBuild?: WebBuild) => Promise<{ files: number }>;
  /** Run a one-shot wrangler command (e.g. local d1 migrations). */
  runWrangler: (args: string[]) => Promise<string>;
  /**
   * Spawn the long-lived `wrangler dev` child (non-blocking). `whenExited` settles when it exits or
   * fails to spawn; `stop()` shuts it down (and throws a branded spawn failure) once it is gone.
   */
  spawnDev: (args: string[]) => { stop: () => Promise<void>; whenExited: Promise<void> };
  /** Watch the globs, firing a debounced change callback with the changed-path set. */
  watch: (
    globs: string[],
    debounceMs: number,
    onChange: (changedPaths: string[]) => unknown
  ) => { close: () => void };
  /** Resolves when the user interrupts the session (SIGINT). */
  untilSignal: () => Promise<void>;
  /** Wall-clock timestamp (ms) for rebuild timing. */
  now: () => number;
};

/**
 * Spawn the long-lived `wrangler dev` child (inherits the parent env; non-blocking).
 *
 * `whenExited` settles when the child exits OR fails to spawn — the `error` listener is essential:
 * a missing/unexecutable wrangler emits `error` (not `exit`), which is otherwise unhandled (crashes
 * the process) and would leave `whenExited` pending forever, hanging `stop()`. `stop()` shuts
 * wrangler down the way its own Ctrl+C does — a graceful SIGINT, then a SIGKILL escalation if it has
 * not exited within {@link STOP_GRACE_MS} — resolving only once it is gone; a spawn failure is
 * surfaced as a thrown branded error so the caller can render it. Without the wait, the
 * inherited-stdio child can keep the parent alive after the watcher closes ("stuck on stopping").
 *
 * @param args - The `wrangler dev …` arguments.
 * @returns A handle: `whenExited` (settles on exit/spawn-failure) and `stop()` (resolves once gone).
 * @example
 * ```ts
 * const child = spawnWranglerDev(["dev", "--port", "8787"]);
 * await Promise.race([untilSignal(), child.whenExited]);
 * await child.stop();
 * ```
 */
const spawnWranglerDev = (
  args: string[]
): { stop: () => Promise<void>; whenExited: Promise<void> } => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
  const child = spawn("wrangler", args, { stdio: "inherit" });

  // Settle on a normal exit OR a spawn failure (`error` fires instead of `exit` when wrangler is
  // missing / not executable). The `error` listener both prevents an unhandled-event crash and
  // guarantees `whenExited` resolves, so `stop()` can never hang.
  let spawnError: Error | undefined;
  const whenExited = new Promise<void>(resolve => {
    child.once("exit", () => {
      resolve();
    });
    child.once("error", error => {
      spawnError = new Error(`[worker] Failed to spawn wrangler.\n  ${error.message}`);
      resolve();
    });
  });

  // eslint-disable-next-line jsdoc/require-jsdoc -- inner handle method bound to the spawned child
  const stop = async (): Promise<void> => {
    if (spawnError !== undefined) throw spawnError; // wrangler never started — surface it branded
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return; // already gone
    child.kill("SIGINT"); // graceful — let wrangler run its own shutdown
    const forceKill = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    await whenExited;
    clearTimeout(forceKill);
  };

  return { stop, whenExited };
};

/**
 * Resolve when the user first interrupts the dev session (SIGINT).
 *
 * @returns A promise that settles on the first SIGINT.
 * @example
 * ```ts
 * await waitForSigint();
 * ```
 */
const waitForSigint = (): Promise<void> => {
  return new Promise<void>(resolve => {
    process.once("SIGINT", () => {
      resolve();
    });
  });
};

/**
 * Wall-clock timestamp in ms (extracted so realDevDeps holds only named references).
 *
 * @returns The current time in milliseconds.
 * @example
 * ```ts
 * const t = nowMs();
 * ```
 */
const nowMs = (): number => Date.now();

/**
 * Build the real (side-effecting) dev deps used by api.dev(). Subprocesses inherit the parent env.
 *
 * @returns The production DevDeps (real spawn / fs.watch / SIGINT / Date.now).
 * @example
 * ```ts
 * await runDev(ctx, opts, realDevDeps());
 * ```
 */
export const realDevDeps = (): DevDeps => ({
  build: buildSite,
  runWrangler,
  spawnDev: spawnWranglerDev,
  watch: watchPaths,
  untilSignal: waitForSigint,
  now: nowMs
});

/**
 * The d1 bindings to migrate locally — one per configured d1 instance that declares a migrations
 * directory (empty when no d1 plugin is present, or none declares migrations).
 *
 * @param ctx - The deploy plugin context.
 * @returns The d1 binding names with migrations (e.g. `["DB"]`).
 * @example
 * ```ts
 * const bindings = d1MigrationBindings(ctx); // ["DB"]
 * ```
 */
const d1MigrationBindings = (ctx: Ctx): string[] =>
  ctx.has("d1")
    ? ctx
        .require(d1Plugin)
        .deployManifest()
        .filter(manifest => manifest.migrations !== undefined)
        .map(manifest => manifest.binding)
    : [];

/**
 * One-line description of a changed-path batch for the `dev:phase rebuild` detail: the single path,
 * or the first path plus a `(+N more)` tail. Empty batches (defensive) read as "site".
 *
 * @param paths - The changed paths the watcher coalesced for this rebuild.
 * @returns The detail string for the rebuild phase event.
 * @example
 * ```ts
 * describeChanges(["src/a.ts", "src/b.css"]); // "src/a.ts (+1 more)"
 * ```
 */
const describeChanges = (paths: readonly string[]): string => {
  const [first, ...rest] = paths;
  if (first === undefined) return "site";
  return rest.length === 0 ? first : `${first} (+${String(rest.length)} more)`;
};

/**
 * Rebuild the site once for a changed-path batch and announce the result. The FAST path is the
 * incremental `onChange(changedPaths)` hook (e.g. `web.cli.update`) when wired; otherwise it falls
 * back to a full `webBuild()` rebuild (via deps.build) — the prior behavior. A failed rebuild keeps
 * the session alive (it just emits dev:error and serves the last good build). Both paths share one
 * `dev:phase rebuild` → `dev:rebuilt`/`dev:error` envelope so the branded dev TUI is identical.
 *
 * @param ctx - The deploy plugin context.
 * @param deps - The injected dev deps.
 * @param changedPaths - The paths that triggered the rebuild (the watcher's debounced set).
 * @param hooks - The consumer rebuild hooks.
 * @param hooks.webBuild - Full rebuild (used when `onChange` is absent — the prior behavior).
 * @param hooks.onChange - Incremental rebuild for the changed set (the fast path when wired).
 * @returns Resolves once the rebuild attempt completes.
 * @example
 * ```ts
 * await rebuild(ctx, deps, ["src/app.tsx"], { onChange: c => web.cli.update(c) });
 * ```
 */
const rebuild = async (
  ctx: Ctx,
  deps: DevDeps,
  changedPaths: string[],
  hooks: { webBuild?: WebBuild | undefined; onChange?: OnChange | undefined }
): Promise<void> => {
  ctx.emit("dev:phase", { phase: "rebuild", detail: describeChanges(changedPaths) });
  const started = deps.now();
  try {
    // Incremental hook wins when wired (rebuild only what changed); else a full webBuild().
    let files: number;
    if (hooks.onChange) {
      files = fileCountOf(await hooks.onChange(changedPaths));
    } else {
      const built = await deps.build(ctx, hooks.webBuild);
      files = built.files;
    }
    ctx.emit("dev:rebuilt", { files, ms: deps.now() - started });
  } catch (error) {
    ctx.emit("dev:error", { message: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Load the configured seed into the LOCAL D1 for a `dev --seed` session: execute the SQL file, then
 * clear the configured cached KV keys so the app rebuilds them from the freshly-seeded rows. The
 * schema already exists (the migrate step above runs first), so this never migrates — the local
 * analogue of the deploy's remote seed, over the same `pluginConfigs.deploy.seed` config.
 *
 * @param ctx - The deploy plugin context.
 * @param deps - The injected dev deps (for the wrangler runner).
 * @returns Resolves once the seed file has executed and every cached KV key is cleared.
 * @throws {Error} When `--seed` is set but no seed is configured under `pluginConfigs.deploy.seed`.
 * @example
 * ```ts
 * await seedLocal(ctx, realDevDeps());
 * ```
 */
const seedLocal = async (ctx: Ctx, deps: DevDeps): Promise<void> => {
  const config = ctx.config.seed;
  if (config === undefined) {
    throw new Error(
      "[worker] dev({ seed: true }) but no seed is configured — set pluginConfigs.deploy.seed."
    );
  }
  ctx.emit("dev:phase", { phase: "seed", detail: config.file });
  const outcome = await runConfiguredSeed(ctx, deps.runWrangler, config, "--local");
  renderSeedSummary(createBrandConsole(), outcome, "local");
};

/**
 * Run a long-lived dev session: cold build → (local d1 migrate) → (local seed) → spawn `wrangler
 * dev` → watch + rebuild on change → teardown on signal.
 *
 * @param ctx - The deploy plugin context (config + emit + require/has).
 * @param opts - Optional options.
 * @param opts.port - Local dev port (default 8787).
 * @param opts.webBuild - Cold-build hook (also the per-change rebuild when `onChange` is omitted).
 * @param opts.onChange - Incremental per-change rebuild hook (e.g. `c => web.cli.update(c)`); when
 *   set, each debounced change rebuilds only the changed paths instead of a full `webBuild()`.
 * @param opts.seed - Load the configured seed into the LOCAL D1 (+ reset its KV keys) before serving.
 * @param deps - Injected side effects (real ones from realDevDeps in production).
 * @returns Resolves when the session ends (SIGINT).
 * @example
 * ```ts
 * await runDev(ctx, { port: 8787, seed: true, webBuild: () => web.cli.build() }, realDevDeps());
 * ```
 */
export const runDev = async (
  ctx: Ctx,
  opts: { port?: number; webBuild?: WebBuild; onChange?: OnChange; seed?: boolean } | undefined,
  deps: DevDeps
): Promise<void> => {
  const port = opts?.port ?? 8787;
  const webBuild = opts?.webBuild;
  const onChange = opts?.onChange;
  const seed = opts?.seed === true;

  // Cold build so the ASSETS dir has content before wrangler serves it.
  ctx.emit("dev:phase", { phase: "build", detail: "site" });
  await deps.build(ctx, webBuild);

  // Apply local D1 migrations when configured — once per d1 instance that declares migrations.
  // `--seed` also forces this: the local seed below needs the schema, even if `migrateLocal` is off.
  const migrationBindings = ctx.config.migrateLocal || seed ? d1MigrationBindings(ctx) : [];
  if (migrationBindings.length > 0) {
    ctx.emit("dev:phase", { phase: "migrate", detail: "d1 (local)" });
    // Capture each apply (wrangler's raw migration TUI is hidden), then brand what applied.
    const outcomes: MigrationOutcome[] = [];
    for (const binding of migrationBindings) {
      const output = await deps.runWrangler(["d1", "migrations", "apply", binding, "--local"]);
      outcomes.push({ binding, ...parseMigrationsApplied(output) });
    }
    renderMigrateSummary(createBrandConsole(), outcomes, "local");
  }

  // Load the local seed when `--seed` is set (tables now exist) — the local twin of `deploy --seed`.
  if (seed) {
    await seedLocal(ctx, deps);
  }

  // Spawn wrangler dev ONCE; it stays up across site rebuilds (its asset server live-reloads).
  ctx.emit("dev:phase", { phase: "serve", detail: `http://localhost:${String(port)}` });
  const child = deps.spawnDev([
    "dev",
    "--port",
    String(port),
    "--config",
    ctx.config.configFile,
    "--live-reload"
  ]);

  // Watch the site sources; each change rebuilds (wrangler is never restarted for a site change).
  // The fast incremental `onChange` hook wins when wired; otherwise a full `webBuild()` rebuild.
  const watcher = deps.watch(ctx.config.watch, ctx.config.debounceMs, changedPaths =>
    rebuild(ctx, deps, changedPaths, { webBuild, onChange })
  );

  // Block until the user interrupts (SIGINT) OR wrangler exits on its own — a crash, a spawn
  // failure, or pressing `x` in its TUI — then tear down cleanly: stop watching, ask wrangler to
  // shut down, and WAIT for it to actually exit (escalating to SIGKILL if it hangs) so the process
  // never gets stuck. `stop()` rethrows a spawn failure so the caller renders it branded.
  await Promise.race([deps.untilSignal(), child.whenExited]);
  ctx.emit("dev:phase", { phase: "stopping" });
  watcher.close();
  await child.stop();
};
