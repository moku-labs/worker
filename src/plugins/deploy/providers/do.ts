/**
 * @file deploy plugin — Durable Objects provisioning adapter.
 *
 * Durable Objects are declared in the wrangler config (via wrangler-config.ts) rather
 * than created via a dedicated `wrangler do create` command. This adapter is a no-op at
 * the provisioning step; the DO bindings are written into the wrangler.jsonc file by
 * writeWranglerConfig. Kept as a named export so provisionResource can dispatch to it.
 * Node-only; never imported by the runtime Worker bundle.
 */
import type { ResourceManifest } from "../types";

/** A Durable Objects resource descriptor. */
type DoManifest = Extract<ResourceManifest, { kind: "do" }>;

/**
 * Provision Durable Object bindings. DOs are config-driven (no `wrangler do create` command
 * exists) — the actual binding entries are written by writeWranglerConfig. This function is
 * a resolved no-op for the dispatch step.
 *
 * @param _manifest - The Durable Objects resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns Resolves immediately (DOs are config-only provisioning).
 * @example
 * ```ts
 * await provisionDurableObject({ kind: "do", bindings: { counter: "COUNTER" } }, false);
 * ```
 */
export const provisionDurableObject = async (
  _manifest: DoManifest,
  _ci: boolean
): Promise<void> => {
  // Durable Objects are declared in wrangler config — no wrangler CLI create command needed.
};
