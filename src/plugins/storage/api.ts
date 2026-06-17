/**
 * @file storage plugin — API factory skeleton (env-first get/put/delete/list/deployManifest).
 */
import type { StorageApi, StorageCtx } from "./types";

/**
 * Build the env-first storage API. Each runtime method resolves the bucket provider
 * fresh from the per-request env — nothing is stored, so concurrent requests stay isolated.
 *
 * @param _ctx - Plugin context (config + require).
 * @example
 * ```ts
 * const api = createStorageApi(ctx);
 * ```
 */
export function createStorageApi(_ctx: StorageCtx): StorageApi {
  throw new Error("not implemented");
}
