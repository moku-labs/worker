/**
 * @file deploy plugin — infra preflight planner.
 *
 * Reads the `.env` Cloudflare token, lists what already exists in the account, and diffs it
 * against the assembled manifest to produce an InfraPlan (existing vs missing vs ships-with-Worker
 * for Durable Objects). Read-only: emits `provision:plan` and writes nothing. Node-only; never
 * imported by the runtime Worker bundle.
 */
import { fetchTurnExisting, turnExists } from "../providers/turn";
import type { Ctx, ExternalManifest, InfraPlan, ProvisionedRef, ResourceManifest } from "../types";
import type { ExistingResources, ListableKind } from "./cloudflare";
import { listExisting, resolveAccount } from "./cloudflare";

/**
 * An account-LISTABLE resource — every kind except a Durable Object (ships with the Worker) and a
 * TURN key (judged by the worker's bound secrets via its own preflight — `turnExists` — because the
 * key secret is unrecoverable after creation, so the account key listing alone cannot tell a usable
 * key from a torn one).
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
 * Partition the declared resources into the plan's three buckets: Durable Objects ship with the
 * Worker; a TURN key exists when BOTH its secrets are bound on the worker (`turnExists` — the id is
 * captured when a same-name account key is found, for teardown); everything else is judged against
 * the account listing (`checkExisting`, ids captured for kv/d1).
 *
 * @param resources - The manifest's declared resources.
 * @param existing - The account listing for the listable kinds.
 * @param turn - The TURN preflight state.
 * @param turn.workerSecrets - Secret names bound on the worker; `null` when the script is missing.
 * @param turn.keysByName - Account TURN keys by name → uid (best-effort).
 * @returns The exists/missing/ships buckets.
 * @example
 * ```ts
 * const { exists, missing, ships } = partitionResources(manifest.resources, existing, turn);
 * ```
 */
const partitionResources = (
  resources: ResourceManifest[],
  existing: ExistingResources,
  turn: { workerSecrets: Set<string> | null; keysByName: Map<string, string> }
): { exists: ProvisionedRef[]; missing: ResourceManifest[]; ships: ResourceManifest[] } => {
  const exists: ProvisionedRef[] = [];
  const missing: ResourceManifest[] = [];
  const ships: ResourceManifest[] = [];

  /**
   * Existing-ref classifier per kind: an exists-ref (id captured when known), or undefined (missing).
   *
   * @param resource - The declared (non-DO) resource.
   * @returns The exists-ref, or undefined when the resource must be created.
   * @example
   * ```ts
   * const ref = existingRef({ kind: "kv", name: "cache", binding: "KV" });
   * ```
   */
  const existingRef = (
    resource: Exclude<ResourceManifest, { kind: "do" }>
  ): ProvisionedRef | undefined => {
    if (resource.kind === "turn") {
      if (!turnExists(resource, turn)) return undefined;
      const id = turn.keysByName.get(resource.name);
      return id === undefined ? { resource } : { resource, id };
    }
    const check = checkExisting(resource, existing);
    if (!check.exists) return undefined;
    return check.id === undefined ? { resource } : { resource, id: check.id };
  };

  for (const resource of resources) {
    if (resource.kind === "do") {
      ships.push(resource);
      continue;
    }
    const ref = existingRef(resource);
    if (ref === undefined) {
      missing.push(resource);
    } else {
      exists.push(ref);
    }
  }

  return { exists, missing, ships };
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

  // Query only the kinds the app declares (DO is never listed — it ships with the script; TURN has
  // its own preflight below), so the token needs read permission on just those kinds.
  const kinds = new Set<ListableKind>();
  for (const resource of manifest.resources) {
    if (resource.kind !== "do" && resource.kind !== "turn") kinds.add(resource.kind);
  }
  const existing = await listExisting(token, account.id, kinds);

  // TURN preflight — one fail-open read when any turn resource is declared: the worker's bound
  // secret names (the EXISTS truth — a hand-bound key counts, a secretless same-name key does not)
  // plus the account's keys by name (best-effort; feeds stale cleanup + teardown ids only, so the
  // token needs no Calls scope just to plan).
  const wantsTurn = manifest.resources.some(resource => resource.kind === "turn");
  const turn = wantsTurn
    ? await fetchTurnExisting({ accountId: account.id, token }, manifest.name)
    : // eslint-disable-next-line unicorn/no-null -- TurnExisting.workerSecrets is null-when-missing by contract
      { workerSecrets: null, keysByName: new Map<string, string>() };

  // Partition the declared resources: DOs ship with the Worker; TURN judges against the worker's
  // bound secrets; the rest are already-existing vs still-missing per the account listing.
  const { exists, missing, ships } = partitionResources(manifest.resources, existing, turn);

  ctx.emit("provision:plan", {
    exists: exists.length,
    missing: missing.length,
    ships: ships.length,
    account: account.name
  });

  return {
    account: account.name,
    accountId: account.id,
    exists,
    missing,
    ships,
    ...(wantsTurn ? { turn } : {})
  };
};
