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
 * - **"Exists" = both secrets bound on the worker** — never the key name. A manually-created key
 *   bound by hand (`wrangler secret put`) is fully provisioned and must never be clobbered; and a
 *   key whose name matches but whose secret was never bound is USELESS (the secret is returned
 *   exactly once at creation and is unrecoverable) — it gets deleted and recreated.
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
  /** Account TURN keys by name → uid. BEST-EFFORT: empty when the token lacks Calls read. */
  keysByName: Map<string, string>;
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
  `The app falls back to STUN until provisioned. Automatic path: add the "Cloudflare Calls: Edit" permission to CLOUDFLARE_API_TOKEN and redeploy. Manual path: create a TURN key (dash.cloudflare.com → Realtime → TURN) and bind it: wrangler secret put ${resource.keyIdBinding} / wrangler secret put ${resource.apiTokenBinding}.`;

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
 * Preflight read for the plan: the worker's bound secret names (the EXISTS truth) and the account's
 * TURN keys by name (best-effort — stale-key cleanup + teardown ids only). Never throws: a missing
 * script resolves `workerSecrets: null`; an unauthorized key listing resolves an empty map (the
 * token needs no Calls scope just to plan).
 *
 * @param deps - Account/token/fetch bundle.
 * @param scriptName - The stage-qualified worker script name.
 * @returns The turn-relevant existing state.
 * @example
 * ```ts
 * const existing = await fetchTurnExisting(deps, manifest.name);
 * ```
 */
export async function fetchTurnExisting(
  deps: TurnRestDeps,
  scriptName: string
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

  // The account's TURN keys — best-effort (wants Calls read; harmless to miss).
  const keysByName = new Map<string, string>();
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
  } catch {
    // Fail open — planning must never require the Calls scope.
  }

  return { workerSecrets, keysByName };
}

/**
 * Whether a declared TURN resource is already provisioned: BOTH its secrets are bound on the
 * deployed worker. Key names are deliberately ignored — a hand-bound key counts (never clobber it),
 * and a same-name key without bound secrets does not (its secret is unrecoverable).
 *
 * @param resource - The declared TURN resource.
 * @param existing - The preflight's turn-relevant state.
 * @returns True when both secret bindings exist on the worker.
 * @example
 * ```ts
 * turnExists(resource, existing); // true → the plan's "exists" bucket
 * ```
 */
export function turnExists(resource: TurnManifest, existing: TurnExisting): boolean {
  const bound = existing.workerSecrets;
  return bound !== null && bound.has(resource.keyIdBinding) && bound.has(resource.apiTokenBinding);
}

/** What provisioning one TURN key yields: the key's uid + the secret values to bind post-deploy. */
export type TurnProvisionOutcome = {
  /** The created key's uid (also written into the plan ids for teardown). */
  id: string;
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
