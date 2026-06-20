/**
 * @file deploy plugin — D1 provisioning adapter.
 *
 * Creates a Cloudflare D1 database via `wrangler d1 create <binding>`, captures the created
 * database id from wrangler's output (so writeWranglerConfig can write a real `database_id`
 * instead of an empty placeholder), and applies migrations when declared.
 * Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ProvisionOutcome, ResourceManifest } from "../types";

/** A D1 resource descriptor. */
type D1Manifest = Extract<ResourceManifest, { kind: "d1" }>;

/**
 * Parse the created D1 database id from `wrangler d1 create` output.
 * Wrangler prints the new binding as JSON (`"database_id": "..."`) or TOML
 * (`database_id = "..."`); the leading boundary keeps the match anchored to the field name.
 *
 * @param output - Raw stdout from the wrangler create command.
 * @returns The database id, or undefined when none is found.
 * @example
 * ```ts
 * parseD1DatabaseId('{ "database_id": "uuid-1234" }'); // "uuid-1234"
 * ```
 */
export const parseD1DatabaseId = (output: string): string | undefined => {
  const match = /(?:^|[\s,{])"?database_id"?\s*[:=]\s*"([^"]+)"/m.exec(output);
  return match?.[1];
};

/**
 * Provision a D1 database via `wrangler d1 create`, capture its id, and apply migrations.
 *
 * @param manifest - The D1 resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns The captured database id when wrangler reported one, else an empty outcome.
 * @example
 * ```ts
 * const { id } = await provisionD1({ kind: "d1", binding: "DB", migrations: "./migrations" }, false);
 * ```
 */
export const provisionD1 = async (
  manifest: D1Manifest,
  _ci: boolean
): Promise<ProvisionOutcome> => {
  const output = await runWrangler(["d1", "create", manifest.binding]);
  const id = parseD1DatabaseId(output);

  if (manifest.migrations) {
    await runWrangler(["d1", "migrations", "apply", manifest.binding, "--local"]);
  }

  return id ? { id } : {};
};
