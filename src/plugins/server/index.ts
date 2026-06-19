/**
 * server — Standard tier plugin.
 *
 * HTTP routing + request/scheduled dispatch + the Worker-entry surface for
 * `@moku-labs/worker`. Compiles a declarative `Endpoint` list into a
 * specificity-sorted matcher table (`state.match`) with method `ALL` support
 * and `{name}`/`{name:?}` path params. Emits global `request:start`/`request:end`
 * and per-plugin `server:matched`. Re-exports the pure `endpoint()` builder.
 *
 * `depends: [bindingsPlugin]` ensures bindings is resolved first; endpoint
 * handlers can then cross-reach other plugins via `ctx.require` threaded
 * through each `RequestContext` (spec/08 §7).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createServerApi } from "./api";
import { endpoint } from "./helpers";
import { compileServerState, createServerState } from "./state";
import type { ServerConfig, ServerEvents } from "./types";

/** Typed config default — no inline `as` cast (R6; spec/11 §Part 2). */
const defaultConfig: ServerConfig = { endpoints: [] };

/**
 * Standard tier — HTTP routing + request/scheduled dispatch over a compiled
 * endpoint table. Emits `server:matched` (per-plugin) plus global
 * `request:start` / `request:end` declared in `WorkerEvents`.
 *
 * @see README.md
 */
export const serverPlugin = createPlugin("server", {
  // events FIRST so ServerEvents infers into ctx for type-safe emit (spec/15 §5)
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural event-register callback
  events: register =>
    register.map<ServerEvents>({ "server:matched": "An endpoint matched a request" }),
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural state wiring
  createState: ({ config }) => createServerState(config.endpoints),
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createServerApi(ctx),
  // onInit: one-time sort + validation (justified; compileServerState does the work)
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural wiring; logic in state.ts
  onInit: ctx => {
    compileServerState(ctx.state);
  },
  helpers: { endpoint }
});

export { endpoint } from "./helpers";
export type { Endpoint, EndpointHandler, RequestContext } from "./types";
