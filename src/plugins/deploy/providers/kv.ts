/**
 * @file deploy plugin — KV provisioning adapter.
 *
 * Creates a Cloudflare KV namespace via `wrangler kv namespace create <binding>` and captures
 * the created namespace id from wrangler's output, so writeWranglerConfig can write a real `id`
 * (not an empty placeholder) into the generated wrangler config — otherwise the binding resolves
 * to nothing at runtime. Node-only; never imported by the runtime Worker bundle.
 */

import { runWrangler } from "../runner";
import type { ProvisionOutcome, ResourceManifest } from "../types";

/** A KV resource descriptor. */
type KvManifest = Extract<ResourceManifest, { kind: "kv" }>;

/**
 * Delete a KV namespace via `wrangler kv namespace delete --namespace-id <id> -y` (the namespace id
 * is captured by the infra preflight, so deletion targets the exact namespace by id rather than a
 * binding that would require a matching wrangler config). The `-y` flag skips wrangler's own
 * confirmation — the teardown already double-confirmed with the user. Deletes the namespace and all
 * of its keys.
 *
 * @param namespaceId - The Cloudflare KV namespace id to delete (from the preflight's existing-ids).
 * @returns Resolves once wrangler reports the namespace deleted.
 * @throws {Error} When wrangler exits non-zero (e.g. the namespace no longer exists).
 * @example
 * ```ts
 * await deleteKv("ns_abc123");
 * ```
 */
export const deleteKv = async (namespaceId: string): Promise<void> => {
  await runWrangler(["kv", "namespace", "delete", "--namespace-id", namespaceId, "-y"]);
};

/**
 * Parse the created KV namespace id from `wrangler kv namespace create` output.
 * Wrangler prints the new binding as JSON (`"id": "..."`) or TOML (`id = "..."`); the leading
 * boundary (start / whitespace / `{` / `,`) keeps the match off a longer identifier such as
 * `kv_namespace_id`.
 *
 * @param output - Raw stdout from the wrangler create command.
 * @returns The namespace id, or undefined when none is found.
 * @example
 * ```ts
 * parseKvNamespaceId('{ "id": "abc123" }'); // "abc123"
 * ```
 */
export const parseKvNamespaceId = (output: string): string | undefined => {
  const match = /(?:^|[\s,{])"?id"?\s*[:=]\s*"([^"]+)"/m.exec(output);
  return match?.[1];
};

/**
 * Provision a KV namespace via `wrangler kv namespace create` and capture its id.
 *
 * @param manifest - The KV resource descriptor.
 * @param _ci - Whether running non-interactively (passed through; wrangler respects env vars).
 * @returns The captured namespace id when wrangler reported one, else an empty outcome.
 * @example
 * ```ts
 * const { id } = await provisionKv({ kind: "kv", binding: "CACHE" }, false);
 * ```
 */
export const provisionKv = async (
  manifest: KvManifest,
  _ci: boolean
): Promise<ProvisionOutcome> => {
  const output = await runWrangler(["kv", "namespace", "create", manifest.name]);
  const id = parseKvNamespaceId(output);
  return id ? { id } : {};
};
