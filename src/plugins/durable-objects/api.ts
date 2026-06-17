/**
 * @file durableObjects plugin — API factory skeleton (get, deployManifest).
 */
import type { Api, Ctx } from "./types";

/**
 * Builds app.durableObjects.* — reached by handlers via require(durableObjectsPlugin).
 * Resolves the DO namespace off the request env per call; env is threaded, never stored.
 *
 * @param _ctx - Plugin context (own config + require).
 * @example
 * ```ts
 * const api = createDoApi(ctx);
 * ```
 */
export function createDoApi(_ctx: Ctx): Api {
  throw new Error("not implemented");
}
