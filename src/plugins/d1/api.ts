/**
 * @file d1 plugin — API factory skeleton. Thin typed wrappers over prepare().bind().
 */
import type { Api, D1Ctx } from "./types";

/**
 * Create the d1 api. Each method resolves the D1Database off the request env via
 * the bindings plugin, then forwards to the native D1 call.
 *
 * @param _ctx - Plugin context (own config + require).
 * @example
 * ```ts
 * const api = createD1Api(ctx);
 * ```
 */
export function createD1Api(_ctx: D1Ctx): Api {
  throw new Error("not implemented");
}
