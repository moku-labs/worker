/**
 * @file cli plugin — API factory (dev, deploy, auth, doctor).
 */
import { createBrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import { deployPlugin } from "../deploy";
import { renderAuthSetup } from "../deploy/auth/render";
import type { Api as DeployApi, DeployReport, OnChange, WebBuild } from "../deploy/types";
import { parseStageArg } from "./args";
import type { Api, Config } from "./types";

/**
 * CLI plugin context type — own config, no state, global events.
 *
 * PluginCtx<C, S, E> surfaces only `config`/`state`/`emit`. The `require` fn
 * is composed in via intersection, typed to the single dependency: deployPlugin.
 * This mirrors the kv single-dep overload pattern (kv/api.ts Context).
 */
export type CliCtx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /**
   * Resolve the deploy plugin's API (the single dependency of cli).
   *
   * @param plugin - The deployPlugin instance.
   * @returns The deploy API: dev / run / init.
   */
  require(plugin: typeof deployPlugin): DeployApi;
};

/**
 * Builds app.cli.* over the deploy plugin (via ctx.require(deployPlugin)). `dev`/`deploy` resolve
 * their args (port from `--port`; guided unless `ci`) then delegate, catching any failure into a
 * branded `✗` line + non-zero exit; the read-only verbs (auth/doctor/whoami) render in Moku style.
 *
 * @param ctx - CLI plugin context (own config + typed require to deployPlugin).
 * @returns The cli API object (dev, deploy, auth, doctor, whoami, wrangler).
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * await api.dev({ webBuild: () => web.cli.build() }); // → deploy.dev({ port })
 * await api.deploy({ ci: true });                     // → deploy.run({ ci: true })
 * ```
 */
