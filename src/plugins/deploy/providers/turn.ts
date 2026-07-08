/**
 * @file deploy plugin — TURN-key provisioning adapter (Cloudflare Realtime), standard-flow edition.
 *
 * TURN rides the SAME pipeline as every other resource: the preflight judges it
 * ({@link fetchTurnExisting}), the provision phase creates it ({@link provisionTurn}), teardown
 * deletes it ({@link deleteTurnKey}). One physical Cloudflare constraint remains: worker SECRETS can
 * only bind to an EXISTING script, so the two secret binds run right after `wrangler deploy` lands
 * ({@link bindTurnSecrets}) — the same class of step as a Durable Object migration applying at
 * deploy, not a separate provisioning model.
 *
 * Ground truths this module encodes:
 * - **"Exists" is NAME-ANCHORED**: a key with the DECLARED name exists AND both secrets are bound —
 *   the same name-means-the-thing rule as every other resource. Bound secrets from a
 *   differently-named hand-created key do NOT satisfy the declaration; the next deploy CONVERGES
 *   (creates the declared key, re-binds). A same-name key whose secret was never bound is USELESS
 *   (the secret is returned exactly once and is unrecoverable) — deleted and recreated. Only when
 *   the key listing is unavailable (no Calls read) does the bound-secrets signal decide alone.
 * - **Errors are per-step and loud** (`create turn_keys → 403 …`), so a scope problem is
 *   diagnosable from the deploy output alone. The PIPELINE still treats a turn failure as a
 *   DEGRADATION (warning + STUN fallback), never a deploy failure — that contract saved a live
 *   deploy already; the visibility problem was the panels, not the fail-open.
 * - Preflight reads are fail-open: the key LISTING (wants Calls read) is best-effort — it only
 *   feeds stale-key cleanup and teardown ids; the exists decision needs only the worker-secrets
 *   listing (covered by the Workers Scripts scope every deploy token has).
 *
 * All REST (no wrangler subprocess); secret values never touch argv or disk. Node-only.
 */
/* eslint-disable unicorn/no-null -- TurnExisting.workerSecrets is `null` by contract when the
   script does not exist yet (a tri-state a Set cannot express). */
import type { ResourceManifest } from "../types";

/** Cloudflare REST API root. */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** A TURN resource descriptor. */
type TurnManifest = Extract<ResourceManifest, { kind: "turn" }>;

/** The Cloudflare account/token bundle every REST call runs against (injectable fetch for tests). */
export type TurnRestDeps = {
  /** The Cloudflare account id the auth preflight resolved. */
  accountId: string;
  /** The pipeline's `CLOUDFLARE_API_TOKEN`. */
  token: string;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
};

/** What the preflight learned about the account/worker state relevant to TURN resources. */
export type TurnExisting = {
  /** Secret NAMES bound on the deployed worker script; `null` when the script does not exist yet. */
  workerSecrets: Set<string> | null;
  /** Account TURN keys by name → uid (meaningful only when {@link TurnExisting.keysListable}). */
  keysByName: Map<string, string>;
  /**
   * Whether the account key listing succeeded. `false` = the token lacks Calls read — existence
   * cannot be judged by name, so {@link turnExists} falls back to the functional signals.
   */
  keysListable: boolean;
  /**
   * Live FUNCTIONAL check of the already-deployed worker's credential endpoint (needs no Calls
   * scope): `true` = it mints — the bound key demonstrably works; `false` = it answers but cannot
   * mint (dead/deleted key) — the resource is treated as MISSING so the deploy converges; `null` =
   * unverifiable (no prior deploy, verification disabled, endpoint absent, network failure) —
   * never punished.
   */
  mintOk: boolean | null;
  /**
   * The ESCAPE-HATCH source pair from the deploy environment (`.env.local`: the resource's
   * `keyIdBinding`/`apiTokenBinding` names, default `TURN_KEY_ID`/`TURN_KEY_API_TOKEN`), when both
   * are set. VALIDATED by an actual credential mint against `rtc.live.cloudflare.com` — the TURN
   * key's own token authorizes itself, so this needs NO Cloudflare account API and sidesteps the
   * known Calls-scope 403. `mintOk`: `true` = the pair demonstrably mints (the provision
   * confirmation), `false` = rejected (typo/deleted key), `null` = unverifiable (network).
   */
  envKey?: { keyId: string; apiToken: string; mintOk: boolean | null };
};

