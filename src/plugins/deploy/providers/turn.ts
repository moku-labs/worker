/**
 * @file deploy plugin — TURN-key provisioning adapter (Cloudflare Realtime).
 *
 * Ensures each declared `turn` resource on the JUST-DEPLOYED worker: both secrets already bound →
 * no-op ("exists"); otherwise create a TURN key via the Realtime REST API (the key SECRET is
 * returned exactly once at creation) and bind the id + secret as worker secrets — all over the
 * Cloudflare REST API (no wrangler subprocess; secret values never touch argv or disk).
 *
 * Runs in the built-in post-deploy phase (next to migration/seed) because worker secrets can only
 * bind to an EXISTING script — a first deploy has no script until `wrangler deploy` lands.
 *
 * STRICTLY FAIL-OPEN, unlike the other providers: a TURN key that cannot be provisioned (no token,
 * token without the Calls `Edit` scope, API/network failure) prints ONE actionable instruction line
 * and resolves "degraded" — never throws, never prompts (`--ci` safe), never fails the deploy. The
 * consumer's ICE ladder falls back to STUN, so a TURN-less deploy is degraded, not broken.
 * Node-only; never imported by the runtime Worker bundle.
 */
import type { ResourceManifest } from "../types";

/** Cloudflare REST API root. */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** A TURN resource descriptor. */
type TurnManifest = Extract<ResourceManifest, { kind: "turn" }>;

/** The per-resource ensure outcome ("skipped" is the caller's no-resources aggregate). */
export type TurnOutcome = "exists" | "provisioned" | "degraded";

/** The dependencies {@link ensureTurnKey} runs against (injectable fetch for tests). */
export type TurnDeps = {
  /** The Cloudflare account id the auth preflight resolved. */
  accountId: string;
  /** The stage-qualified worker script name that just deployed. */
  scriptName: string;
  /** The pipeline's `CLOUDFLARE_API_TOKEN` (needs Calls `Edit` to create keys). */
  apiToken: string | undefined;
  /** Branded info-line sink (the step's status/instruction channel). */
  note: (message: string) => void;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
};

/**
 * Build the ONE actionable instruction line printed when a TURN key could not be auto-provisioned —
 * everything needed to finish by hand (the scope to add for the automatic path, or the manual key +
 * secret names), plus the reassurance that the deploy itself is fine.
 *
 * @param resource - The TURN resource (its secret binding names).
 * @returns The single instruction line.
 * @example
 * ```ts
 * note(turnInstruction(resource));
 * ```
 */
const turnInstruction = (resource: TurnManifest): string =>
  `TURN key "${resource.name}" not provisioned — the app falls back to STUN. To enable the relay: add the "Calls: Edit" permission to CLOUDFLARE_API_TOKEN and redeploy, or create a TURN key (dash.cloudflare.com → Realtime → TURN) and bind it: wrangler secret put ${resource.keyIdBinding} / wrangler secret put ${resource.apiTokenBinding}.`;

/**
 * One Cloudflare REST call with a bearer token, resolving the envelope's `result` or `undefined` on
 * ANY failure (non-2xx, `success: false`, thrown fetch, malformed body) — the fail-open primitive
 * every step of the ensure runs on.
 *
 * @param token - The API token.
 * @param method - HTTP method.
 * @param path - Path under the API root (e.g. "/accounts/{id}/calls/turn_keys").
 * @param body - Optional JSON body.
 * @param fetchImpl - Injectable fetch.
 * @returns The envelope's `result`, or `undefined` on any failure.
 * @example
 * ```ts
 * const key = await cfCall<{ uid: string }>(token, "POST", "/accounts/a1/calls/turn_keys", { name: "app-turn" }, fetch);
 * ```
 */
