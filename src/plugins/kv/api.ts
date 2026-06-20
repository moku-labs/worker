/**
 * kv api factory — extracted from index.ts to satisfy the ≤30 effective-line
 * wiring rule (skeleton-conventions.md §1). Micro tier logic lives here.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";
import { defaultInstanceKey, pickInstance } from "../../instances";
import type { BindingsApi } from "../bindings";
import { bindingsPlugin } from "../bindings";

/**
 * A single KV namespace instance: its base Cloudflare name + the env binding it resolves off.
 *
 * @example
 * ```typescript
 * { name: "tracker-cache", binding: "CACHE" }
 * ```
 */
export type KvInstance = {
  /** Base Cloudflare KV namespace name (stage-suffixed at deploy). */
  name: string;
  /** Env binding name the namespace resolves off the per-request `env` (e.g. `env.CACHE`). */
  binding: string;
  /** Marks this instance the default when more than one is configured. */
  default?: boolean;
};

/**
 * kv plugin config — a keyed map of KV namespace instances. The key is the stable logical id used by
 * `app.kv.use("key")`; a single entry (or one flagged `default: true`) is the implicit default.
 *
 * @example
 * ```typescript
 * { cache: { name: "tracker-cache", binding: "CACHE" } }
 * ```
 */
export type Config = Record<string, KvInstance>;

/**
 * The env-first key/value surface for one KV namespace (the methods bound to a single instance).
 *
 * @example
 * ```typescript
 * const value = await app.kv.get(env, "feature-flags");
 * await app.kv.use("sessions").put(env, "session:1", "data", { expirationTtl: 3600 });
 * ```
 */
export type KvNamespaceApi = {
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
};

/**
 * The app.kv surface — the default namespace's methods, a `use(key)` selector for the others, plus
 * deploy metadata.
 *
 * @example
 * ```typescript
 * const value = await app.kv.get(env, "feature-flags");        // default namespace
 * await app.kv.use("sessions").put(env, "s:1", "data");        // a named namespace
 * ```
 */
export type KvApi = KvNamespaceApi & {
  /**
   * Select a specific KV namespace instance by its config key.
   *
   * @param key - The instance key (as configured under `pluginConfigs.kv`).
   * @returns The key/value surface bound to that namespace.
   */
  use(key: string): KvNamespaceApi;
  /**
   * Returns this plugin's own deploy metadata (one entry per configured namespace), read by the
   * deploy plugin. Build-time only — takes no env.
   *
   * @returns One kv deploy descriptor per configured instance.
   */
  deployManifest(): Array<{ kind: "kv"; name: string; binding: string }>;
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
 * Builds the app.kv.* api over a keyed map of namespace instances. The default-namespace methods and
 * `use(key)` both resolve the namespace off the REQUEST-SUPPLIED env on every call — env is threaded,
 * never stored (design §1a / SB4) — and the instance key is resolved lazily so an unconfigured-but-
 * present plugin only errors when actually called.
 *
 * @param ctx - The kv plugin context (keyed-map config + merged events).
 * @returns The app.kv api: get / put / delete / list / use / deployManifest.
 * @example
 * ```typescript
 * const api = createKvApi(ctx);
 * const value = await api.get(env, "key");
 * await api.use("sessions").put(env, "s:1", "data");
 * ```
 */
export const createKvApi = (ctx: Context): KvApi => {
  const bindings = ctx.require(bindingsPlugin);

  // The get/put/delete/list surface bound to one namespace, resolved lazily by binding-getter so the
  // default key (and a `use(key)` lookup) is resolved at call time, not at createApp time.
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const surface = (binding: () => string): KvNamespaceApi => {
    // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
    const ns = (env: WorkerEnvironment): KVNamespace =>
      bindings.require<KVNamespace>(env, binding());
    return {
      /**
       * Read a value by key from this namespace. Returns null when absent.
       *
       * @param env - The per-request Cloudflare env.
       * @param key - The key to read.
       * @returns The stored value, or null when absent.
       * @example
       * ```typescript
       * const value = await api.get(env, "feature-flags");
       * ```
       */
      get: async (env, key) => ns(env).get(key),
      /**
       * Write a string value under a key, optionally with KV put options.
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
      put: async (env, key, value, opts) => ns(env).put(key, value, opts),
      /**
       * Remove a key from this namespace (no-op if absent).
       *
       * @param env - The per-request Cloudflare env.
       * @param key - The key to delete.
       * @returns Resolves once the delete is acknowledged.
       * @example
       * ```typescript
       * await api.delete(env, "session:expired");
       * ```
       */
      delete: async (env, key) => ns(env).delete(key),
      /**
       * List keys in this namespace, optionally filtered/paginated.
       *
       * @param env - The per-request Cloudflare env.
       * @param opts - Optional prefix / cursor / limit.
       * @returns The list result.
       * @example
       * ```typescript
       * const { keys } = await api.list(env, { prefix: "session:" });
       * ```
       */
      list: async (env, opts) => ns(env).list(opts)
    };
  };

  // The default namespace's binding, resolved lazily (errors only when actually called).
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const defaultBinding = (): string =>
    pickInstance(ctx.config, defaultInstanceKey(ctx.config, "kv"), "kv").binding;

  return {
    ...surface(defaultBinding),
    /**
     * Select a specific KV namespace instance by its config key.
     *
     * @param key - The instance key (as configured under `pluginConfigs.kv`).
     * @returns The key/value surface bound to that namespace.
     * @example
     * ```typescript
     * await api.use("sessions").get(env, "s:1");
     * ```
     */
    use: (key: string) => surface(() => pickInstance(ctx.config, key, "kv").binding),
    /**
     * Return this plugin's deploy metadata — one descriptor per configured namespace.
     *
     * @returns One kv deploy descriptor per instance.
     * @example
     * ```typescript
     * const manifest = api.deployManifest(); // [{ kind: "kv", name: "tracker-cache", binding: "CACHE" }]
     * ```
     */
    deployManifest: () =>
      Object.values(ctx.config).map(instance => ({
        kind: "kv" as const,
        name: instance.name,
        binding: instance.binding
      }))
  };
};