/**
 * Build the ONE actionable instruction line appended to every degraded-turn warning — everything
 * needed to finish by hand (the scope for the automatic path, or the manual key + secret names).
 *
 * @param resource - The TURN resource (its secret binding names).
 * @returns The instruction line.
 * @example
 * ```ts
 * `${error.message} ${turnInstruction(resource)}`
 * ```
 */
export const turnInstruction = (resource: TurnManifest): string =>
  `The app falls back to STUN until provisioned. Easiest: create a TURN key (dash.cloudflare.com → Realtime → TURN) and put ${resource.keyIdBinding} + ${resource.apiTokenBinding} into .env.local — the next deploy validates and binds it. Or add the "Cloudflare Calls: Edit" permission to CLOUDFLARE_API_TOKEN for auto-create, or bind by hand: wrangler secret put ${resource.keyIdBinding} / wrangler secret put ${resource.apiTokenBinding}.`;

/**
 * One Cloudflare REST call. Resolves the envelope's `result`; THROWS a per-step branded error
 * (`<step> → HTTP <status>` / the envelope's first error message) on any failure — provision-phase
 * callers surface it loudly, preflight callers catch and fail open.
 *
 * @param deps - Account/token/fetch bundle.
 * @param step - Short step label for the error message (e.g. "create turn_keys").
 * @param method - HTTP method.
 * @param path - Path under the API root.
 * @param body - Optional JSON body.
 * @returns The envelope's `result`.
 * @throws {Error} With the step label + HTTP status (and Cloudflare's message when present).
 * @example
 * ```ts
 * const key = await cfCall<{ uid: string }>(deps, "create turn_keys", "POST", "/accounts/a1/calls/turn_keys", { name });
 * ```
 */
async function cfCall<T>(
  deps: TurnRestDeps,
  step: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${CF_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const envelope = (await response.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ message?: string }>;
  } | null;

  if (!response.ok || envelope?.success !== true) {
    const detail = envelope?.errors?.[0]?.message;
    const suffix = detail ? ` (${detail})` : "";
    throw new Error(`[worker] ${step} → HTTP ${String(response.status)}${suffix}`);
  }
  return envelope.result as T;
}

/**
 * Functionally verify the already-deployed worker's credential endpoint by CALLING it — the one
 * existence signal that needs no Calls scope and cannot lie: a live mint proves the bound key
 * works end to end.
 *
 * @param url - The worker's credential endpoint URL.
 * @param fetchImpl - Injectable fetch.
 * @returns `true` (mints), `false` (answers but cannot mint — dead key), `null` (unverifiable).
 * @example
 * ```ts
 * const ok = await verifyMint("https://app.sub.workers.dev/api/ice", fetch);
 * ```
 */
async function verifyMint(url: string, fetchImpl: typeof fetch): Promise<boolean | null> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    // The endpoint contract (room's hub): 200 {iceServers} = mints; 200 {} = no secrets;
    // 502 = mint failed (dead key). Anything else (404 SPA fallback, 405, …) = not this
    // endpoint — unverifiable, never punished.
    if (response.status === 502) return false;
    if (response.status !== 200) return null;
    const body = (await response.json().catch(() => null)) as { iceServers?: unknown } | null;
    if (body === null) return null;
    return body.iceServers === undefined ? false : true;
  } catch {
    return null;
  }
}

