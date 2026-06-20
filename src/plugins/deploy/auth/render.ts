/**
 * @file deploy plugin — branded `auth setup` renderer (panels + color).
 *
 * Turns the derived token requirement into branded panels — the box / heading / palette brand DNA —
 * so the "which token, which permissions" guidance reads as designed UI instead of a wall of text.
 * Shared by the guided deploy (auth recovery) and the `auth setup` command so both look identical.
 * Pure: takes a {@link BrandConsole} + structured data and renders. Node-only; never in the bundle.
 */
import type { BrandConsole } from "@moku-labs/common/cli";
import type { PermissionGroup, TokenRequirement } from "../types";

/** Cloudflare's dashboard path for creating API tokens. */
const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Render one permission as a framed row. With the template flag on (the LOCAL panel) a green `✓`
 * marks a permission the stock template already includes and a pink `+ ← add to template` marks one
 * the user must add; with it off (the CI panel) every row is a neutral bullet. Scope bold, reason dim.
 *
 * @param ui - The branded console (for its palette).
 * @param permission - The permission group to render.
 * @param showTemplateFlag - Whether to mark template-vs-add (LOCAL) or use a neutral bullet (CI).
 * @returns The rendered (colorized) row, ready to drop into a box.
 * @example
 * ```ts
 * permissionRow(ui, { group: "Account · D1", scope: "Edit", reason: "d1", inBaseTemplate: false }, true);
 * ```
 */
const permissionRow = (
  ui: BrandConsole,
  permission: PermissionGroup,
  showTemplateFlag: boolean
): string => {
  const { palette } = ui;

  const templateMark = permission.inBaseTemplate ? palette.green("✓") : palette.pink("+");
  const mark = showTemplateFlag ? templateMark : palette.dim("•");
  const flag =
    showTemplateFlag && !permission.inBaseTemplate ? palette.pink("  ← add to template") : "";
  const reason = palette.dim(`(${permission.reason})`);

  return `${mark} ${permission.group} : ${palette.bold(permission.scope)}  ${reason}${flag}`;
};

/**
 * Render the LOCAL (first deploy) token panel: the full permission set with template/add markers,
 * then the numbered create-token steps (URL cyan, template + `.env.local` bold).
 *
 * @param ui - The branded console to render through.
 * @param requirement - The LOCAL token requirement (from requiredToken()).
 * @example
 * ```ts
 * localPanel(ui, requiredToken(manifest));
 * ```
 */
const localPanel = (ui: BrandConsole, requirement: TokenRequirement): void => {
  const { palette } = ui;

  // Step 3 only asks for additions when the stock template is actually missing something.
  const adds = requirement.toAdd
    .map(permission => `${permission.group.replace("Account · ", "")} → ${permission.scope}`)
    .join(", ");
  const coversAll = palette.dim(`The "${requirement.base}" template covers everything.`);
  const addStep =
    requirement.toAdd.length > 0 ? `  3. ADD ${palette.pink(adds)}` : `  3. ${coversAll}`;
  const template = palette.bold(`"${requirement.base}"`);

  ui.box([
    palette.bold("LOCAL — first deploy (creates your infra)"),
    "",
    ...requirement.required.map(permission => permissionRow(ui, permission, true)),
    "",
    `  1. ${palette.cyan(TOKENS_URL)}`,
    `  2. Create Token → start from the ${template} template.`,
    addStep,
    "  4. Account Resources → Include → your account.",
    `  5. Create it, copy it, then paste into ${palette.bold(".env.local")} (below).`
  ]);
};

/**
 * Render the compact CI (automation redeploy) token panel: the reduced, read-mostly permission set
 * for a later Custom Token. No template markers — CI builds a token from scratch, not the template.
 *
 * @param ui - The branded console to render through.
 * @param groups - The CI token permission groups (from ciToken()).
 * @example
 * ```ts
 * ciPanel(ui, ciToken(manifest));
 * ```
 */
const ciPanel = (ui: BrandConsole, groups: PermissionGroup[]): void => {
  const { palette } = ui;

  ui.box([
    palette.bold("CI — automation redeploy (optional, later)"),
    "",
    ...groups.map(permission => permissionRow(ui, permission, false)),
    "",
    palette.dim("Create a Custom Token with exactly these (Read, not Edit, on data)."),
    palette.dim("Store as the CLOUDFLARE_API_TOKEN secret; pin CLOUDFLARE_ACCOUNT_ID.")
  ]);
};

/**
 * Render the full branded `auth setup` guidance: a heading, the LOCAL token panel (what to create
 * now), and — when `opts.ci` is supplied — the compact CI panel; otherwise a one-line pointer to
 * `auth setup` for the CI token (so the guided deploy stays focused on the immediate next step).
 *
 * @param ui - The branded console to render through.
 * @param requirement - The LOCAL token requirement (from requiredToken()).
 * @param opts - Optional rendering options.
 * @param opts.ci - The CI token permission groups (from ciToken()); omit to show a pointer instead.
 * @example
 * ```ts
 * renderAuthSetup(ui, requiredToken(manifest));                     // guided deploy (LOCAL only)
 * renderAuthSetup(ui, requiredToken(manifest), { ci: ciToken(m) }); // `auth setup` (LOCAL + CI)
 * ```
 */
export const renderAuthSetup = (
  ui: BrandConsole,
  requirement: TokenRequirement,
  opts?: { ci?: PermissionGroup[] }
): void => {
  ui.heading("Cloudflare API token");
  localPanel(ui, requirement);

  if (opts?.ci) {
    ciPanel(ui, opts.ci);
  } else {
    ui.line(ui.palette.dim("  Need a CI token later? Run `auth setup` for the reduced set."));
  }
};
