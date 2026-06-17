/**
 * @file deploy plugin — provider dispatch skeleton (kind -> provision*).
 */
import type { ResourceManifest } from "../types";

/**
 * Dispatch a resource descriptor to the matching provider's provisioning routine.
 *
 * @param _resource - The resource descriptor to provision.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionResource({ kind: "kv", binding: "CACHE" }, false);
 * ```
 */
export function provisionResource(_resource: ResourceManifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
