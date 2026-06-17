/**
 * @file deploy plugin — Durable Objects provisioning adapter skeleton.
 */
import type { ResourceManifest } from "../types";

/** A Durable Objects resource descriptor. */
type DoManifest = Extract<ResourceManifest, { kind: "do" }>;

/**
 * Provision Durable Object bindings + migrations in the wrangler config.
 *
 * @param _manifest - The Durable Objects resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionDurableObject({ kind: "do", bindings: { counter: "COUNTER" } }, false);
 * ```
 */
export function provisionDurableObject(_manifest: DoManifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
