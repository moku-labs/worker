/**
 * @file deploy plugin — KV provisioning adapter skeleton.
 */
import type { ResourceManifest } from "../types";

/** A KV resource descriptor. */
type KvManifest = Extract<ResourceManifest, { kind: "kv" }>;

/**
 * Provision a KV namespace via `wrangler kv namespace create`.
 *
 * @param _manifest - The KV resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionKv({ kind: "kv", binding: "CACHE" }, false);
 * ```
 */
export function provisionKv(_manifest: KvManifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
