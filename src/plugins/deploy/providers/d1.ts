/**
 * @file deploy plugin — D1 provisioning adapter skeleton.
 */
import type { ResourceManifest } from "../types";

/** A D1 resource descriptor. */
type D1Manifest = Extract<ResourceManifest, { kind: "d1" }>;

/**
 * Provision a D1 database via `wrangler d1 create` and apply migrations.
 *
 * @param _manifest - The D1 resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionD1({ kind: "d1", binding: "DB" }, false);
 * ```
 */
export function provisionD1(_manifest: D1Manifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
