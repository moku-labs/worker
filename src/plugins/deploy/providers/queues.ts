/**
 * @file deploy plugin — Queues provisioning adapter skeleton.
 */
import type { ResourceManifest } from "../types";

/** A queue resource descriptor. */
type QueueManifest = Extract<ResourceManifest, { kind: "queue" }>;

/**
 * Provision queues via `wrangler queues create`.
 *
 * @param _manifest - The queue resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionQueue({ kind: "queue", producers: ["orders"] }, false);
 * ```
 */
export function provisionQueue(_manifest: QueueManifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
