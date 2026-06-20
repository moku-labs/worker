/**
 * @file storage plugin — API factory (env-first get/put/delete/list/deployManifest).
 *
 * WorkerEnv = Record<string, unknown> (re-exported from ../../config).
 * R2Bucket is an ambient global from cloudflare/workers-types — never imported.
 */

import type { WorkerEnv } from "../../config";
import { defaultInstanceKey, pickInstance } from "../../instances";
import { bindingsPlugin } from "../bindings";
import { resolveR2Provider } from "./providers/r2";
import type { StorageApi, StorageBucketApi, StorageCtx } from "./types";

/**
 * Build the app.storage.* api over a keyed map of R2 bucket instances. The default-bucket methods and
 * `use(key)` both resolve the bucket off the REQUEST-SUPPLIED env on every call — env is threaded,
 * never stored (worker-api-design SB4; spec/08 §6,§7) — and the instance key is resolved lazily so an
 * unconfigured-but-present plugin only errors when actually called.
 *
 * The `deployManifest()` method is build-time only: it reads from `ctx.config`
 * and never touches `env` or R2.
 *
 * @param ctx - Plugin context (keyed-map config + require for bindings resolution).
 * @returns {StorageApi} The app.storage api: get / put / delete / list / use / deployManifest.
 * @example
 * ```typescript
 * const api = createStorageApi(ctx);
 * const body = await api.get(env, "my-object");
 * await api.use("uploads").put(env, "avatar.png", buffer);
 * ```
 */
export const createStorageApi = (ctx: StorageCtx): StorageApi => {
  const bindings = ctx.require(bindingsPlugin);

  // The get/put/delete/list surface bound to one bucket, resolved lazily by binding-getter so the
  // default key (and a `use(key)` lookup) is resolved at call time, not at createApp time.
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const surface = (binding: () => string): StorageBucketApi => {
    // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
    const provider = (env: WorkerEnv) => resolveR2Provider(bindings, env, binding());
    return {
      /**
       * Read an object from this bucket; resolves null when the key is absent.
       *
       * @param env - The per-request Cloudflare env.
       * @param key - The object key to read.
       * @returns The object body, or null.
       * @example
       * ```typescript
       * const body = await api.get(env, "assets/logo.png");
       * ```
       */
      get: (env, key) => provider(env).get(key),
      /**
       * Write an object to this bucket.
       *
       * @param env - The per-request Cloudflare env.
       * @param key - The object key to write.
       * @param value - The object contents.
       * @returns The written object metadata.
       * @example
       * ```typescript
       * await api.put(env, "avatar.png", buffer);
       * ```
       */
      put: (env, key, value) => provider(env).put(key, value),
      /**
       * Remove an object (or keys) from this bucket. No-op when absent.
       *
       * @param env - The per-request Cloudflare env.
       * @param key - The object key or keys to delete.
       * @returns Resolves once removed.
       * @example
       * ```typescript
       * await api.delete(env, "assets/old-logo.png");
       * ```
       */
      delete: (env, key) => provider(env).delete(key),
      /**
       * List objects in this bucket, optionally filtered by R2ListOptions.
       *
       * @param env - The per-request Cloudflare env.
       * @param opts - Optional prefix / limit / cursor / delimiter.
       * @returns The list result.
       * @example
       * ```typescript
       * const { objects } = await api.list(env, { prefix: "assets/" });
       * ```
       */
      list: (env, opts) => provider(env).list(opts)
    };
  };

  // The default bucket's binding, resolved lazily (errors only when actually called).
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const defaultBinding = (): string =>
    pickInstance(ctx.config, defaultInstanceKey(ctx.config, "r2"), "r2").binding;

  return {
    ...surface(defaultBinding),
    /**
     * Select a specific R2 bucket instance by its config key.
     *
     * @param key - The instance key (as configured under `pluginConfigs.storage`).
     * @returns The object surface bound to that bucket.
     * @example
     * ```typescript
     * await api.use("uploads").put(env, "avatar.png", buffer);
     * ```
     */
    use: (key: string) => surface(() => pickInstance(ctx.config, key, "r2").binding),
    /**
     * Return this plugin's deploy metadata — one descriptor per configured bucket.
     *
     * @returns One r2 deploy descriptor per instance.
     * @example
     * ```typescript
     * const manifest = api.deployManifest(); // [{ kind: "r2", name: "tracker-files", binding: "FILES" }]
     * ```
     */
    deployManifest: () =>
      Object.values(ctx.config).map(instance => ({
        kind: "r2" as const,
        name: instance.name,
        binding: instance.binding,
        ...(instance.upload === undefined ? {} : { upload: instance.upload })
      }))
  };
};
