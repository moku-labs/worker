/**
 * @file cli plugin — API factory (dev, deploy, auth, doctor).
 */
import { createBrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import { deployPlugin } from "../deploy";
import type { Api as DeployApi, WebBuild } from "../deploy/types";
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
 * Builds app.cli.* — thin passthroughs to the deploy plugin via ctx.require(deployPlugin).
 * Both verbs forward their opts verbatim; `dev` defaults port to ctx.config.port when no
 * opts are supplied.
 *
 * @param ctx - CLI plugin context (own config + typed require to deployPlugin).
 * @returns The cli API object with `dev` and `deploy` methods.
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * await api.dev();            // → deploy.dev({ port: 8787 })
 * await api.deploy({ yes: true }); // → deploy.run({ yes: true })
 * ```
 */
export const createCliApi = (ctx: CliCtx): Api => ({
  /**
   * Run the Worker locally; defaults port to ctx.config.port (8787) when no opts supplied. A
   * `webBuild` hook (e.g. `() => webApp.cli.build()`) wires the web build into the dev loop so the
   * site recompiles on change — this is how an app-side script composes web + worker.
   *
   * @param opts - Optional local dev options.
   * @param opts.port - Local dev port to bind. Defaults to ctx.config.port (8787).
   * @param opts.webBuild - Rebuild the web site on change (e.g. `() => webApp.cli.build()`).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await api.dev();                                   // port 8787, worker only
   * await api.dev({ webBuild: () => web.cli.build() }); // wire the web build in
   * ```
   */
  dev(opts?: { port?: number; webBuild?: WebBuild }): Promise<void> {
    const port = opts?.port ?? ctx.config.port;
    return ctx
      .require(deployPlugin)
      .dev(opts?.webBuild ? { port, webBuild: opts.webBuild } : { port });
  },

  /**
   * One-command guided Cloudflare deploy; forwards flags verbatim to deploy.run.
   * Passes `undefined` when called with no opts (not a default empty object). A `webBuild` hook
   * builds the web site first (before `wrangler deploy`) — how an app-side script ships web + worker.
   *
   * @param opts - Optional deploy options.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive / CI).
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await api.deploy({ guided: true, webBuild: () => web.cli.build() });
   * await api.deploy({ yes: true }); // CI
   * await api.deploy(); // opts === undefined
   * ```
   */
  deploy(opts?: { guided?: boolean; yes?: boolean; webBuild?: WebBuild }): Promise<void> {
    return ctx.require(deployPlugin).run(opts);
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
      for (const line of deploy.tokenInstructions().split("\n")) {
        ui.line(line);
      }
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
