/**
 * @file deploy plugin — Queues provisioning adapter.
 *
 * Creates one Cloudflare Queue via `wrangler queues create <name>` per queue instance.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ResourceManifest } from "../types";

/** A queue resource descriptor. */
type QueueManifest = Extract<ResourceManifest, { kind: "queue" }>;

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
