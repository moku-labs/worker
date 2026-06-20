/**
 * @file deploy plugin — Cloudflare API token permission derivation (pure, table-driven).
 *
 * Maps the app's manifest to the MINIMUM Cloudflare API token permission set, and flags which
 * groups are missing from the stock "Edit Cloudflare Workers" template (notably D1 and Queues,
 * which the template omits — a common cause of a confusing 403 at deploy). No network: this runs
 * before a token exists, so `auth setup` can tell the user exactly what to create.
 * Node-only; never imported by the runtime Worker bundle.
 */
import type {
  ExternalManifest,
  PermissionGroup,
  ResourceManifest,
  TokenRequirement
} from "../types";

/** Permission groups every deploy needs, regardless of resources. */
const ALWAYS: readonly PermissionGroup[] = [
  { group: "Account · Workers Scripts", scope: "Edit", reason: "deploy", inBaseTemplate: true },
  { group: "Account · Account Settings", scope: "Read", reason: "account", inBaseTemplate: true }
];

/**
 * Per-resource-kind permission group. `do` needs nothing extra (Durable Objects ship with the
 * Worker script, covered by Workers Scripts · Edit). `d1`/`queue` are NOT in the stock template.
 */
const BY_KIND: Record<ResourceManifest["kind"], PermissionGroup | undefined> = {
  kv: { group: "Account · Workers KV Storage", scope: "Edit", reason: "kv", inBaseTemplate: true },
  r2: { group: "Account · Workers R2 Storage", scope: "Edit", reason: "r2", inBaseTemplate: true },
  d1: { group: "Account · D1", scope: "Edit", reason: "d1", inBaseTemplate: false },
  queue: { group: "Account · Queues", scope: "Edit", reason: "queue", inBaseTemplate: false },
  do: undefined
};

/**
 * Derive the Cloudflare API token requirement from an app manifest: the full permission set plus
 * the subset that must be ADDED to the stock "Edit Cloudflare Workers" template.
 *
 * @param manifest - The assembled deploy manifest.
 * @returns The token requirement (base template, full required set, and groups to add).
 * @example
 * ```ts
 * const { toAdd } = requiredToken({ name: "w", compatibilityDate: "…", resources: [{ kind: "d1", binding: "DB" }] });
 * // toAdd → [{ group: "Account · D1", scope: "Edit", … }]
 * ```
 */
export const requiredToken = (manifest: ExternalManifest): TokenRequirement => {
  const required: PermissionGroup[] = [...ALWAYS];
  const seen = new Set(required.map(permission => permission.group));

  for (const resource of manifest.resources) {
    const permission = BY_KIND[resource.kind];
    if (permission !== undefined && !seen.has(permission.group)) {
      required.push(permission);
      seen.add(permission.group);
    }
  }

  return {
    base: "Edit Cloudflare Workers",
    required,
    toAdd: required.filter(permission => !permission.inBaseTemplate)
  };
};