async function cfCall<T>(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<T | undefined> {
  try {
    const response = await fetchImpl(`${CF_API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) return undefined;

    const envelope = (await response.json()) as { success?: boolean; result?: T } | null;
    if (envelope === null || envelope.success !== true) return undefined;
    return envelope.result;
  } catch {
    return undefined;
  }
}

/**
 * List the secret NAMES bound to the deployed worker script (values are never readable).
 *
 * @param deps - Account/script/token/fetch bundle.
 * @param token - The verified API token.
 * @returns The bound names, or `undefined` when the listing failed.
 * @example
 * ```ts
 * const bound = await listSecretNames(deps, token);
 * ```
 */
const listSecretNames = async (deps: TurnDeps, token: string): Promise<string[] | undefined> => {
  const rows = await cfCall<Array<{ name?: unknown }>>(
    token,
    "GET",
    `/accounts/${deps.accountId}/workers/scripts/${deps.scriptName}/secrets`,
    undefined,
    deps.fetchImpl ?? fetch
  );
  if (!Array.isArray(rows)) return undefined;
  return rows.map(row => (typeof row.name === "string" ? row.name : "")).filter(n => n !== "");
};

/**
 * Bind one secret on the deployed worker script.
 *
 * @param deps - Account/script/token/fetch bundle.
 * @param token - The verified API token.
 * @param name - The secret name.
 * @param text - The secret value.
 * @returns Whether the bind succeeded.
 * @example
 * ```ts
 * await putSecret(deps, token, "TURN_KEY_ID", key.uid);
 * ```
 */
const putSecret = async (
  deps: TurnDeps,
  token: string,
  name: string,
  text: string
): Promise<boolean> => {
  const result = await cfCall<{ name?: string }>(
    token,
    "PUT",
    `/accounts/${deps.accountId}/workers/scripts/${deps.scriptName}/secrets`,
    { name, text, type: "secret_text" },
    deps.fetchImpl ?? fetch
  );
  return result !== undefined;
};

/**
 * Ensure ONE declared TURN resource on the just-deployed worker. Idempotent (both secrets bound →
 * read-only "exists"); a half-bound pair is re-ensured with a FRESH key (the old key's secret is
 * unrecoverable by design). Never throws; every impediment resolves "degraded" after printing the
 * single {@link turnInstruction} line.
 *
 * @param resource - The declared TURN resource (stage-qualified name + secret binding names).
 * @param deps - Account/script/token/note/fetch bundle.
 * @returns The outcome: "exists" | "provisioned" | "degraded".
 * @example
 * ```ts
 * const outcome = await ensureTurnKey(resource, { accountId, scriptName, apiToken, note });
 * ```
 */
export const ensureTurnKey = async (
  resource: TurnManifest,
  deps: TurnDeps
): Promise<TurnOutcome> => {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // No token → nothing to list or mint with; one instruction line, the deploy continues.
  const token = deps.apiToken;
  if (token === undefined || token === "") {
    deps.note(turnInstruction(resource));
    return "degraded";
  }

  // Idempotence: both secrets already bound → nothing to do (a redeploy is a fast read-only check).
  const bound = await listSecretNames(deps, token);
  if (bound === undefined) {
    deps.note(turnInstruction(resource));
    return "degraded";
  }
  if (bound.includes(resource.keyIdBinding) && bound.includes(resource.apiTokenBinding)) {
    deps.note(`TURN key "${resource.name}": already provisioned (secrets bound).`);
    return "exists";
  }

  // Create the key — the response's `key` is the secret, returned exactly once. Bind both NOW.
  const created = await cfCall<{ uid?: unknown; key?: unknown }>(
    token,
    "POST",
    `/accounts/${deps.accountId}/calls/turn_keys`,
    { name: resource.name },
    fetchImpl
  );
  const uid = created?.uid;
  const key = created?.key;
  if (typeof uid !== "string" || uid === "" || typeof key !== "string" || key === "") {
    deps.note(turnInstruction(resource));
    return "degraded";
  }

  const boundId = await putSecret(deps, token, resource.keyIdBinding, uid);
  const boundKey = await putSecret(deps, token, resource.apiTokenBinding, key);
  if (!boundId || !boundKey) {
    // A torn push heals on the next deploy (half-bound → a fresh key is minted + fully re-bound).
    deps.note(turnInstruction(resource));
    return "degraded";
  }

  deps.note(`TURN key "${resource.name}" provisioned (key created + secrets bound).`);
  return "provisioned";
};
