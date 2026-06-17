/**
 * @file storage plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import type { BindingsApi, bindingsPlugin } from "../bindings";

export type { StorageProvider } from "./providers/types";

/**
 * storage plugin configuration. Flat; complete defaults so omission never yields undefined.
 *
 * @example
 * ```ts
 * { upload: "./public", bucket: "ASSETS" }
 * ```
 */
export type StorageConfig = {
  /** Directory uploaded to R2 at deploy (deploy metadata only). Default "". */
  upload: string;
  /** R2 bucket binding name resolved off the per-request env. Default "ASSETS". */
  bucket: string;
};

/** Deploy metadata returned to the deploy plugin. */
export type StorageManifest = {
  /** Discriminant identifying this as an R2 resource. */
  readonly kind: "r2";
  /** R2 bucket binding name. */
  readonly bucket: string;
  /** Directory uploaded to R2 at deploy. */
  readonly upload: string;
};

/** Public storage API surface (env-first). */
export type StorageApi = {
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
  /**
   * Build-time deploy metadata for the deploy plugin.
   *
   * @returns Deploy manifest entry `{ kind: "r2", bucket, upload }`.
   */
  deployManifest(): StorageManifest;
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
