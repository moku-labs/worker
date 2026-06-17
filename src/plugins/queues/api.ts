/**
 * @file queues plugin — API factory skeleton (send, sendBatch, consume, deployManifest).
 */
import type { Api, Ctx } from "./types";

/**
 * Builds app.queues.* — read by worker.ts queue() delegation. Resolves Queue
 * bindings off the request env per call; emits queue:message per consumed message.
 *
 * @param _ctx - Plugin context (own config + require + emit).
 * @example
 * ```ts
 * const api = createQueuesApi(ctx);
 * ```
 */
export function createQueuesApi(_ctx: Ctx): Api {
  throw new Error("not implemented");
}
