/**
 * @file deploy plugin — `.env` token verification + account resolution.
 *
 * Reads CLOUDFLARE_API_TOKEN via ctx.env, verifies it is active against the Cloudflare API, and
 * resolves the account. Emits auth:verified. Throws a branded, actionable error (pointing at
 * `auth setup`) when the token is absent, invalid, or inactive — never an interactive login.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { resolveAccount, verifyToken } from "../infra/cloudflare";
import type { AuthStatus, Ctx } from "../types";

/** Branded hint appended to every auth failure so the user knows the next step. */
const SETUP_HINT = "Run `auth setup` for the exact token to create.";

/**
 * Verify the `.env` Cloudflare API token and resolve its account.
 *
 * @param ctx - The deploy plugin context (env + emit).
 * @returns The verified auth status (account + id).
 * @throws {Error} When the token is absent, invalid/expired, or not active.
 * @example
 * ```ts
 * const { account, accountId } = await verifyAuth(ctx);
 * ```
 */
export const verifyAuth = async (ctx: Ctx): Promise<AuthStatus> => {
  const token = ctx.env.get("CLOUDFLARE_API_TOKEN");
  if (token === undefined || token === "") {
    throw new Error(`[worker] CLOUDFLARE_API_TOKEN is not set. ${SETUP_HINT}`);
  }

  // Verify the token is usable (cfGet throws on a rejected token; we re-brand it).
  let status: string;
  try {
    ({ status } = await verifyToken(token));
  } catch (error) {
    throw new Error(`[worker] Cloudflare API token is invalid or expired. ${SETUP_HINT}`, {
      cause: error
    });
  }
  if (status !== "active") {
    throw new Error(`[worker] Cloudflare API token is "${status}", not active. ${SETUP_HINT}`);
  }

  // Use a pinned account id when provided; else resolve the first accessible account.
  const pinnedAccountId = ctx.env.get("CLOUDFLARE_ACCOUNT_ID");
  const account =
    pinnedAccountId === undefined || pinnedAccountId === ""
      ? await resolveAccount(token)
      : { id: pinnedAccountId, name: pinnedAccountId };

  ctx.emit("auth:verified", { account: account.name, accountId: account.id, scopes: [] });
  return { ok: true, account: account.name, accountId: account.id, scopes: [] };
};
