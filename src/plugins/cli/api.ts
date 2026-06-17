/**
 * @file cli plugin — API factory (dev, deploy) — thin passthroughs to deploy.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import { deployPlugin } from "../deploy";
import type { Api as DeployApi } from "../deploy/types";
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
   * Run the Worker locally; defaults port to ctx.config.port (8787) when no opts supplied.
   *
   * @param opts - Optional local dev options.
   * @param opts.port - Local dev port to bind. Defaults to ctx.config.port (8787).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await api.dev();            // port 8787
   * await api.dev({ port: 3000 }); // port 3000
   * ```
   */
  dev(opts?: { port?: number }): Promise<void> {
    return ctx.require(deployPlugin).dev(opts ?? { port: ctx.config.port });
  },

  /**
   * One-command guided Cloudflare deploy; forwards flags verbatim to deploy.run.
   * Passes `undefined` when called with no opts (not a default empty object).
   *
   * @param opts - Optional deploy options.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive / CI).
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await api.deploy({ guided: true });
   * await api.deploy({ yes: true }); // CI
   * await api.deploy(); // opts === undefined
   * ```
   */
  deploy(opts?: { guided?: boolean; yes?: boolean }): Promise<void> {
    return ctx.require(deployPlugin).run(opts);
  }
});