/** Cloudflare Realtime TURN credential-mint root — the key's own token authorizes these calls. */
const RTC_TURN_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * Validate a TURN key pair by ACTUALLY MINTING a short-lived credential with it — the ground-truth
 * check that needs no Cloudflare account API at all (the key's own token authorizes itself).
 *
 * @param keyId - The TURN key id.
 * @param apiToken - The TURN key's API token.
 * @param fetchImpl - Injectable fetch.
 * @returns `true` (mints), `false` (rejected — bad pair or deleted key), `null` (network — unverifiable).
 * @example
 * ```ts
 * const ok = await verifyKeyPair(envKeyId, envApiToken, fetch);
 * ```
 */
async function verifyKeyPair(
  keyId: string,
  apiToken: string,
  fetchImpl: typeof fetch
): Promise<boolean | null> {
  try {
    const response = await fetchImpl(`${RTC_TURN_BASE}/${keyId}/credentials/generate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 300 }),
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) return true;
    // A definite rejection (401/403/404) means the pair is unusable; 5xx stays unverifiable.
    return response.status < 500 ? false : null;
  } catch {
    return null;
  }
}

/**
 * Preflight read for the plan: the worker's bound secret names, the account's TURN keys by name
 * (best-effort — stale-key cleanup + teardown ids only), and the live functional mint check of the
 * already-deployed endpoint. Never throws: a missing script resolves `workerSecrets: null`, an
 * unauthorized key listing resolves an empty map (the token needs no Calls scope just to plan),
 * and an unverifiable mint resolves `mintOk: null`.
 *
 * @param deps - Account/token/fetch bundle.
 * @param scriptName - The stage-qualified worker script name.
 * @param verifyPath - The credential-endpoint path to functionally verify; `false` disables.
 * @param envPair - The .env.local escape-hatch pair to validate by a real mint, when set.
 * @param envPair.keyId - The env pair's key id.
 * @param envPair.apiToken - The env pair's key API token.
 * @returns The turn-relevant existing state.
 * @example
 * ```ts
 * const existing = await fetchTurnExisting(deps, manifest.name, "/api/ice");
 * ```
 */
export async function fetchTurnExisting(
  deps: TurnRestDeps,
  scriptName: string,
  verifyPath: string | false,
  envPair?: { keyId: string; apiToken: string }
): Promise<TurnExisting> {
  // The worker's secret names — the ground truth for "provisioned". 404 = script not deployed yet.
  let workerSecrets: Set<string> | null = null;
  try {
    const rows = await cfCall<Array<{ name?: unknown }>>(
      deps,
      "list script secrets",
      "GET",
      `/accounts/${deps.accountId}/workers/scripts/${scriptName}/secrets`
    );
    workerSecrets = new Set(
      rows.map(row => (typeof row.name === "string" ? row.name : "")).filter(n => n !== "")
    );
  } catch {
    workerSecrets = null;
  }

  // The account's TURN keys — best-effort (wants Calls read; planning must never require it).
  const keysByName = new Map<string, string>();
  let keysListable = false;
  try {
    const keys = await cfCall<Array<{ uid?: unknown; name?: unknown }>>(
      deps,
      "list turn_keys",
      "GET",
      `/accounts/${deps.accountId}/calls/turn_keys`
    );
    for (const key of keys) {
      if (typeof key.uid === "string" && typeof key.name === "string") {
        keysByName.set(key.name, key.uid);
      }
    }
    keysListable = true;
  } catch {
    // Fail open — turnExists falls back to the bound-secrets signal.
  }

  // Functional verification — only meaningful when a prior deploy exists AND both a verify path
  // and the workers.dev subdomain are available. Fail-open (`null`) in every unverifiable case.
  let mintOk: boolean | null = null;
  if (verifyPath !== false && workerSecrets !== null) {
    try {
      const { subdomain } = await cfCall<{ subdomain?: string }>(
        deps,
        "resolve workers.dev subdomain",
        "GET",
        `/accounts/${deps.accountId}/workers/subdomain`
      );
      if (typeof subdomain === "string" && subdomain !== "") {
        mintOk = await verifyMint(
          `https://${scriptName}.${subdomain}.workers.dev${verifyPath}`,
          deps.fetchImpl ?? fetch
        );
      }
    } catch {
      // Subdomain unresolvable → unverifiable; the remaining signals decide.
    }
  }

  // The escape-hatch pair from the deploy env — validated by a real mint (its own confirmation).
  let envKey: TurnExisting["envKey"];
  if (envPair !== undefined) {
    envKey = {
      ...envPair,
      mintOk: await verifyKeyPair(envPair.keyId, envPair.apiToken, deps.fetchImpl ?? fetch)
    };
  }

  return { workerSecrets, keysByName, keysListable, mintOk, ...(envKey ? { envKey } : {}) };
}

