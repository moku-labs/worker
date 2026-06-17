/**
 * @file cli plugin — API factory skeleton (dev, deploy) — thin passthroughs to deploy.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import type { Api, Config } from "./types";

/** cli context — own config, no state, global events; global config read via ctx.global. */
type CliCtx = PluginCtx<Config, Record<string, never>, WorkerEvents>;

/**
 * Builds app.cli.* — thin passthroughs to the deploy plugin via ctx.require(deployPlugin).
 *
 * @param _ctx - Plugin context (own config + require).
 * @example
 * ```ts
 * const api = createCliApi(ctx);
 * ```
 */
export function createCliApi(_ctx: CliCtx): Api {
  throw new Error("not implemented");
}
