/**
 * @file queues plugin — API factory (send, sendBatch, consume, deployManifest).
 *
 * All binding-resolving methods take the per-request `env` as the first argument
 * and resolve the `Queue` via `ctx.require(bindingsPlugin).require<Queue>(env, name)`.
 * The `env` is never stored (SB4 / design §1a) — resolved fresh on every call.
 */
import { bindingsPlugin } from "../bindings";
import type { Ctx } from "./types";

/**
 * Builds app.queues.* — read by worker.ts queue() delegation (design §1d; spec/02 §7).
 *
 * Resolves Queue bindings off the request env per call (never stored — SB4).
 * Emits `queue:message` for observability after each consumed message (F8).
 *
 * @param ctx - Plugin context (own config + require + emit).
 * @returns The queues API surface: send, sendBatch, consume, deployManifest.
 * @example
 * ```ts
 * // Worker entry (design §1d)
 * export default {
 *   queue: (b, e, c) => app.queues.consume(b, e, c),
 * };
 * ```
 */
export const createQueuesApi = (ctx: Ctx) => {
  /**
   * Resolves a named Queue binding from the per-request env.
   * Throws a [moku-worker]-prefixed error when the binding is absent.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param name - Queue binding name.
   * @returns The resolved Queue instance.
   * @example
   * ```ts
   * const q = queue(env, "ORDERS");
   * ```
   */
  const queue = (env: Parameters<typeof ctx.config.onMessage>[1], name: string): Queue =>
    ctx.require(bindingsPlugin).require<Queue>(env, name);

  return {
    /**
     * Enqueue a single message onto the named queue.
     *
     * Resolves the Queue binding fresh from `env` on every call (SB4).
     * Request/response work → api method, never emit (F8).
     *
     * @param env - Per-request Cloudflare bindings object.
     * @param q - Target queue binding name in `env`.
     * @param body - Message body to enqueue.
     * @returns Resolves once the message is enqueued.
     * @throws {Error} With a `[moku-worker]` prefix if the binding is missing.
     * @example
     * ```ts
     * await app.queues.send(env, "ORDERS", { orderId: "123" });
     * ```
     */
    send: async (
      env: Parameters<typeof ctx.config.onMessage>[1],
      q: string,
      body: unknown
    ): Promise<void> => {
      await queue(env, q).send(body);
    },

    /**
     * Enqueue many messages in one call; each element becomes one message.
     *
     * Maps each body to `{ body }` before calling `Queue.sendBatch` (design §4.3).
     *
     * @param env - Per-request Cloudflare bindings object.
     * @param q - Target queue binding name in `env`.
     * @param bodies - Array of message bodies; each becomes one message.
     * @returns Resolves once all messages are enqueued.
     * @throws {Error} With a `[moku-worker]` prefix if the binding is missing.
     * @example
     * ```ts
     * await app.queues.sendBatch(env, "ORDERS", orders);
     * ```
     */
    sendBatch: async (
      env: Parameters<typeof ctx.config.onMessage>[1],
      q: string,
      bodies: unknown[]
    ): Promise<void> => {
      await queue(env, q).sendBatch(bodies.map(body => ({ body })));
    },

    /**
     * Consumer dispatch — the Worker's `queue()` export delegates here.
     *
     * Iterates `batch.messages`, **awaits** `config.onMessage(message, env)` per message
     * (so Cloudflare gets a settled promise and the handler controls ack/retry; F8,
     * spec/07 §3 — never emit for awaited work), then fire-and-forget emits `queue:message`
     * for observability. Returns a promise the Worker **must** await so the isolate is not
     * killed mid-batch.
     *
     * @param batch - The incoming message batch from Cloudflare.
     * @param env - Per-request Cloudflare bindings object.
     * @param _exec - waitUntil / passThroughOnException (reserved for future use).
     * @returns Resolves after all messages in the batch are processed.
     * @throws {Error} Re-throws any error from `config.onMessage` so Cloudflare can retry.
     * @example
     * ```ts
     * // Worker entry
     * queue: (b, e, c) => app.queues.consume(b, e, c),
     * ```
     */
    consume: async (
      batch: MessageBatch,
      env: Parameters<typeof ctx.config.onMessage>[1],
      _exec: ExecutionContext
    ): Promise<void> => {
      for (const m of batch.messages) {
        await ctx.config.onMessage(m, env);
        ctx.emit("queue:message", { queue: batch.queue, messageId: m.id });
      }
    },

    /**
     * Returns this plugin's deploy metadata, read by the deploy plugin via
     * `ctx.require(queuesPlugin).deployManifest()` (F6 — never reads sibling config).
     *
     * @returns Deploy manifest entry `{ kind: "queue", producers }`.
     * @example
     * ```ts
     * const manifest = ctx.require(queuesPlugin).deployManifest();
     * // → { kind: "queue", producers: ["orders"] }
     * ```
     */
    deployManifest: (): { kind: "queue"; producers: string[] } => ({
      kind: "queue" as const,
      producers: ctx.config.producers
    })
  };
};
