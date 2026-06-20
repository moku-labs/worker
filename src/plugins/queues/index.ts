/**
 * @file queues — Standard tier plugin skeleton. Cloudflare Queues producer + per-instance consumer.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createQueuesApi } from "./api";
import type { Config, QueueEvents } from "./types";

export type { Api, Config, QueueInstance, QueueProducerApi } from "./types";

/** Typed default — empty keyed map; the consumer declares instances under `pluginConfigs.queues`. */
const defaultConfig: Config = {};

/**
 * Standard tier — Cloudflare Queues producer + per-instance consumer dispatch over a keyed map of
 * instances.
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
