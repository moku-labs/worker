/**
 * @file deploy plugin — infra preflight planner.
 *
 * Reads the `.env` Cloudflare token, lists what already exists in the account, and diffs it
 * against the assembled manifest to produce an InfraPlan (existing vs missing). Read-only: emits
 * `provision:plan` and writes nothing. Node-only; never imported by the runtime Worker bundle.
 */
import type { Ctx, ExternalManifest, InfraPlan, ProvisionedRef, ResourceManifest } from "../types";
import type { ExistingResources, ListableKind } from "./cloudflare";
import { listExisting, resolveAccount } from "./cloudflare";

/**
 * Decide whether a single declared resource already exists in the account, recovering its id
 * (kv/d1) when it does. Durable Objects are config-only (they ship with the script), so they are
 * always treated as "missing" — provisioning them is a no-op that just records the binding.
 *
 * @param resource - The declared resource descriptor.
 * @param existing - The indexed set of resources already in the account.
 * @returns Whether it exists, plus the captured id for kv/d1.
 * @example
 * ```ts
 * checkExisting({ kind: "kv", binding: "SESSIONS" }, existing); // { exists: true, id: "ns123" }
 * ```
 */
const checkExisting = (
  resource: ResourceManifest,
  existing: ExistingResources
): { exists: boolean; id?: string } => {
  switch (resource.kind) {
    case "kv": {
      const id = existing.kv.get(resource.name);
      return id === undefined ? { exists: false } : { exists: true, id };
    }
    case "d1": {
      const id = existing.d1.get(resource.name);
      return id === undefined ? { exists: false } : { exists: true, id };
    }
    case "r2": {
      return { exists: existing.r2.has(resource.name) };
    }
    case "queue": {
      return { exists: existing.queue.has(resource.name) };
    }
    case "do": {
      return { exists: false };
    }
  }
};

/**
 * Run the read-only infra preflight: resolve the account, list existing resources, diff against
 * the manifest, emit `provision:plan`, and return the plan. Writes nothing.
 *
 * @param ctx - The deploy plugin context (env + emit).
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @returns The infra plan: existing (with ids) vs missing resources.
 * @throws {Error} When the token is absent/invalid or a Cloudflare listing fails.
 * @example
 * ```ts
 * const plan = await planInfra(ctx, manifest);
 * ```
 */
export const planInfra = async (ctx: Ctx, manifest: ExternalManifest): Promise<InfraPlan> => {
  const token = ctx.env.require("CLOUDFLARE_API_TOKEN");

  // Use a pinned account id when the consumer provided one; else resolve the first accessible.
  const pinnedAccountId = ctx.env.get("CLOUDFLARE_ACCOUNT_ID");
  const account = pinnedAccountId
    ? { id: pinnedAccountId, name: pinnedAccountId }
    : await resolveAccount(token);

  // Query only the kinds the app declares (DO is never listed — it ships with the script), so the
  // token needs read permission on just those kinds.
  const kinds = new Set<ListableKind>();
  for (const resource of manifest.resources) {
    if (resource.kind !== "do") kinds.add(resource.kind);
  }
  const existing = await listExisting(token, account.id, kinds);

  // Partition the declared resources into already-existing vs still-missing.
  const exists: ProvisionedRef[] = [];
  const missing: ResourceManifest[] = [];
  for (const resource of manifest.resources) {
    const check = checkExisting(resource, existing);
    if (check.exists) {
      exists.push(check.id === undefined ? { resource } : { resource, id: check.id });
    } else {
      missing.push(resource);
    }
  }

  ctx.emit("provision:plan", {
    exists: exists.length,
    missing: missing.length,
    account: account.name
  });

  return { account: account.name, accountId: account.id, exists, missing };
};
