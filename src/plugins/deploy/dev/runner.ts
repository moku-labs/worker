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

import { d1Plugin } from "../../d1";
import { runWrangler } from "../runner";
import type { Ctx } from "../types";
import { buildSite } from "./build";
import { watchPaths } from "./watch";

/** Injectable side effects so runDev is testable without real processes/watchers/signals. */
export type DevDeps = {
  /** Rebuild the Moku site; returns the file count. */
  build: (ctx: Ctx) => Promise<{ files: number }>;
  /** Run a one-shot wrangler command (e.g. local d1 migrations). */
  runWrangler: (args: string[]) => Promise<string>;
  /** Spawn the long-lived `wrangler dev` child (non-blocking). */
  spawnDev: (args: string[]) => { kill: () => void };
  /** Watch the globs, firing a debounced change callback. */
  watch: (
    globs: string[],
    debounceMs: number,
    onChange: (changedPath: string) => unknown
  ) => { close: () => void };
  /** Resolves when the user interrupts the session (SIGINT). */
  untilSignal: () => Promise<void>;
  /** Wall-clock timestamp (ms) for rebuild timing. */
  now: () => number;
};

/**
 * Spawn the long-lived `wrangler dev` child (inherits the parent env; non-blocking).
 *
 * @param args - The `wrangler dev …` arguments.
 * @returns A handle exposing kill().
 * @example
 * ```ts
 * const child = spawnWranglerDev(["dev", "--port", "8787"]);
 * ```
 */
const spawnWranglerDev = (args: string[]): { kill: () => void } => {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
  const child = spawn("wrangler", args, { stdio: "inherit" });
  // eslint-disable-next-line jsdoc/require-jsdoc -- inner handle method bound to the spawned child
  return { kill: () => child.kill() };
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
 * The d1 binding to migrate locally, when a d1 plugin is present in the app.
 *
 * @param ctx - The deploy plugin context.
 * @returns The d1 binding name, or undefined when no d1 plugin is present.
 * @example
 * ```ts
 * const binding = d1Binding(ctx); // "DB" | undefined
 * ```
 */
const d1Binding = (ctx: Ctx): string | undefined =>
  ctx.has("d1") ? ctx.require(d1Plugin).deployManifest().binding : undefined;

/**
 * Rebuild the site once and announce the result. A failed build keeps the session alive (it just
 * emits dev:error and serves the last good build).
 *
 * @param ctx - The deploy plugin context.
 * @param deps - The injected dev deps.
 * @param changedPath - The path that triggered the rebuild.
 * @returns Resolves once the rebuild attempt completes.
 * @example
 * ```ts
 * await rebuild(ctx, deps, "src/app.tsx");
 * ```
 */
const rebuild = async (ctx: Ctx, deps: DevDeps, changedPath: string): Promise<void> => {
  ctx.emit("dev:phase", { phase: "rebuild", detail: changedPath });
  const started = deps.now();
  try {
    const { files } = await deps.build(ctx);
    ctx.emit("dev:rebuilt", { files, ms: deps.now() - started });
  } catch (error) {
    ctx.emit("dev:error", { message: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Run a long-lived dev session: cold build → (local d1 migrate) → spawn `wrangler dev` →
 * watch + rebuild on change → teardown on signal.
 *
 * @param ctx - The deploy plugin context (config + emit + require/has).
 * @param opts - Optional options.
 * @param opts.port - Local dev port (default 8787).
 * @param deps - Injected side effects (real ones from realDevDeps in production).
 * @returns Resolves when the session ends (SIGINT).
 * @example
 * ```ts
 * await runDev(ctx, { port: 8787 }, realDevDeps());
 * ```
 */
export const runDev = async (
  ctx: Ctx,
  opts: { port?: number } | undefined,
  deps: DevDeps
): Promise<void> => {
  const port = opts?.port ?? 8787;

  // Cold build so the ASSETS dir has content before wrangler serves it.
  ctx.emit("dev:phase", { phase: "build", detail: "site" });
  await deps.build(ctx);

  // Apply local D1 migrations when configured and a d1 plugin is present.
  const binding = d1Binding(ctx);
  if (ctx.config.migrateLocal && binding !== undefined) {
    ctx.emit("dev:phase", { phase: "migrate", detail: "d1 (local)" });
    await deps.runWrangler(["d1", "migrations", "apply", binding, "--local"]);
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
  const watcher = deps.watch(ctx.config.watch, ctx.config.debounceMs, changedPath =>
    rebuild(ctx, deps, changedPath)
  );

  // Block until interrupted, then tear down cleanly.
  await deps.untilSignal();
  watcher.close();
  child.kill();
  ctx.emit("dev:phase", { phase: "stopped" });
};
