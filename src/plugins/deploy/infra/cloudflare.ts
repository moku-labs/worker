/**
 * @file deploy plugin — Cloudflare REST discovery client (infra preflight).
 *
 * Lists what already exists in a Cloudflare account so the deploy pipeline can create only the
 * missing resources (idempotent provisioning) and recover real ids for existing kv/d1 bindings.
 * Authenticated with the `.env` API token (CLOUDFLARE_API_TOKEN) — never an interactive login.
 * Uses the global `fetch`; node-only, never imported by the runtime Worker bundle.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Cloudflare API response envelope (the `result` shape varies per endpoint). */
type CfEnvelope = {
  success: boolean;
  result: unknown;
  errors?: Array<{ message: string }>;
};

/**
 * GET a Cloudflare API path with the bearer token and unwrap the `result`.
 *
 * @param token - The Cloudflare API token (CLOUDFLARE_API_TOKEN).
 * @param path - API path beneath the v4 base (e.g. "/accounts").
 * @returns The unwrapped `result` payload, typed by the caller.
 * @throws {Error} When the HTTP request fails or the API reports `success: false`.
 * @example
 * ```ts
 * const accounts = await cfGet<Array<{ id: string }>>(token, "/accounts");
 * ```
 */
const cfGet = async <T>(token: string, path: string): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  });

  const body = (await response.json()) as CfEnvelope;
  if (!response.ok || !body.success) {
    const detail = body.errors?.map(error => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`[moku-worker] Cloudflare API request failed (${path}): ${detail}`);
  }

  return body.result as T;
};

/**
 * Resolve the Cloudflare account (id + display name) accessible to the token. Used when the
 * consumer did not pin CLOUDFLARE_ACCOUNT_ID; the first accessible account is chosen.
 *
 * @param token - The Cloudflare API token.
 * @returns The resolved account id and name.
 * @throws {Error} When the token can access no account.
 * @example
 * ```ts
 * const { id, name } = await resolveAccount(token);
 * ```
 */
export const resolveAccount = async (token: string): Promise<{ id: string; name: string }> => {
  const accounts = await cfGet<Array<{ id: string; name: string }>>(token, "/accounts");
  const first = accounts[0];
  if (!first) {
    throw new Error("[moku-worker] No Cloudflare account is accessible with this API token.");
  }
  return { id: first.id, name: first.name };
};

/**
 * The set of resources that already exist in the account, indexed for fast lookup:
 * kv/d1 map their identity to the captured id; r2/queue track existence by name.
 */
export type ExistingResources = {
  /** Existing KV namespaces: title → namespace id. */
  kv: Map<string, string>;
  /** Existing D1 databases: name → database id (uuid). */
  d1: Map<string, string>;
  /** Existing R2 bucket names. */
  r2: Set<string>;
  /** Existing queue names. */
  queue: Set<string>;
};

/**
 * List every kv / d1 / r2 / queue resource that already exists in the account (one request per
 * kind, in parallel), indexed for the preflight diff.
 *
 * @param token - The Cloudflare API token.
 * @param accountId - The Cloudflare account id to scope the listings to.
 * @returns The existing resources, indexed by kind.
 * @throws {Error} When any listing request fails.
 * @example
 * ```ts
 * const existing = await listExisting(token, accountId);
 * if (existing.kv.has("SESSIONS")) { ... }
 * ```
 */
export const listExisting = async (
  token: string,
  accountId: string
): Promise<ExistingResources> => {
  const base = `/accounts/${accountId}`;
  const [kv, d1, r2, queues] = await Promise.all([
    cfGet<Array<{ id: string; title: string }>>(token, `${base}/storage/kv/namespaces`),
    cfGet<Array<{ uuid: string; name: string }>>(token, `${base}/d1/database`),
    cfGet<{ buckets?: Array<{ name: string }> }>(token, `${base}/r2/buckets`),
    cfGet<Array<{ queue_name: string }>>(token, `${base}/queues`)
  ]);

  return {
    kv: new Map(kv.map(namespace => [namespace.title, namespace.id])),
    d1: new Map(d1.map(database => [database.name, database.uuid])),
    r2: new Set((r2.buckets ?? []).map(bucket => bucket.name)),
    queue: new Set(queues.map(queue => queue.queue_name))
  };
};