export const createCliApi = (ctx: CliCtx): Api => ({
  /**
   * Run the Worker locally. The dev port comes ONLY from `opts.port` — the consumer passes it (e.g.
   * parsed from its own CLI flags in scripts/dev.ts); when omitted it defaults to wrangler's 8787.
   * There is no hidden argv/config port resolution. Prints a branded dev-session banner, then
   * delegates to deploy.dev; a `webBuild` hook (e.g. `() => webApp.cli.build()`) wires the web build
   * into the dev loop so the site recompiles on change. A failure renders a branded `✗` line +
   * non-zero exit, not a stack.
   *
   * @param opts - Optional local dev options.
   * @param opts.port - Local dev port to bind. Defaults to 8787 when omitted.
   * @param opts.stage - Stage for the generated wrangler config; falls back to `--stage` then the app stage.
   * @param opts.webBuild - Cold-build the web site (e.g. `() => webApp.cli.build()`); also the
   *   per-change rebuild when `onChange` is omitted.
   * @param opts.onChange - Incremental per-change rebuild (e.g. `changes => webApp.cli.update(changes)`),
   *   so each change rebuilds only the changed paths instead of a full `webBuild()`.
   * @param opts.seed - Load the configured seed (`pluginConfigs.deploy.seed`) into the LOCAL D1 and
   *   reset its cached KV keys before serving — the local analogue of `deploy({ seed: true })`.
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await api.dev({ port: 7878, seed: true, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
   * ```
   */
  async dev(opts?: {
    port?: number;
    stage?: string;
    webBuild?: WebBuild;
    onChange?: OnChange;
    seed?: boolean;
  }): Promise<void> {
    const ui = createBrandConsole();
    ui.lockup({ wordmark: "moku worker", label: "dev session" });

    const stage = opts?.stage ?? parseStageArg(process.argv);
    try {
      await ctx.require(deployPlugin).dev({
        ...(opts?.port === undefined ? {} : { port: opts.port }),
        ...(stage === undefined ? {} : { stage }),
        ...(opts?.webBuild ? { webBuild: opts.webBuild } : {}),
        ...(opts?.onChange ? { onChange: opts.onChange } : {}),
        ...(opts?.seed ? { seed: opts.seed } : {})
      });
      ui.check(true, "dev session stopped cleanly");
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },

  /**
   * One-command Cloudflare deploy; forwards opts verbatim to deploy.run, then — only on a successful
   * deploy — the requested post-deploy migration/seed. Guided/interactive by default; `{ ci: true }`
   * runs the automated path (CI). A `webBuild` hook builds the web site first (before `wrangler
   * deploy`). RETURNS the structured {@link DeployReport}; on a failure it also renders a branded `✗`
   * line + sets a non-zero exit code (matching cli.auth/doctor), never a raw stack trace.
   *
   * @param opts - Optional deploy options.
   * @param opts.ci - Automated mode: never prompts, auto-confirms. Omit/false → guided on a TTY.
   * @param opts.stage - Target stage (resource-name suffix); falls back to `--stage` then the app stage.
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @param opts.migration - Apply pending remote D1 migrations after a successful deploy (skipped on abort).
   * @param opts.seed - Load the configured remote seed (`pluginConfigs.deploy.seed`) after a
   *   successful deploy (+ migration); skipped on an aborted deploy.
   * @param opts.delete - Destroy all infrastructure for the stage instead of deploying
   *   (double-confirmed, interactive-only). When true, every other option is ignored.
   * @returns The deploy report (status, url, resource tally, migration/seed outcome, errors).
   * @example
   * ```ts
   * const report = await api.deploy({ webBuild: () => web.cli.build(), migration: true, seed: true });
   * if (report.status === "aborted") return; // creds not set up yet — nothing shipped
   * await api.deploy({ delete: true, stage: "dev" }); // tear the dev stage back down
   * ```
   */
  async deploy(opts?: {
    ci?: boolean;
    stage?: string;
    webBuild?: WebBuild;
    migration?: boolean;
    seed?: boolean;
    delete?: boolean;
  }): Promise<DeployReport> {
    const stage = opts?.stage ?? parseStageArg(process.argv);

    // `{ delete: true }` is a teardown, not a deploy: bypass the pipeline (all other options are
    // ignored) and route to deploy.destroy, which double-confirms before removing the stage.
    if (opts?.delete === true) {
      try {
        const report = await ctx
          .require(deployPlugin)
          .destroy(stage === undefined ? {} : { stage });
        if (report.status === "failed") process.exitCode = 1;
        return report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        createBrandConsole().error(message);
        process.exitCode = 1;
        return {
          ok: false,
          status: "failed",
          stage: stage ?? "production",
          migration: "skipped",
          seed: "skipped",
          elapsedMs: 0,
          errors: [message]
        };
      }
    }

    try {
      const report = await ctx
        .require(deployPlugin)
        .run({ ...opts, ...(stage === undefined ? {} : { stage }) });
      // run() already rendered the summary + any inline post-step errors; a "failed" report only
      // needs the non-zero exit here. An "aborted" report is a clean, intentional stop (exit 0).
      if (report.status === "failed") process.exitCode = 1;
      return report;
    } catch (error) {
      // Hard failure (the CI fail-fast path threw before a report existed) — brand it, set the exit
      // code, and still hand back a structured failed report so callers never face a raw throw.
      const message = error instanceof Error ? error.message : String(error);
      createBrandConsole().error(message);
      process.exitCode = 1;
      return {
        ok: false,
        status: "failed",
        stage: stage ?? "production",
        migration: "skipped",
        seed: "skipped",
        elapsedMs: 0,
        errors: [message]
      };
    }
  },

  /**
   * Seed a configured D1 database from a SQL file (delegates to deploy.seed). Local by default;
   * `opts.remote` seeds Cloudflare. The stage is resolved from a `--stage <name>` CLI flag (so
   * `bun run dev --seed --stage dev` seeds the dev database). A failure renders a branded `✗` line
   * and sets a non-zero exit code rather than throwing.
   *
   * @param sqlFile - Path to the SQL file to execute (e.g. "db/seed.sql").
   * @param opts - Optional options.
   * @param opts.binding - The d1 binding to target when more than one is configured (e.g. "DB").
   * @param opts.remote - Seed the remote (Cloudflare) D1 instead of the local one.
   * @returns Resolves once the seed completes (or after a failure is rendered).
   * @example
   * ```ts
   * await app.cli.seed("db/seed.sql"); // before app.cli.dev(...)
   * ```
   */
  async seed(sqlFile: string, opts?: { binding?: string; remote?: boolean }): Promise<void> {
    const ui = createBrandConsole();
    ui.lockup({ wordmark: "moku worker", label: "seed" });

    const stage = parseStageArg(process.argv);
    try {
      await ctx
        .require(deployPlugin)
        .seed(sqlFile, { ...opts, ...(stage === undefined ? {} : { stage }) });
      ui.check(true, "seeded", sqlFile);
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  },

  /**
   * Verify the `.env` token (no sub) or print the config-derived token guidance (`"setup"`),
   * rendered in Moku style. `setup` works without a token; verify reports the resolved account.
   *
   * @param sub - Pass "setup" to print guidance; omit to verify the current token.
   * @returns Resolves once the check or guidance render completes.
   * @example
   * ```ts
   * await api.auth("setup"); // print what token to create
   * await api.auth();        // verify the current token
   * ```
   */
  async auth(sub?: "setup"): Promise<void> {
    const deploy = ctx.require(deployPlugin);
    const ui = createBrandConsole();

    if (sub === "setup") {
      renderAuthSetup(ui, deploy.requiredToken(), { ci: deploy.ciToken() });
      return;
    }

    try {
      const status = await deploy.verifyAuth();
      ui.check(true, "token valid", `account "${status.account}" (${status.accountId})`);
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * One-shot preflight report: token + account (verifyAuth) then infra drift (checkInfra),
   * each as a branded check line. Stops after the token check when auth fails.
   *
   * @returns Resolves once the report is printed.
   * @example
   * ```ts
   * await api.doctor();
   * ```
   */
  async doctor(): Promise<void> {
    const deploy = ctx.require(deployPlugin);
    const ui = createBrandConsole();
    ui.heading("doctor");

    let tokenOk = false;
    try {
      const status = await deploy.verifyAuth();
      tokenOk = true;
      ui.check(true, "token", `valid · account "${status.account}" (${status.accountId})`);
    } catch (error) {
      ui.check(false, "token", error instanceof Error ? error.message : String(error));
    }

    if (!tokenOk) {
      ui.line("Run `auth setup` for the exact token to create.");
      return;
    }

    try {
      const plan = await deploy.checkInfra();
      ui.check(
        true,
        "infra",
        `${plan.exists.length} exist, ${plan.missing.length} to create in "${plan.account}"`
      );
    } catch (error) {
      ui.check(false, "infra", error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Print the resolved Cloudflare account for the current `.env` token.
   *
   * @returns Resolves once the account summary is printed.
   * @example
   * ```ts
   * await api.whoami();
   * ```
   */
  async whoami(): Promise<void> {
    const ui = createBrandConsole();
    try {
      const status = await ctx.require(deployPlugin).verifyAuth();
      ui.check(true, "account", `${status.account} (${status.accountId})`);
    } catch (error) {
      ui.error(error instanceof Error ? error.message : String(error));
    }
  },

  /**
   * Run an arbitrary wrangler command through the branded CLI (escape hatch). Streams its output.
   *
   * @param args - The wrangler arguments.
   * @returns Resolves once wrangler exits.
   * @example
   * ```ts
   * await api.wrangler(["kv", "namespace", "list"]);
   * ```
   */
  async wrangler(args: string[]): Promise<void> {
    createBrandConsole().heading(`wrangler ${args.join(" ")}`);
    await ctx.require(deployPlugin).wrangler(args);
  }
});
