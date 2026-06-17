/**
 * @file bindings — Micro-tier plugin skeleton. Stateless resolver over a request-supplied env.
 * @see README.md
 */

import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv as WorkerEnvironment, WorkerEvents } from "../../config";
import { createPlugin } from "../../config";

/**
 * bindings config. Flat; complete default so omission never yields undefined (spec/05 §6).
 */
type Config = {
  /** Binding names asserted present on the request env. Default: [] (assert nothing). */
  required: string[];
};

/** The app.bindings surface — a stateless resolver over a request-supplied env. */
export type BindingsApi = {
  /** Resolve binding `name` off the request env, narrowed to T, or throw [moku-worker]. */
  require<T>(env: WorkerEnvironment, name: string): T;
  /** True when `name` resolves to a non-nullish value on the request env. Never throws. */
  has(env: WorkerEnvironment, name: string): boolean;
};

const defaultConfig: Config = {
  required: []
};

/** api-factory context. State slot is Record<string, never> — bindings holds NO state (F4). */
type Context = PluginCtx<Config, Record<string, never>, WorkerEvents>;

/**
 * Builds the app.bindings api. Resolves bindings off a request-supplied env (never stored).
 *
 * @param _ctx - The bindings plugin context (unused in skeleton).
 * @example
 * ```ts
 * const api = createBindingsApi(ctx);
 * ```
 */
const createBindingsApi = (_ctx: Context): BindingsApi => {
  throw new Error("not implemented");
};

/**
 * Micro tier — stateless resolver over a request-supplied env; the binding-family dependency root.
 *
 * @see README.md
 */
export const bindingsPlugin = createPlugin("bindings", {
  config: defaultConfig,
  api: createBindingsApi
});
