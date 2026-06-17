/**
 * @file storage plugin — API factory (env-first get/put/delete/list/deployManifest).
 *
 * WorkerEnv = Record<string, unknown> (re-exported from ../../config).
 * R2Bucket is an ambient global from cloudflare/workers-types — never imported.
 */
import type { WorkerEnv } from "../../config";
import { bindingsPlugin } from "../bindings";
import { resolveR2Provider } from "./providers/r2";
import type { StorageApi, StorageCtx, StorageManifest } from "./types";

/**
 * Build the env-first storage API. Each runtime method resolves the bucket
 * provider fresh from the per-request `env` — nothing is stored, so concurrent
 * requests stay isolated (worker-api-design SB4; spec/08 §6,§7).
 *
 * The `deployManifest()` method is build-time only: it reads from `ctx.config`
 * and never touches `env` or R2.
 *
 * @param ctx - Plugin context (config + require for bindings resolution).
 * @returns {StorageApi} The env-first storage API surface.
 * @example
 * ```typescript
 * const api = createStorageApi(ctx);
 * const body = await api.get(env, "my-object");
 * ```
 */
export const createStorageApi = (ctx: StorageCtx): StorageApi => {
  /**
   * Resolve the StorageProvider for the given per-request env. Called on every
   * method invocation — the bucket binding is never cached across calls.
   *
   * @param env - The per-request Cloudflare bindings object.
   * @returns {StorageProvider} A StorageProvider delegating to the resolved R2Bucket.
   * @example
   * ```typescript
   * const p = provider(env);
   * const body = await p.get("key");
   * ```
   */
  const provider = (env: WorkerEnv) =>
    resolveR2Provider(ctx.require(bindingsPlugin), env, ctx.config.bucket);

  return {
    /**
     * Read an object from the bucket; resolves null when the key is absent.
     *
     * @param env - Per-request Cloudflare bindings.
     * @param key - Object key.
     * @returns {Promise<R2ObjectBody | null>} The R2ObjectBody, or null.
     * @example
     * ```typescript
     * const body = await api.get(env, "assets/logo.png");
     * ```
     */
    get: (env, key) => provider(env).get(key),

    /**
     * Write an object to the bucket.
     *
     * @param env - Per-request Cloudflare bindings.
     * @param key - Object key.
     * @param value - Object contents (ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null).
     * @returns {Promise<R2Object>} The R2Object metadata for the written object.
     * @example
     * ```typescript
     * const obj = await api.put(env, "assets/logo.png", buffer);
     * ```
     */
    put: (env, key, value) => provider(env).put(key, value),

    /**
     * Remove an object (or array of keys) from the bucket. No-op when absent.
     *
     * @param env - Per-request Cloudflare bindings.
     * @param key - Object key or array of keys.
     * @returns {Promise<void>} Resolves once removed.
     * @example
     * ```typescript
     * await api.delete(env, "assets/old.png");
     * ```
     */
    delete: (env, key) => provider(env).delete(key),

    /**
     * List objects, optionally filtered by R2ListOptions.
     *
     * @param env - Per-request Cloudflare bindings.
     * @param opts - Optional R2ListOptions (prefix, limit, cursor, delimiter).
     * @returns {Promise<R2Objects>} The R2Objects list result.
     * @example
     * ```typescript
     * const { objects } = await api.list(env, { prefix: "images/" });
     * ```
     */
    list: (env, opts) => provider(env).list(opts),

    /**
     * Return this plugin's deploy metadata. Build-time only — does not touch
     * `env` or R2. The deploy plugin reads this via `ctx.require(storagePlugin).deployManifest()`.
     *
     * @returns {StorageManifest} Deploy manifest entry `{ kind: "r2", bucket, upload }`.
     * @example
     * ```typescript
     * const manifest = api.deployManifest();
     * // { kind: "r2", bucket: "ASSETS", upload: "./public" }
     * ```
     */
    deployManifest: (): StorageManifest => ({
      kind: "r2",
      bucket: ctx.config.bucket,
      upload: ctx.config.upload
    })
  };
};
