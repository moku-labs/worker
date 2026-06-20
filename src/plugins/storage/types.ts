/**
 * @file storage plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import type { BindingsApi, bindingsPlugin } from "../bindings";

export type { StorageProvider } from "./providers/types";

/**
 * A single R2 bucket instance: its base Cloudflare name, the env binding it resolves off, and an
 * optional deploy-time upload directory.
 *
 * @example
 * ```typescript
 * { name: "tracker-files", binding: "FILES" }
 * ```
 */
export type R2Instance = {
  /** Base Cloudflare R2 bucket name (stage-suffixed at deploy). */
  name: string;
  /** Env binding name the bucket resolves off the per-request `env` (e.g. `env.FILES`). */
  binding: string;
  /** Directory uploaded to this bucket at deploy (deploy metadata only). */
  upload?: string;
  /** Marks this instance the default when more than one is configured. */
  default?: boolean;
};

/**
 * storage plugin config — a keyed map of R2 bucket instances. The key is the stable logical id used by
 * `app.storage.use("key")`; a single entry (or one flagged `default: true`) is the implicit default.
 *
 * @example
 * ```typescript
 * { files: { name: "tracker-files", binding: "FILES" } }
 * ```
 */
export type StorageConfig = Record<string, R2Instance>;

/**
 * The env-first object surface for one R2 bucket (the methods bound to a single instance).
 *
 * @example
 * ```typescript
 * const body = await app.storage.get(env, "assets/logo.png");
 * await app.storage.use("uploads").put(env, "avatar.png", buffer);
 * ```
 */
export type StorageBucketApi = {
  /**
   * Read an object; resolves null when the key is absent.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param key - Object key.
   * @returns The object body, or null.
   */
  get(env: WorkerEnv, key: string): Promise<R2ObjectBody | null>;
  /**
   * Write an object.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param key - Object key.
   * @param value - Object contents.
   * @returns The written object metadata.
   */
  put(
    env: WorkerEnv,
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
  ): Promise<R2Object>;
  /**
   * Remove an object (or keys). No-op when absent.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param key - Object key or keys.
   * @returns Resolves once removed.
   */
  delete(env: WorkerEnv, key: string | string[]): Promise<void>;
  /**
   * List objects, optionally filtered by R2ListOptions.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param opts - Optional prefix / limit / cursor / delimiter.
   * @returns The list result.
   */
  list(env: WorkerEnv, opts?: R2ListOptions): Promise<R2Objects>;
};

/**
 * The app.storage surface — the default bucket's methods, a `use(key)` selector for the others, plus
 * deploy metadata.
 *
 * @example
 * ```typescript
 * const body = await app.storage.get(env, "assets/logo.png");      // default bucket
 * await app.storage.use("uploads").put(env, "avatar.png", buffer); // a named bucket
 * ```
 */
export type StorageApi = StorageBucketApi & {
  /**
   * Select a specific R2 bucket instance by its config key.
   *
   * @param key - The instance key (as configured under `pluginConfigs.storage`).
   * @returns The object surface bound to that bucket.
   */
  use(key: string): StorageBucketApi;
  /**
   * Returns this plugin's own deploy metadata (one entry per configured bucket), read by the deploy
   * plugin. Build-time only — takes no env.
   *
   * @returns One r2 deploy descriptor per configured instance.
   */
  deployManifest(): Array<{ kind: "r2"; name: string; binding: string; upload?: string }>;
};

/**
 * Internal context type — own config first, no state, no storage events.
 * Intersected with a narrow `require` typed to the one dependency storage
 * resolves — mirrors the kv/api.ts pattern (PluginCtx has no `require` by
 * default; core does not export a generic RequireFunction).
 */
export type StorageCtx = PluginCtx<StorageConfig, Record<string, never>, WorkerEvents> & {
  /**
   * Resolve a dependency plugin's api. storage only ever resolves bindingsPlugin.
   *
   * @param plugin - The bindingsPlugin instance.
   * @returns The resolved bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};
