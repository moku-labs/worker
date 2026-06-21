/**
 * @file bindings types — Config, the `app.bindings` API surface, and the api-factory context.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";

/**
 * bindings config. Flat (spec/05 §3,§6) — a complete default so omission
 * never yields undefined.
 *
 * @example
 * ```typescript
 * { required: ["MY_KV", "DB"] }
 * ```
 */
export type Config = { required: string[] };

/**
 * The app.bindings surface — a stateless resolver over a request-supplied env.
 *
 * @example
 * ```typescript
 * const kv = app.bindings.require<KVNamespace>(env, "MY_KV");
 * const ok = app.bindings.has(env, "DB");
 * ```
 */
export type BindingsApi = {
  /**
   * Resolve binding `name` off the request-supplied env, narrowed to T.
   *
   * @param env - The Cloudflare request env object.
   * @param name - The binding name to resolve.
   * @returns The binding value narrowed to T.
   * @throws {Error} With a `[worker]` prefix when the binding is nullish.
   */
  require<T>(env: WorkerEnvironment, name: string): T;

  /**
   * True when `name` resolves to a non-nullish value on the request-supplied env.
   *
   * @param env - The Cloudflare request env object.
   * @param name - The binding name to check.
   * @returns Whether the binding is present and non-nullish.
   */
  has(env: WorkerEnvironment, name: string): boolean;
};

/**
 * api-factory context. State slot is Record<string, never> — bindings holds NO
 * state (F4). Type-argument order is PluginCtx<Config, State, Events>.
 */
export type Context = PluginCtx<Config, Record<string, never>, WorkerEvents>;
