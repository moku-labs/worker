/**
 * bindings — Micro tier, REGULAR plugin.
 *
 * Stateless resolver over a REQUEST-SUPPLIED env (never stored — F4 / design §1b).
 * Regular (not core) so downstream binding plugins can depends:[bindingsPlugin] and
 * ctx.require(bindingsPlugin) — core plugins cannot be require/depends targets
 * (spec/02 §6; spec/03 §5).
 *
 * No state, no events, no hooks, no onInit/onStart/onStop (request-scoped;
 * design §1a; spec/06 §3).
 *
 * @see README.md
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";
import { createPlugin } from "../../config";

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
   * @throws {Error} With a `[moku-worker]` prefix when the binding is nullish.
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

/**
 * Checks whether a value read from an env object is nullish (null or undefined).
 * Cloudflare supplies either form when a binding is absent, so both must be caught.
 *
 * @param value - The value read from the env object.
 * @returns True when the value is null or undefined.
 * @example
 * ```typescript
 * isNullish(undefined); // true
 * isNullish(0);         // false — falsy but bound
 * ```
 */
const isNullish = (value: unknown): value is null | undefined =>
  value === undefined || value === null;

/**
 * Resolves binding `name` off a request-supplied env object, narrowed to T.
 * Throws a `[moku-worker]`-prefixed error when the binding is nullish.
 * The env argument is read but never retained.
 *
 * @param env - The Cloudflare request env object passed to fetch/scheduled/queue.
 * @param name - The binding name to resolve.
 * @returns The binding value narrowed to T.
 * @throws {Error} With a `[moku-worker]` prefix when the binding is null or undefined.
 * @example
 * ```typescript
 * const kv = requireBinding<KVNamespace>(env, "MY_KV");
 * ```
 */
const requireBinding = <T>(env: WorkerEnvironment, name: string): T => {
  const value = env[name];
  if (isNullish(value)) {
    throw new Error(
      `[moku-worker] binding "${name}" is not bound.\n` +
        `  Declare it in wrangler config and pass it in via the request env.`
    );
  }
  return value as T;
};

/**
 * Returns true when `name` resolves to a non-nullish value on the request env.
 * Never throws. Use for optional-binding branching without forcing an error.
 *
 * @param env - The Cloudflare request env object passed to fetch/scheduled/queue.
 * @param name - The binding name to check.
 * @returns Whether the binding is present and non-nullish.
 * @example
 * ```typescript
 * const ok = hasBinding(env, "DB"); // false if DB is not bound
 * ```
 */
const hasBinding = (env: WorkerEnvironment, name: string): boolean => !isNullish(env[name]);

/**
 * Builds the app.bindings API surface. The factory receives a context but does
 * not use it — bindings holds no state (F4) and all resolution is argument-local.
 *
 * @param _ctx - Plugin context (unused; bindings is stateless — F4).
 * @returns BindingsApi with `require` and `has` methods.
 * @example
 * ```typescript
 * const api = createBindingsApi(ctx);
 * const kv = api.require<KVNamespace>(env, "MY_KV");
 * ```
 */
export const createBindingsApi = (_ctx: Context): BindingsApi => ({
  require: requireBinding,
  has: hasBinding
});

/** Typed config default — no inline `as` cast (R6 / spec/11 §Part 2). */
const defaultConfig: Config = { required: [] };

/**
 * Micro-tier stateless resolver — the binding-family dependency root.
 *
 * Exposes `require<T>(env, name)` and `has(env, name)` off a per-request env
 * object. Regular plugin so downstream binding plugins can declare
 * `depends: [bindingsPlugin]` and reach it via `ctx.require(bindingsPlugin)`.
 *
 * @see README.md
 */
export const bindingsPlugin = createPlugin("bindings", {
  config: defaultConfig,
  api: createBindingsApi
  // No createState (F4 — stateless). No depends/events/hooks. No onInit/onStart/onStop.
});
