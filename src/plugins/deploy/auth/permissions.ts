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
  do: undefined,
  turn: { group: "Account · Calls", scope: "Edit", reason: "turn", inBaseTemplate: false }
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

/** Permission every CI/automation redeploy needs: ship the Worker script. */
const CI_ALWAYS: readonly PermissionGroup[] = [
  { group: "Account · Workers Scripts", scope: "Edit", reason: "deploy", inBaseTemplate: true }
];

/**
 * Per-resource-kind permission for the CI/automation token. After a first LOCAL deploy has
 * provisioned everything, CI only needs to LIST existing infra (the idempotent preflight) and
 * ship — so data resources drop to `Read`; R2 stays `Edit` because asset upload writes objects.
 */
const CI_BY_KIND: Record<ResourceManifest["kind"], PermissionGroup | undefined> = {
  kv: {
    group: "Account · Workers KV Storage",
    scope: "Read",
    reason: "kv (preflight)",
    inBaseTemplate: true
  },
  r2: {
    group: "Account · Workers R2 Storage",
    scope: "Edit",
    reason: "r2 (asset upload)",
    inBaseTemplate: true
  },
  d1: { group: "Account · D1", scope: "Read", reason: "d1 (preflight)", inBaseTemplate: false },
  queue: {
    group: "Account · Queues",
    scope: "Read",
    reason: "queue (preflight)",
    inBaseTemplate: false
  },
  do: undefined,
  // A CI redeploy of an already-provisioned worker only LISTS its secrets (covered by Workers
  // Scripts · Edit); the fail-open turn ensure degrades gracefully if CI ever needs to create.
  turn: undefined
};

/**
 * Derive the REDUCED Cloudflare API token for CI/automation redeploys, from the same manifest.
 * Assumes a prior LOCAL deploy already provisioned the infra, so CI never creates: data resources
 * need only `Read` (the idempotent preflight lists them), R2 keeps `Edit` for asset upload, and no
 * `Account Settings · Read` is needed because CI pins `CLOUDFLARE_ACCOUNT_ID`. Pure: no network.
 *
 * @param manifest - The assembled deploy manifest.
 * @returns The minimum permission groups for a CI redeploy token (deduped, manifest-scoped).
 * @example
 * ```ts
 * const groups = ciToken({ name: "w", compatibilityDate: "…", resources: [{ kind: "d1", binding: "DB" }] });
 * // → [Workers Scripts·Edit, D1·Read]
 * ```
 */
export const ciToken = (manifest: ExternalManifest): PermissionGroup[] => {
  const groups: PermissionGroup[] = [...CI_ALWAYS];
  const seen = new Set(groups.map(permission => permission.group));

  for (const resource of manifest.resources) {
    const permission = CI_BY_KIND[resource.kind];
    if (permission !== undefined && !seen.has(permission.group)) {
      groups.push(permission);
      seen.add(permission.group);
    }
  }

  return groups;
};
