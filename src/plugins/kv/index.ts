/**
 * @file kv — Micro-tier plugin skeleton. Thin wrapper over a Cloudflare KV namespace.
 * @see README.md
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";

/**
 * Configuration for the kv plugin. Flat; complete default so omission never yields undefined.
 */
type Config = {
  /** KV namespace binding name resolved off the request env. Default "KV". */
  binding: string;
};

/** The app.kv surface (env-first key/value access + deploy metadata). */
export type KvApi = {
  /** Read a value by key; null when absent. */
  get(env: WorkerEnvironment, key: string): Promise<string | null>;
  /** Write a string value, optionally with KV put options. */
  put(
    env: WorkerEnvironment,
    key: string,
    value: string,
    opts?: KVNamespacePutOptions
  ): Promise<void>;
  /** Remove a key (no-op if absent). */
  delete(env: WorkerEnvironment, key: string): Promise<void>;
  /** List keys, optionally filtered/paginated. */
  list(
    env: WorkerEnvironment,
    opts?: KVNamespaceListOptions
  ): Promise<KVNamespaceListResult<unknown, string>>;
  /** This plugin's own deploy metadata, read by the deploy plugin. */
  deployManifest(): { kind: "kv"; binding: string };
};

const defaultConfig: Config = {
  binding: "KV"
};

/** THIS plugin's own config first; empty state = Record<string, never>. */
type Context = PluginCtx<Config, Record<string, never>, WorkerEvents>;

/**
 * Builds the app.kv.* api. Resolves the KV namespace off the request env per call.
 *
 * @param _ctx - The kv plugin context (unused in skeleton).
 * @example
 * ```ts
 * const api = createKvApi(ctx);
 * ```
 */
const createKvApi = (_ctx: Context): KvApi => {
  throw new Error("not implemented");
};

/**
 * Micro tier — thin env-first wrapper over a Cloudflare KV namespace.
 *
 * @see README.md
 */
export const kvPlugin = createPlugin("kv", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createKvApi
});
