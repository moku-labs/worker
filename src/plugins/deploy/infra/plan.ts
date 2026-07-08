/**
 * @file deploy plugin — infra preflight planner.
 *
 * Reads the `.env` Cloudflare token, lists what already exists in the account, and diffs it
 * against the assembled manifest to produce an InfraPlan (existing vs missing vs ships-with-Worker
 * for Durable Objects). Read-only: emits `provision:plan` and writes nothing. Node-only; never
 * imported by the runtime Worker bundle.
 */
import type { Ctx, ExternalManifest, InfraPlan, ProvisionedRef, ResourceManifest } from "../types";
import type { ExistingResources, ListableKind } from "./cloudflare";
import { listExisting, resolveAccount } from "./cloudflare";

/**
 * A provisionable resource — every kind EXCEPT a Durable Object (ships with the Worker) and a TURN
 * key (worker-scoped secrets, ensured in the built-in post-deploy phase — a script must exist
 * before its secrets can bind, and the key secret is unrecoverable after creation, so the account
 * listing cannot judge its real state).
 */
type ProvisionableManifest = Exclude<ResourceManifest, { kind: "do" | "turn" }>;

/**
 * Decide whether a single API-provisioned resource already exists in the account, recovering its id
 * (kv/d1) when it does. Durable Objects are NOT handled here — they ship with the Worker (`wrangler
 * deploy` + the auto-derived DO migration create the namespace), are never provisioned via the API,
 * and are partitioned into the plan's `ships` bucket by {@link planInfra} before this is ever called.
 *
 * @param resource - The declared (provisionable) resource descriptor.
 * @param existing - The indexed set of resources already in the account.
 * @returns Whether it exists, plus the captured id for kv/d1.
 * @example
 * ```ts
 * checkExisting({ kind: "kv", binding: "SESSIONS" }, existing); // { exists: true, id: "ns123" }
 * ```
 */
const checkExisting = (
  resource: ProvisionableManifest,
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
  }
};

/**
 * Run the read-only infra preflight: resolve the account, list existing resources, diff against
 * the manifest, emit `provision:plan`, and return the plan. Writes nothing.
 *
 * @param ctx - The deploy plugin context (env + emit).
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @returns The infra plan: existing (with ids) vs missing vs ships-with-Worker (Durable Objects).
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

  // Query only the kinds the app declares (DO is never listed — it ships with the script; TURN is
  // never listed — ensured post-deploy against the worker's own secrets), so the token needs read
  // permission on just those kinds.
  const kinds = new Set<ListableKind>();
  for (const resource of manifest.resources) {
    if (resource.kind !== "do" && resource.kind !== "turn") kinds.add(resource.kind);
  }
  const existing = await listExisting(token, account.id, kinds);

  // Partition the declared resources: TURN keys are ensured in the built-in post-deploy phase
  // (excluded from the plan entirely — see ProvisionableManifest); DOs ship with the Worker; the
  // rest are already-existing vs still-missing per the account listing.
  const planned = manifest.resources.filter(resource => resource.kind !== "turn");
  const exists: ProvisionedRef[] = [];
  const missing: ResourceManifest[] = [];
  const ships: ResourceManifest[] = [];
  for (const resource of planned) {
    if (resource.kind === "do") {
      ships.push(resource);
      continue;
    }

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
    ships: ships.length,
    account: account.name
  });

  return { account: account.name, accountId: account.id, exists, missing, ships };
};
