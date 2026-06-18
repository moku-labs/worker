/**
 * @file bindings api — the stateless `require`/`has` resolver over a request-supplied env.
 */
import type { WorkerEnv as WorkerEnvironment } from "../../config";
import type { BindingsApi, Context } from "./types";

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
