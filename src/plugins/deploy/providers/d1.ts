/**
 * @file deploy plugin — D1 provisioning adapter.
 *
 * Creates a Cloudflare D1 database via `wrangler d1 create <binding>`.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ResourceManifest } from "../types";

/** A D1 resource descriptor. */
type D1Manifest = Extract<ResourceManifest, { kind: "d1" }>;

/**
 * Provision a D1 database via `wrangler d1 create` and apply migrations.
 *
 * @param manifest - The D1 resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns Resolves once the database is created (and migrations applied when specified).
 * @example
 * ```ts
 * await provisionD1({ kind: "d1", binding: "DB", migrations: "./migrations" }, false);
 * ```
 */
export const provisionD1 = async (manifest: D1Manifest, _ci: boolean): Promise<void> => {
  await runWrangler(["d1", "create", manifest.binding]);

  if (manifest.migrations) {
    await runWrangler(["d1", "migrations", "apply", manifest.binding, "--local"]);
  }
};
