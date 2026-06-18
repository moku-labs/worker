/**
 * @file queues — Standard tier plugin skeleton. Cloudflare Queues producer + consumer.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createQueuesApi } from "./api";
import type { Config, QueueEvents } from "./types";

const defaultConfig: Config = {
  producers: [],
  // eslint-disable-next-line jsdoc/require-jsdoc -- default no-op consumer handler
  onMessage: async () => {}
};

/**
 * Standard tier — Cloudflare Queues producer + consumer dispatch.
 *
 * `events` is declared first and via `register.map<QueueEvents>` so the plugin's own events infer
 * into the factory context; the api wiring is therefore arrow-wrapped (contextually typed).
 *
 * Emits the plugin-local `queue:message` event after each consumed message.
 *
 * @see README.md
 */
export const queuesPlugin = createPlugin("queues", {
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural event-register callback
  events: register =>
    register.map<QueueEvents>({
      "queue:message": "A queue message was processed"
    }),
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createQueuesApi(ctx)
});

export type { Config } from "./types";
