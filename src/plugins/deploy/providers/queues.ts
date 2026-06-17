/**
 * @file deploy plugin — Queues provisioning adapter.
 *
 * Creates Cloudflare Queues via `wrangler queues create <name>` for each producer.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ResourceManifest } from "../types";

/** A queue resource descriptor. */
type QueueManifest = Extract<ResourceManifest, { kind: "queue" }>;

/**
 * Provision queues via `wrangler queues create` for each declared producer.
 *
 * @param manifest - The queue resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns Resolves once all queues are created.
 * @example
 * ```ts
 * await provisionQueue({ kind: "queue", producers: ["orders"] }, false);
 * ```
 */
export const provisionQueue = async (manifest: QueueManifest, _ci: boolean): Promise<void> => {
  for (const producer of manifest.producers) {
    await runWrangler(["queues", "create", producer]);
  }
};
