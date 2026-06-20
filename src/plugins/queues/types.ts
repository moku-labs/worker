/**
 * @file queues plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import type { BindingsApi, bindingsPlugin } from "../bindings";

/**
 * A single Cloudflare Queue instance: its base CF queue name, the producer env binding it
 * resolves off, and an optional per-instance consumer handler.
 *
 * @example
 * ```ts
 * { name: "tracker-activity", binding: "ACTIVITY", onMessage: async (m, env) => {} }
 * ```
 */
export type QueueInstance = {
  /** Base Cloudflare queue name (stage-suffixed at deploy, e.g. `tracker-activity-dev`). */
  name: string;
  /** Producer env binding the Queue resolves off the per-request `env` (e.g. `env.ACTIVITY`). */
  binding: string;
  /** Per-instance consumer handler — awaited once per message in `consume()`. Optional → no-op. */
  onMessage?: (message: Message, env: WorkerEnv) => Promise<void>;
  /** Marks this instance the default when more than one is configured. */
  default?: boolean;
};

/**
 * queues plugin config — a keyed map of Queue instances. The key is the stable logical id used by
 * `app.queues.use("key")`; a single entry (or one flagged `default: true`) is the implicit default.
 *
 * @example
 * ```ts
 * { activity: { name: "tracker-activity", binding: "ACTIVITY", onMessage: async () => {} } }
 * ```
 */
export type Config = Record<string, QueueInstance>;

/** Per-plugin event map for queues. */
export type QueueEvents = { "queue:message": { queue: string; messageId: string } };

/**
 * The producer surface for one Queue instance (the send methods bound to a single instance).
 *
 * @example
 * ```ts
 * await app.queues.use("activity").send(env, { userId: "u1" });
 * ```
 */
export type QueueProducerApi = {
  /**
   * Enqueue a single message onto this instance's queue.
   *
   * @param env - Per-request Cloudflare bindings object.
   * @param body - Message body to enqueue.
   * @returns Resolves once the message is enqueued.
   */
  send(env: WorkerEnv, body: unknown): Promise<void>;
  /**
   * Enqueue many messages onto this instance's queue; each element becomes one message.
   *
   * @param env - Per-request Cloudflare bindings object.
   * @param bodies - Array of message bodies; each becomes one message.
   * @returns Resolves once all messages are enqueued.
   */
  sendBatch(env: WorkerEnv, bodies: unknown[]): Promise<void>;
};

/**
 * The app.queues surface — the default instance's producer methods, a `use(key)` selector for the
 * others, the consumer dispatch entry, plus deploy metadata.
 *
 * @example
 * ```ts
 * await app.queues.send(env, { orderId: "1" });          // default instance
 * await app.queues.use("activity").send(env, { id: 2 }); // a named instance
 * ```
 */
export type Api = QueueProducerApi & {
  /**
   * Select a specific Queue instance by its config key.
   *
   * @param key - The instance key (as configured under `pluginConfigs.queues`).
   * @returns The producer surface bound to that instance.
   */
  use(key: string): QueueProducerApi;
  /**
   * Consumer dispatch — the Worker's `queue()` export delegates here. Routes the batch to the
   * matching instance's `onMessage` (by config key map / CF queue name).
   *
   * @param batch - The incoming message batch.
   * @param env - Per-request Cloudflare bindings.
   * @param ctx - waitUntil / passThroughOnException.
   * @returns Resolves after all messages settle.
   */
  consume(batch: MessageBatch, env: WorkerEnv, ctx: ExecutionContext): Promise<void>;
  /**
   * Return this plugin's deploy metadata (one entry per configured instance), read by the deploy
   * plugin. Build-time only — takes no env.
   *
   * @returns One queue deploy descriptor per configured instance.
   */
  deployManifest(): Array<{ kind: "queue"; name: string; binding: string }>;
};

/**
 * Internal context type — own config first, no state, merged queue events.
 *
 * `PluginCtx` exposes only `config`/`state`/`emit`; `require` is composed in here
 * (core's "advanced composition" note), typed to the one dependency queues resolves —
 * `require(bindingsPlugin)` → `BindingsApi`. Core does not export `RequireFunction`.
 */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents & QueueEvents> & {
  /**
   * Resolve a dependency plugin's api. queues only ever resolves `bindingsPlugin`.
   *
   * @param plugin - The bindings plugin instance.
   * @returns The resolved bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};