/**
 * Whether a declared TURN resource already exists — NAME-ANCHORED, like every other resource row:
 * a key with the DECLARED name exists in the account AND both secrets are bound on the worker. A
 * hand-created key under another name does NOT satisfy the declaration — the next deploy CONVERGES
 * (creates the declared key and re-binds the secrets to it), as a declarative model should. A
 * same-name key without bound secrets is a torn leftover (its secret is unrecoverable) → missing.
 *
 * One honest fallback: when the account key listing is unavailable (`keysListable: false` — the
 * token lacks Calls read), existence cannot be judged by name, so the bound-secrets signal decides
 * alone; the strict rule resumes the moment the scope works.
 *
 * @param resource - The declared TURN resource.
 * @param existing - The preflight's turn-relevant state.
 * @returns True when the declaration is satisfied (named key + bound secrets; or the fallback).
 * @example
 * ```ts
 * turnExists(resource, existing); // true → the plan's "exists" bucket
 * ```
 */
export function turnExists(resource: TurnManifest, existing: TurnExisting): boolean {
  const bound = existing.workerSecrets;
  const secretsBound =
    bound !== null && bound.has(resource.keyIdBinding) && bound.has(resource.apiTokenBinding);

  // A failed live mint is decisive: the bound key is dead (deleted/rotated) — MISSING, so the
  // deploy converges regardless of what the name listing says.
  if (existing.mintOk === false) return false;

  // ESCAPE-HATCH mode (env pair supplied): the deployed endpoint's live mint is the whole truth —
  // it works → exists; unverifiable/unbound → missing, and the env pair re-binds (no Calls API).
  if (existing.envKey !== undefined) {
    return secretsBound && existing.mintOk === true;
  }

  if (!existing.keysListable) return secretsBound;
  return existing.keysByName.has(resource.name) && secretsBound;
}

/** What provisioning one TURN key yields: the key's uid + the secret values to bind post-deploy. */
export type TurnProvisionOutcome = {
  /**
   * The created key's uid (teardown attribution). ABSENT in escape-hatch mode — a user-managed
   * `.env.local` key must never be deleted by teardown.
   */
  id?: string;
  /** Secret binding name → value, held IN MEMORY until the post-deploy bind (never in config). */
  secrets: Record<string, string>;
};

/**
 * Provision one TURN key in the STANDARD provision phase: delete a stale same-name key when one
 * exists (its secret is unrecoverable — a leftover from a torn earlier run), create the key (the
 * response's `key` is the secret, returned exactly once), and hand the values back for the
 * post-deploy bind. Throws per-step on failure — the caller records it as a DEGRADED resource
 * (warning; the deploy continues on STUN).
 *
 * @param resource - The declared TURN resource (stage-qualified name + binding names).
 * @param existing - The preflight's turn state (stale-key lookup).
 * @param deps - Account/token/fetch bundle.
 * @returns The created key's uid + the secrets to bind after `wrangler deploy`.
 * @throws {Error} Per-step (`delete turn_keys` / `create turn_keys`) with the HTTP status.
 * @example
 * ```ts
 * const { id, secrets } = await provisionTurn(resource, existing, deps);
 * ```
 */
