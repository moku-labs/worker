/**
 * @file deploy plugin — API factory skeleton (run, dev, init).
 */
import type { Api, Ctx } from "./types";

/**
 * Create the deploy api. Assembles the manifest from each resource plugin's own
 * deployManifest() (never sibling config), provisions, generates config, uploads,
 * and runs `wrangler deploy`, emitting global deploy events along the way.
 *
 * @param _ctx - Plugin context (own config + require + has + emit + global).
 * @example
 * ```ts
 * const api = createDeployApi(ctx);
 * ```
 */
export function createDeployApi(_ctx: Ctx): Api {
  throw new Error("not implemented");
}
