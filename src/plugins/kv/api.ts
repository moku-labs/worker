/**
 * kv api factory — extracted from index.ts to satisfy the ≤30 effective-line
 * wiring rule (skeleton-conventions.md §1). Micro tier logic lives here.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";
import type { BindingsApi } from "../bindings";
import { bindingsPlugin } from "../bindings";

/**
 * kv plugin config — binding name resolved off the request env.
 *
 * @example
 * ```typescript
 * { binding: "SESSIONS" }
 * ```
 */
export type Config = {
  /**
   * The Cloudflare binding name of the KV namespace, as declared in wrangler
   * config / passed in the per-request `env`. Default `"KV"`.
   */
  binding: string;
};

/**
 * The app.kv surface — env-first key/value access plus deploy metadata.
 *
 * @example
 * ```typescript
 * const value = await app.kv.get(env, "feature-flags");
 * await app.kv.put(env, "session:1", "data", { expirationTtl: 3600 });
 * ```
 */
export type KvApi = {
  /**
   * Reads a value by key from the KV namespace. Returns null when absent.
   *
   * @param env - The per-request Cloudflare env (threaded, never stored).
   * @param key - The key to read.
   * @returns The stored value, or null when absent.
   */
  get(env: WorkerEnvironment, key: string): Promise<string | null>;
  /**
   * Writes a string value under a key, optionally with KV put options.
   *
   * @param env - The per-request Cloudflare env.
   * @param key - The key to write.
   * @param value - The string value to store.
   * @param opts - Optional expiration / metadata.
   * @returns Resolves once the write is acknowledged.
   */
  put(
    env: WorkerEnvironment,
    key: string,
    value: string,
    opts?: KVNamespacePutOptions
  ): Promise<void>;
  /**
   * Removes a key from the namespace (no-op if absent).
   *
   * @param env - The per-request Cloudflare env.
   * @param key - The key to delete.
   * @returns Resolves once the delete is acknowledged.
   */
  delete(env: WorkerEnvironment, key: string): Promise<void>;
  /**
   * Lists keys in the namespace, optionally filtered/paginated.
   *
   * @param env - The per-request Cloudflare env.
   * @param opts - Optional prefix / cursor / limit.
   * @returns The list result.
   */
  list(
    env: WorkerEnvironment,
    opts?: KVNamespaceListOptions
  ): Promise<KVNamespaceListResult<unknown, string>>;
  /**
   * Returns this plugin's own deploy metadata, read by the deploy plugin.
   * Build-time only — takes no env.
   *
   * @returns The kv deploy descriptor.
   */
  deployManifest(): { kind: "kv"; binding: string };
};

/**
 * THIS plugin's own config first; empty state = Record<string, never> (spec/08 §6).
 * WorkerEvents flows in from createCoreConfig via the ../../config closure.
 *
 * `PluginCtx` exposes only `config`/`state`/`emit`; `require` is composed in here
 * (core's "advanced composition" note), typed to the one dependency kv resolves —
 * `require(bindingsPlugin)` → `BindingsApi`. No `RequireFunction` is exported by core.
 */
export type Context = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /**
   * Resolve a dependency plugin's api. kv only ever resolves `bindingsPlugin`.
   *
   * @param plugin - The dependency plugin instance (bindingsPlugin).
   * @returns The resolved bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};

/**
 * Builds the app.kv.* api. Resolves the KV namespace off the REQUEST-SUPPLIED env
 * on every call — env is threaded, never stored (design §1a / SB4).
 *
 * @param ctx - The kv plugin context (own config + merged events).
 * @returns The app.kv api: get / put / delete / list / deployManifest.
 * @example
 * ```typescript
 * const api = createKvApi(ctx);
 * const value = await api.get(env, "key");
 * ```
 */
export const createKvApi = (ctx: Context): KvApi => {
  // Resolves the KV namespace from the per-request env on every call (SB4 — never cached).
  // eslint-disable-next-line jsdoc/require-jsdoc
  const ns = (env: WorkerEnvironment): KVNamespace =>
    ctx.require(bindingsPlugin).require<KVNamespace>(env, ctx.config.binding);

  return {
    /**
     * Reads a value by key from the KV namespace. Returns null when absent.
     *
     * @param env - The per-request Cloudflare env (threaded, never stored).
     * @param key - The key to read.
     * @returns The stored value, or null when absent.
     * @example
     * ```typescript
     * const value = await api.get(env, "feature-flags");
     * ```
     */
    get: async (env: WorkerEnvironment, key: string) => ns(env).get(key),

    /**
     * Writes a string value under a key, optionally with KV put options.
     *
     * @param env - The per-request Cloudflare env.
     * @param key - The key to write.
     * @param value - The string value to store.
     * @param opts - Optional expiration / metadata.
     * @returns Resolves once the write is acknowledged.
     * @example
     * ```typescript
     * await api.put(env, "session:1", "data", { expirationTtl: 3600 });
     * ```
     */
    put: async (env: WorkerEnvironment, key: string, value: string, opts?: KVNamespacePutOptions) =>
      ns(env).put(key, value, opts),

    /**
     * Removes a key from the namespace (no-op if absent).
     *
     * @param env - The per-request Cloudflare env.
     * @param key - The key to delete.
     * @returns Resolves once the delete is acknowledged.
     * @example
     * ```typescript
     * await api.delete(env, "session:expired");
     * ```
     */
    delete: async (env: WorkerEnvironment, key: string) => ns(env).delete(key),

    /**
     * Lists keys in the namespace, optionally filtered/paginated via opts.
     *
     * @param env - The per-request Cloudflare env.
     * @param opts - Optional prefix / cursor / limit.
     * @returns The list result from the KV namespace.
     * @example
     * ```typescript
     * const { keys } = await api.list(env, { prefix: "session:" });
     * ```
     */
    list: async (env: WorkerEnvironment, opts?: KVNamespaceListOptions) => ns(env).list(opts),

    /**
     * Returns this plugin's own deploy metadata, read by the deploy plugin via
     * require (design §6 / F6). Build-time only — takes no env.
     *
     * @returns The kv deploy descriptor with kind literal and binding name.
     * @example
     * ```typescript
     * const manifest = api.deployManifest(); // { kind: "kv", binding: "KV" }
     * ```
     */
    deployManifest: () => ({ kind: "kv" as const, binding: ctx.config.binding })
  };
};