export async function provisionTurn(
  resource: TurnManifest,
  existing: TurnExisting,
  deps: TurnRestDeps
): Promise<TurnProvisionOutcome> {
  // ESCAPE-HATCH mode: adopt the .env.local pair — validated by its own mint at preflight — and
  // hand it to the post-deploy bind. Touches NO Cloudflare account API (sidesteps the known
  // Calls-scope 403). A pair that failed its mint is a hard, precise error → degraded warning.
  if (existing.envKey !== undefined) {
    if (existing.envKey.mintOk === false) {
      throw new Error(
        `[worker] env TURN credentials rejected — ${resource.keyIdBinding}/${resource.apiTokenBinding} in .env.local failed a live mint (typo, or the key was deleted)`
      );
    }
    return {
      // No uid on purpose: teardown must never delete a USER-MANAGED key.
      secrets: {
        [resource.keyIdBinding]: existing.envKey.keyId,
        [resource.apiTokenBinding]: existing.envKey.apiToken
      }
    };
  }

  // No token → nothing to create with; one clean step error (→ the degraded warning + instruction).
  if (deps.token === "") {
    throw new Error("[worker] create turn_keys → CLOUDFLARE_API_TOKEN is not set");
  }

  // A same-name key with UNBOUND secrets is a torn leftover — delete it so keys never accumulate.
  const stale = existing.keysByName.get(resource.name);
  if (stale !== undefined) {
    await cfCall(
      deps,
      `delete stale turn_key "${resource.name}"`,
      "DELETE",
      `/accounts/${deps.accountId}/calls/turn_keys/${stale}`
    );
  }

  const created = await cfCall<{ uid?: unknown; key?: unknown }>(
    deps,
    "create turn_keys",
    "POST",
    `/accounts/${deps.accountId}/calls/turn_keys`,
    { name: resource.name }
  );
  if (typeof created.uid !== "string" || typeof created.key !== "string") {
    throw new TypeError("[worker] create turn_keys → malformed response (no uid/key)");
  }

  return {
    id: created.uid,
    secrets: {
      [resource.keyIdBinding]: created.uid,
      [resource.apiTokenBinding]: created.key
    }
  };
}

/**
 * Bind the provision phase's captured TURN secrets to the JUST-DEPLOYED worker script — the one
 * step that physically must follow `wrangler deploy` (secrets need an existing script). Throws
 * per-secret on failure; the next run's preflight sees the unbound pair and recreates cleanly.
 *
 * @param scriptName - The stage-qualified worker script name that just deployed.
 * @param secrets - Binding name → value captured by {@link provisionTurn}.
 * @param deps - Account/token/fetch bundle.
 * @returns Resolves once every secret is bound.
 * @throws {Error} Per-step (`bind secret <name>`) with the HTTP status.
 * @example
 * ```ts
 * await bindTurnSecrets(manifest.name, provisioned.pendingSecrets, deps);
 * ```
 */
export async function bindTurnSecrets(
  scriptName: string,
  secrets: Record<string, string>,
  deps: TurnRestDeps
): Promise<void> {
  for (const [name, text] of Object.entries(secrets)) {
    await cfCall(
      deps,
      `bind secret ${name}`,
      "PUT",
      `/accounts/${deps.accountId}/workers/scripts/${scriptName}/secrets`,
      { name, text, type: "secret_text" }
    );
  }
}

/**
 * Delete one TURN key by uid — the teardown path for keys THIS pipeline created (the plan captures
 * the uid only when a key matching the configured name exists; a hand-created key under another
 * name is never touched).
 *
 * @param uid - The key uid captured by the preflight.
 * @param deps - Account/token/fetch bundle.
 * @returns Resolves once deleted.
 * @throws {Error} With the HTTP status on failure.
 * @example
 * ```ts
 * await deleteTurnKey(ref.id, deps);
 * ```
 */
export async function deleteTurnKey(uid: string, deps: TurnRestDeps): Promise<void> {
  await cfCall(
    deps,
    "delete turn_keys",
    "DELETE",
    `/accounts/${deps.accountId}/calls/turn_keys/${uid}`
  );
}
