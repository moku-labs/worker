/**
 * Standard tier — Cloudflare Durable Objects stub accessor + `defineDurableObject` helper.
 *
 * Runtime: `app.durableObjects.get(env, logicalName, idName)` resolves a
 * `DurableObjectNamespace` off the per-request `env` (mapping a logical name to a
 * Cloudflare binding name via `config.bindings`), derives a stable id with
 * `idFromName(idName)`, and returns the addressed `DurableObjectStub`.
 *
 * Build: `app.durableObjects.deployManifest()` returns this plugin's own deploy metadata
 * `{ kind: "do", bindings }` — read by the `deploy` plugin via `ctx.require(durableObjectsPlugin)`.
 *
 * Helper: `defineDurableObject(name)` is a PURE helper (spec/03 §1) that returns a base
 * class the consumer `extends` and exports from `worker.ts`. This is SPEC BOUNDARY #1
 * (design §9): a Moku plugin produces values/APIs, never a top-level exported class.
 *
 * REGULAR plugin (not core): it `depends: [bindingsPlugin]` and calls
 * `ctx.require(bindingsPlugin)` to resolve namespaces off the request env — which a core
 * plugin cannot do (F4; spec/02 §6). Declares no per-plugin events. No lifecycle hooks
 * (request-scoped; spec/06 §3).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createDoApi } from "./api";
import { defineDurableObject } from "./helpers";
import type { Config } from "./types";

/** Complete default config — typed const, not an inline `as` assertion (R6; spec/11 Part 2). */
const defaultConfig: Config = { bindings: {} };

/**
 * Cloudflare Durable Objects plugin — Standard tier.
 *
 * Exposes `get(env, logicalName, idName)` (synchronous stub accessor, threaded env) and
 * `deployManifest()` (build-time metadata). Depends on `bindingsPlugin` for namespace
 * resolution. The `defineDurableObject` helper is mounted under `helpers` and re-exported
 * at the top level for consumer use.
 *
 * @example
 * ```typescript
 * // Consumer endpoint handler:
 * const stub = app.durableObjects.get(env, "counter", params.room!);
 * const res = await stub.fetch("https://do/increment");
 * // Consumer DO class:
 * export class Counter extends defineDurableObject("Counter") {
 *   async fetch(): Promise<Response> { return new Response("ok"); }
 * }
 * ```
 * @see README.md
 */
export const durableObjectsPlugin = createPlugin("durableObjects", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createDoApi,
  helpers: { defineDurableObject }
});

export { defineDurableObject } from "./helpers";
export type { Config } from "./types";
