/**
 * @file queues plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";

/**
 * queues plugin configuration. Flat; complete defaults so omission never yields undefined.
 */
export type Config = {
  /** Queue names this Worker produces to; surfaced by deployManifest(). Default []. */
  producers: string[];
  /** Declarative consumer handler — awaited once per message in consume(). Default no-op. */
  onMessage: (message: Message, env: WorkerEnv) => Promise<void>;
};

/**
 * Deploy metadata entry for a queue, read by the deploy plugin.
 *
 * @example
 * ```ts
 * { kind: "queue", producers: ["orders"] }
 * ```
 */
export type DeployManifest = {
  /** Discriminant identifying this as a queue resource. */
  kind: "queue";
  /** Queue names produced to. */
  producers: string[];
};

/** Per-plugin event map for queues. */
export type QueueEvents = { "queue:message": { queue: string; messageId: string } };

/** Public api surface of the queues plugin (producer + consumer). */
export type Api = {
  /**
   * Enqueue a single message onto the named queue.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param queue - Target queue binding name.
   * @param body - Message body.
   * @returns Resolves once enqueued.
   */
  send(env: WorkerEnv, queue: string, body: unknown): Promise<void>;
  /**
   * Enqueue many messages; each element becomes one message.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param queue - Target queue binding name.
   * @param bodies - Message bodies.
   * @returns Resolves once enqueued.
   */
  sendBatch(env: WorkerEnv, queue: string, bodies: unknown[]): Promise<void>;
  /**
   * Consumer dispatch — the Worker's queue() export delegates here.
   *
   * @param batch - The incoming message batch.
   * @param env - Per-request Cloudflare bindings.
   * @param exec - waitUntil / passThroughOnException.
   * @returns Resolves after all messages settle.
   */
  consume(batch: MessageBatch, env: WorkerEnv, exec: ExecutionContext): Promise<void>;
  /**
   * Return this plugin's deploy metadata (read by the deploy plugin).
   *
   * @returns Deploy manifest entry `{ kind: "queue", producers }`.
   */
  deployManifest(): DeployManifest;
};

/** Internal context type — own config first, no state, merged queue events. */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents & QueueEvents>;
