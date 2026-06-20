/**
 * @file deploy plugin — `auth setup` guidance renderer (pure).
 *
 * Turns the app's manifest into copy-pasteable token instructions: the FULL local-first token
 * (start from the stock template, add D1/Queues) for the deploy that provisions everything, AND the
 * REDUCED CI/automation token (redeploy-only, account pinned) for GitHub Actions and friends. No
 * network — this is what you run BEFORE you have a token. Node-only; never in the runtime bundle.
 */
import type { ExternalManifest, PermissionGroup, TokenRequirement } from "../types";
import { ciToken, requiredToken } from "./permissions";

/** Cloudflare's dashboard path for creating API tokens. */
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Render the FULL local-first token section (the deploy that provisions everything): the permission
 * table flagging template-missing rows, the template + "add these" steps, and the `.env.local` lines.
 *
 * @param requirement - The full token requirement (from requiredToken()).
 * @returns The local-first section lines.
 * @example
 * ```ts
 * const lines = localSection(requiredToken(manifest));
 * ```
 */
const localSection = (requirement: TokenRequirement): string[] => {
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
    "LOCAL — first deploy (provisions infra). A Cloudflare API token with these permissions:",
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
  ];
};

/**
 * Render the REDUCED CI/automation token section (redeploy-only): the scoped permission table plus
 * the CI-secret + account-pin steps.
 *
 * @param groups - The CI permission groups (from ciToken()).
 * @returns The CI section lines.
 * @example
 * ```ts
 * const lines = ciSection(ciToken(manifest));
 * ```
 */
const ciSection = (groups: PermissionGroup[]): string[] => {
  const permissionRows = groups.map(
    permission => `  - ${permission.group} : ${permission.scope}   (${permission.reason})`
  );

  return [
    "CI — automation redeploy (infra already provisioned by a local deploy). A SCOPED token with:",
    "",
    ...permissionRows,
    "",
    `  1. ${TOKENS_URL}  ->  Create Token  ->  Create Custom Token.`,
    "  2. Add exactly the permissions above (Read, not Edit, on data resources — CI never creates).",
    "  3. Account Resources -> Include -> your account.",
    "  4. Store it as the CLOUDFLARE_API_TOKEN secret in CI, and PIN the account so no account",
    "     lookup (and no Account Settings -> Read) is needed:",
    "       CLOUDFLARE_ACCOUNT_ID=<your account id>",
    "  CI reuses the same idempotent pipeline — it lists existing infra and ships. To let CI also",
    "  CREATE missing infra (self-heal), give it the LOCAL token above instead."
  ];
};

/**
 * Render the `auth setup` instructions from the app manifest: the FULL local-first token (provisions
 * everything) followed by the REDUCED CI/automation token (redeploy-only).
 *
 * @param manifest - The assembled deploy manifest.
 * @returns A multi-line instruction string covering both tokens.
 * @example
 * ```ts
 * const text = tokenInstructions(manifest);
 * ```
 */
export const tokenInstructions = (manifest: ExternalManifest): string =>
  [...localSection(requiredToken(manifest)), "", ...ciSection(ciToken(manifest))].join("\n");

/**
 * Render a ready-to-fill `.env.local` for the guided deploy: the two Cloudflare credential keys
 * (left blank to paste into) preceded by a comment block derived from the manifest — where to
 * create the token, which template to start from, exactly which permissions to add, and how to find
 * the account id. The same guidance {@link tokenInstructions} prints, but PERSISTED in the file the
 * user edits (so it survives the terminal scrolling away). Pure: no fs, no network.
 *
 * @param manifest - The assembled deploy manifest.
 * @returns The `.env.local` file contents (trailing newline included).
 * @example
 * ```ts
 * await writeFile(".env.local", envLocalScaffold(manifest));
 * ```
 */
export const envLocalScaffold = (manifest: ExternalManifest): string => {
  const requirement = requiredToken(manifest);

  // Step 3 only asks for additions when the stock template is actually missing something.
  const addStep =
    requirement.toAdd.length > 0
      ? `#   3. Under Permissions, ADD: ${requirement.toAdd
          .map(permission => `${permission.group.replace("Account · ", "")} -> ${permission.scope}`)
          .join(", ")}`
      : `#   3. The "${requirement.base}" template covers everything — no changes needed.`;

  const lines = [
    "# Cloudflare credentials for the moku deploy — fill in the two values below, then re-run deploy.",
    "# Local-only: keep this file out of git (.env.local is gitignored by convention).",
    "#",
    "# Create the API token:",
    `#   1. ${TOKENS_URL}  ->  Create Token`,
    `#   2. Start from the "${requirement.base}" template.`,
    addStep,
    "#   4. Account Resources -> Include -> your account.",
    "#   5. Create the token, copy it, and paste it after CLOUDFLARE_API_TOKEN= below.",
    "#",
    "# Account id: open https://dash.cloudflare.com — it is the id in the URL",
    "# (dash.cloudflare.com/<account-id>) or in the right sidebar of any domain's overview.",
    "",
    "CLOUDFLARE_API_TOKEN=",
    "CLOUDFLARE_ACCOUNT_ID="
  ];

  return `${lines.join("\n")}\n`;
};
