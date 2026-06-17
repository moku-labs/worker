/**
 * @file deploy plugin — KV provisioning adapter.
 *
 * Creates a Cloudflare KV namespace via `wrangler kv namespace create <binding>`.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ResourceManifest } from "../types";

/** A KV resource descriptor. */
type KvManifest = Extract<ResourceManifest, { kind: "kv" }>;

/**
 * Provision a KV namespace via `wrangler kv namespace create`.
 *
 * @param manifest - The KV resource descriptor.
 * @param _ci - Whether running non-interactively (passed through; wrangler respects env vars).
 * @returns Resolves once the namespace is created.
 * @example
 * ```ts
 * await provisionKv({ kind: "kv", binding: "CACHE" }, false);
 * ```
 */
export const provisionKv = async (manifest: KvManifest, _ci: boolean): Promise<void> => {
  await runWrangler(["kv", "namespace", "create", manifest.binding]);
};
