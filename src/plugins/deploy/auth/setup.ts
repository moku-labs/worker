/**
 * @file deploy plugin — `auth setup` guidance renderer (pure).
 *
 * Turns a derived TokenRequirement into copy-pasteable instructions: the permission table, the
 * "start from template X, then ADD …" steps (only the groups missing from the stock template are
 * flagged), and the `.env.local` lines. No network — this is the command you run BEFORE you have
 * a token. Node-only; never imported by the runtime Worker bundle.
 */
import type { TokenRequirement } from "../types";

/** Cloudflare's dashboard path for creating API tokens. */
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Render the `auth setup` instructions from a token requirement.
 *
 * @param requirement - The derived token requirement (from requiredToken()).
 * @returns A multi-line instruction string.
 * @example
 * ```ts
 * const text = tokenInstructions(requiredToken(manifest));
 * ```
 */
export const tokenInstructions = (requirement: TokenRequirement): string => {
  // Permission table — flag the rows the stock template does not include.
  const permissionRows = requirement.required.map(permission => {
    const flag = permission.inBaseTemplate ? "" : "   <- add to template";
    return `  - ${permission.group} : ${permission.scope}   (${permission.reason})${flag}`;
  });

  // Step 3 only asks for additions when the template is actually missing something.
  const step3 =
    requirement.toAdd.length > 0
      ? [
          `  3. Under Permissions, ADD: ${requirement.toAdd
            .map(
              permission => `${permission.group.replace("Account · ", "")} -> ${permission.scope}`
            )
            .join(", ")}`,
          "     (the template omits these; everything else is already included)"
        ]
      : [`  3. The "${requirement.base}" template covers everything — no changes needed.`];

  return [
    "This app needs a Cloudflare API token with these permissions:",
    "",
    ...permissionRows,
    "",
    "Fastest path:",
    `  1. ${TOKENS_URL}  ->  Create Token`,
    `  2. Start from the "${requirement.base}" template.`,
    ...step3,
    "  4. Account Resources -> Include -> your account.",
    "  5. Create the token, copy it, then add it to .env.local:",
    "       CLOUDFLARE_API_TOKEN=<paste your token>",
    "       CLOUDFLARE_ACCOUNT_ID=<your account id>",
    "  6. Verify it with `auth` (app.deploy.verifyAuth())."
  ].join("\n");
};
