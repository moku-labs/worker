/**
 * @file server — Standard tier plugin skeleton. HTTP routing + request/scheduled dispatch.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createServerApi } from "./api";
import { endpoint } from "./helpers";
import { createServerState } from "./state";
import type { ServerConfig, ServerEvents } from "./types";

const defaultConfig: ServerConfig = { endpoints: [] };

/**
 * Standard tier — HTTP routing + request/scheduled dispatch over a compiled endpoint table.
 *
 * `events` is declared first and via `register.map<ServerEvents>` so the plugin's own events
 * infer into the factory context; the api/createState/onInit wiring is therefore arrow-wrapped
 * (contextually typed) rather than a bare reference. See README.md.
 *
 * @see README.md
 */
export const serverPlugin = createPlugin("server", {
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural event-register callback
  events: register =>
    register.map<ServerEvents>({
      "server:matched": "An endpoint matched a request"
    }),
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural state wiring (arg transform)
  createState: ({ config }) => createServerState(config.endpoints),
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createServerApi(ctx),
  // eslint-disable-next-line jsdoc/require-jsdoc -- empty onInit; endpoint table compiled at build
  onInit: _ctx => {
    // Compiled at build — sorts/validates the endpoint table.
  },
  helpers: { endpoint }
});

export { endpoint } from "./helpers";
export type { Endpoint, EndpointHandler, RequestContext } from "./types";
