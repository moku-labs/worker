/**
 * bindings — Standard tier, REGULAR plugin.
 *
 * Stateless resolver over a REQUEST-SUPPLIED env (never stored — F4 / design §1b).
 * Regular (not core) so downstream binding plugins can depends:[bindingsPlugin] and
 * ctx.require(bindingsPlugin) — core plugins cannot be require/depends targets
 * (spec/02 §6; spec/03 §5).
 *
 * No state, no events, no hooks, no onInit/onStart/onStop (request-scoped;
 * design §1a; spec/06 §3). Domain logic lives in api.ts; shared types in types.ts.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { createBindingsApi } from "./api";
import type { Config } from "./types";

export type { BindingsApi, Config, Context } from "./types";

/** Typed config default — no inline `as` cast (R6 / spec/11 §Part 2). */
const defaultConfig: Config = { required: [] };

/**
 * Standard-tier stateless resolver — the binding-family dependency root.
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
