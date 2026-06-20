/**
 * @file queues plugin — API factory (send, sendBatch, use, consume, deployManifest).
 *
 * Producer methods take the per-request `env` as the first argument and resolve the `Queue` via
 * `ctx.require(bindingsPlugin).require<Queue>(env, binding)` — the `env` is never stored (SB4 /
 * design §1a), resolved fresh on every call, and the instance binding is resolved lazily so an
 * unconfigured-but-present plugin only errors when actually called.
 *
 * Consumer dispatch (`consume`) routes the incoming batch to the matching instance's `onMessage`.
 */
import type { WorkerEnv } from "../../config";
import { defaultInstanceKey, pickInstance } from "../../instances";
import { bindingsPlugin } from "../bindings";
import type { Api, Config, Ctx, QueueInstance, QueueProducerApi } from "./types";

/**
 * Resolve the instance a consumed batch belongs to. With a single instance, that instance always
 * matches. With several, match the instance whose `name` equals `batch.queue` OR whose stage-suffixed
 * form (`${name}-`) prefixes it (tolerant of the deploy stage suffix, e.g. `tracker-activity-dev`);
 * fall back to the default instance when nothing matches.
 *
 * @param config - The keyed-map queues config.
 * @param queueName - The CF queue name from `batch.queue`.
 * @returns The matched `QueueInstance` (its `onMessage` is what `consume` awaits).
 * @example
 * ```ts
 * routeInstance(cfg, "tracker-activity-dev"); // → the `activity` instance
 * ```
 */
const routeInstance = (config: Config, queueName: string): QueueInstance => {
  const keys = Object.keys(config);
  if (keys.length === 1) {
    return pickInstance(config, keys[0] as string, "queues");
  }

  const matched = Object.values(config).find(
    instance => instance.name === queueName || queueName.startsWith(`${instance.name}-`)
  );
  return matched ?? pickInstance(config, defaultInstanceKey(config, "queues"), "queues");
};

/**
 * Builds app.queues.* over a keyed map of Queue instances — read by worker.ts queue() delegation
 * (design §1d; spec/02 §7). The default-instance producer methods and `use(key)` both resolve the
 * Queue off the REQUEST-SUPPLIED env on every call (env is threaded, never stored — SB4); the
 * instance key is resolved lazily. Emits `queue:message` for observability after each consumed
 * message (F8).
 *
 * @param ctx - Plugin context (keyed-map config + require + emit).
 * @returns The queues API surface: send, sendBatch, use, consume, deployManifest.
 * @example
 * ```ts
 * const api = createQueuesApi(ctx);
 * await api.send(env, { orderId: "1" });            // default instance
 * await api.use("activity").send(env, { id: 2 });   // a named instance
 * // Worker entry (design §1d): queue: (b, e, c) => app.queues.consume(b, e, c)
 * ```
 */
export const createQueuesApi = (ctx: Ctx): Api => {
  const bindings = ctx.require(bindingsPlugin);

  // The send/sendBatch surface bound to one instance, resolved lazily by binding-getter so the
  // default key (and a `use(key)` lookup) is resolved at call time, not at createApp time.
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const surface = (binding: () => string): QueueProducerApi => {
    // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
    const queue = (env: WorkerEnv): Queue => bindings.require<Queue>(env, binding());
    return {
      /**
       * Enqueue a single message onto this instance's queue.
       *
       * @param env - The per-request Cloudflare env.
       * @param body - The message body to enqueue.
       * @returns Resolves once the message is enqueued.
       * @example
       * ```typescript
       * await api.send(env, { userId: "u1" });
       * ```
       */
      send: async (env, body) => {
        await queue(env).send(body);
      },
      /**
       * Enqueue many messages onto this instance's queue; each element becomes one message.
       *
       * @param env - The per-request Cloudflare env.
       * @param bodies - Array of message bodies; each becomes one message.
       * @returns Resolves once all messages are enqueued.
       * @example
       * ```typescript
       * await api.sendBatch(env, [{ id: 1 }, { id: 2 }]);
       * ```
       */
      sendBatch: async (env, bodies) => {
        await queue(env).sendBatch(bodies.map(body => ({ body })));
      }
    };
  };

  // The default instance's binding, resolved lazily (errors only when actually called).
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const defaultBinding = (): string =>
    pickInstance(ctx.config, defaultInstanceKey(ctx.config, "queues"), "queues").binding;

  return {
    ...surface(defaultBinding),
    /**
     * Select a specific Queue instance by its config key.
     *
     * @param key - The instance key (as configured under `pluginConfigs.queues`).
     * @returns The producer surface bound to that instance.
     * @example
     * ```typescript
     * await api.use("activity").send(env, { id: 2 });
     * ```
     */
    use: (key: string) => surface(() => pickInstance(ctx.config, key, "queues").binding),
    /**
     * Consumer dispatch — the Worker's `queue()` export delegates here. Routes the batch to the
     * matching instance's `onMessage` and emits `queue:message` per message.
     *
     * @param batch - The incoming message batch.
     * @param env - The per-request Cloudflare env.
     * @param _ctx - The execution context (waitUntil / passThroughOnException); unused.
     * @returns Resolves after all messages settle.
     * @example
     * ```typescript
     * // Worker entry (design §1d): queue: (b, e, c) => app.queues.consume(b, e, c)
     * ```
     */
    consume: async (batch, env, _ctx): Promise<void> => {
      const instance = routeInstance(ctx.config, batch.queue);
      for (const m of batch.messages) {
        if (instance.onMessage) {
          await instance.onMessage(m, env);
        }
        ctx.emit("queue:message", { queue: batch.queue, messageId: m.id });
      }
    },
    /**
     * Return this plugin's deploy metadata — one descriptor per configured instance.
     *
     * @returns One queue deploy descriptor per instance.
     * @example
     * ```typescript
     * const manifest = api.deployManifest(); // [{ kind: "queue", name: "tracker-activity", binding: "ACTIVITY" }]
     * ```
     */
    deployManifest: () =>
      Object.values(ctx.config).map(instance => ({
        kind: "queue" as const,
        name: instance.name,
        binding: instance.binding,
        // A queue that declares an onMessage handler is also CONSUMED by this Worker — flag it so the
        // deploy plugin writes a wrangler `consumers` entry (without it, messages are never delivered).
        ...(instance.onMessage ? { consumer: true } : {})
      }))
  };
};
