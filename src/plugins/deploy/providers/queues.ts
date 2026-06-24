/**
 * @file deploy plugin — Queues provisioning adapter.
 *
 * Creates one Cloudflare Queue via `wrangler queues create <name>` per queue instance.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler, runWranglerYes } from "../runner";
import type { ResourceManifest } from "../types";

/** A queue resource descriptor. */
type QueueManifest = Extract<ResourceManifest, { kind: "queue" }>;

/**
 * Delete a queue via `wrangler queues delete <name>` (auto-answering the prompt — the verb has no
 * `-y` flag). The name is the stage-qualified queue name. Deleting the Worker first removes its
 * consumer binding, so by teardown order the queue has no attached consumer when this runs.
 *
 * @param name - The stage-qualified queue name (e.g. "tracker-activity-dev").
 * @returns Resolves once wrangler reports the queue deleted.
 * @throws {Error} When wrangler exits non-zero (e.g. the queue no longer exists).
 * @example
 * ```ts
 * await deleteQueue("tracker-activity-dev");
 * ```
 */
export const deleteQueue = async (name: string): Promise<void> => {
  await runWranglerYes(["queues", "delete", name]);
};

/**
 * Detach a Worker as a consumer of a queue via `wrangler queues consumer remove <queue> <script>`.
 * Teardown runs this BEFORE deleting the Worker to break the queue↔Worker cycle: Cloudflare refuses
 * to delete a Worker while it is a queue consumer, and refuses to delete a queue while a Worker still
 * binds it — so the consumer is detached first, then the Worker delete clears the producer binding,
 * then the queue can be deleted. No confirmation prompt (it removes a binding, not data).
 *
 * @param queue - The stage-qualified queue name (e.g. "atlas-activity-dev").
 * @param script - The consumer Worker (script) name (e.g. "atlas-dev").
 * @returns Resolves once the consumer is detached.
 * @throws {Error} When wrangler exits non-zero — notably when the Worker is not a consumer of the queue.
 * @example
 * ```ts
 * await detachQueueConsumer("atlas-activity-dev", "atlas-dev");
 * ```
 */
export const detachQueueConsumer = async (queue: string, script: string): Promise<void> => {
  await runWrangler(["queues", "consumer", "remove", queue, script]);
};

/**
 * Provision the queue via `wrangler queues create <name>`.
 *
 * @param manifest - The queue resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns Resolves once the queue is created.
 * @example
 * ```ts
 * await provisionQueue({ kind: "queue", name: "tracker-activity", binding: "ACTIVITY" }, false);
 * ```
 */
export const provisionQueue = async (manifest: QueueManifest, _ci: boolean): Promise<void> => {
  await runWrangler(["queues", "create", manifest.name]);
};
