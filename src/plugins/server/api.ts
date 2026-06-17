/**
 * @file server plugin — API factory skeleton (handle, scheduled).
 */
import type { Api, ServerCtx } from "./types";

/**
 * Builds the app.server.* surface (handle, scheduled) the consumer's Worker
 * default export reads.
 *
 * @param _ctx - Plugin context (config, state, emit, require, has).
 * @example
 * ```ts
 * const api = createServerApi(ctx);
 * ```
 */
export function createServerApi(_ctx: ServerCtx): Api {
  throw new Error("not implemented");
}
