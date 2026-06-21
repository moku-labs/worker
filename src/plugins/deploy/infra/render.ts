/**
 * @file deploy plugin — branded infra panels (plan + provision result).
 *
 * Renders the infra preflight plan (what will be created vs already exists) and the provision result
 * (what was created / skipped / failed) as branded boxes — the same box/heading/palette brand DNA as
 * the `auth setup` panels — so the guided deploy shows a clear, designed status instead of a stream
 * of flat lines. Pure: takes a {@link BrandConsole} + structured data. Node-only; not in the bundle.
 */
import type { BrandConsole } from "@moku-labs/common/cli";
import type { InfraPlan, ProvisionResult, ResourceManifest } from "../types";

/**
 * Derive a human-readable name from a resource descriptor: the Cloudflare resource `name` for the
 * provisioned kinds (kv/r2/d1/queue), or the exported `className` for a Durable Object (which has no
 * provisioned name). Used in both the provision events and the branded panels so the two agree.
 *
 * @param resource - The resource descriptor.
 * @returns A short name identifying the resource.
 * @example
 * ```ts
 * resourceName({ kind: "kv", name: "tracker-cache", binding: "CACHE" }); // "tracker-cache"
 * ```
 */
export const resourceName = (resource: ResourceManifest): string =>
  resource.kind === "do" ? resource.className : resource.name;

/**
 * Format a `kind name` cell, padding the kind so the names line up in a column.
 *
 * @param kind - The resource kind (kv / r2 / d1 / queue / do).
 * @param name - The resource name.
 * @returns The aligned `kind  name` cell.
 * @example
 * ```ts
 * cell("kv", "CACHE"); // "kv     CACHE"
 * ```
 */
const cell = (kind: string, name: string): string => `${kind.padEnd(6)}${name}`;

/**
 * Row tag for a Durable Object — it ships with the Worker (`wrangler deploy` creates the namespace),
 * so it is NEVER labelled `(exists)` (the planner never queried the account for it). Shared by the
 * plan and provision-result panels so the two always read the same.
 */
const SHIPS_WITH_WORKER = "(ships with worker)";

/**
 * ANSI SGR matcher — built from `String.fromCharCode(27)` (the ESC byte) so no control character
 * appears in a regex literal (which both linters reject).
 */
const ANSI_SGR = new RegExp(String.raw`${String.fromCodePoint(27)}\[[0-9;]*m`, "gu");

/**
 * Strip ANSI SGR escape sequences so a captured (colorized) error renders as plain, readable text.
 *
 * @param text - The (possibly colorized) text.
 * @returns The text with ANSI color codes removed.
 * @example
 * ```ts
 * stripAnsi(`${String.fromCharCode(27)}[31mX${String.fromCharCode(27)}[0m`); // "X"
 * ```
 */
const stripAnsi = (text: string): string => text.replaceAll(ANSI_SGR, "");

/**
 * Clean a captured (colorized, multi-line, wrapper-wrapped) provision error down to its meaningful
 * text: strip ANSI, drop the wrapper lines (the branded prefix, wrangler's log-file pointer), strip
 * each `✘ [ERROR]` marker, and join what's left. Returns the FULL message (the caller word-wraps it)
 * so the user reads the actual reason — never a truncated `…`.
 *
 * @param message - The captured error message.
 * @returns The full, plain failure reason.
 * @example
 * ```ts
 * cleanError("[moku-worker] wrangler exited…\n  ✘ [ERROR] The bucket name is invalid.");
 * // "The bucket name is invalid."
 * ```
 */
const cleanError = (message: string): string => {
  const lines = stripAnsi(message)
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !/^\[moku-worker\]/u.test(line)) // our own wrangler-exit wrapper
    .filter(line => !/logs were written to/iu.test(line)) // wrangler's log-file pointer
    .map(line => line.replace(/^✘\s*/u, "").replace(/^\[error\]\s*/iu, ""));
  const cleaned = lines.join(" ");
  return cleaned.length > 0 ? cleaned : stripAnsi(message).trim();
};

/**
 * Word-wrap text to `width` columns (never splitting inside a word), so a long failure reason reads
 * as a tidy indented block instead of forcing the box wide or scrolling off the edge.
 *
 * @param text - The text to wrap.
 * @param width - The maximum column width per line.
 * @returns The wrapped lines.
 * @example
 * ```ts
 * wrapText("a long sentence to wrap", 10); // ["a long", "sentence", "to wrap"]
 * ```
 */
const wrapText = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
};

/**
 * Render the infra preflight plan as a branded panel: a dim summary line (counts + account) then one
 * row per declared resource — a pink `+` for those to create, a dim `~ (exists)` for those already
 * present, and a dim `~ (ships with worker)` for Durable Objects (created by `wrangler deploy`, never
 * pre-provisioned). When nothing needs creating it still renders, so the user sees the full picture.
 *
 * @param ui - The branded console to render through.
 * @param plan - The infra plan (existing vs missing vs ships-with-Worker) from checkInfra()/planInfra().
 * @example
 * ```ts
 * renderPlan(ui, await planInfra(ctx, manifest));
 * ```
 */
export const renderPlan = (ui: BrandConsole, plan: InfraPlan): void => {
  const { palette } = ui;

  const counts = [
    `${String(plan.missing.length)} to create`,
    `${String(plan.exists.length)} exist`
  ];
  if (plan.ships.length > 0) counts.push(`${String(plan.ships.length)} with worker`);
  const summary = palette.dim(`${counts.join(" · ")} · ${plan.account}`);

  const createRows = plan.missing.map(
    resource => `${palette.pink("+")} ${cell(resource.kind, resourceName(resource))}`
  );
  const existsRows = plan.exists.map(
    ref =>
      `${palette.dim("~")} ${cell(ref.resource.kind, resourceName(ref.resource))} ${palette.dim("(exists)")}`
  );
  const shipsRows = plan.ships.map(
    resource =>
      `${palette.dim("~")} ${cell(resource.kind, resourceName(resource))} ${palette.dim(SHIPS_WITH_WORKER)}`
  );

  ui.heading("Infra plan");
  ui.box([summary, "", ...createRows, ...existsRows, ...shipsRows]);
};

/**
 * Render the provision result as a branded panel — a green `✓` per created resource, a dim `~` per
 * skipped, a dim `~ (ships with worker)` per Durable Object, a red `✗` per failure, then a summary
 * line (failed count red when non-zero) — followed, when anything failed, by a detail block printing
 * each failure's FULL reason (ANSI-stripped and word-wrapped) so it is actually readable instead of
 * truncated inside the box.
 *
 * @param ui - The branded console to render through.
 * @param result - The provision result from provisionInfra()/the deploy pipeline.
 * @example
 * ```ts
 * renderProvisionResult(ui, await provisionInfra(plan));
 * ```
 */
export const renderProvisionResult = (ui: BrandConsole, result: ProvisionResult): void => {
  const { palette } = ui;

  // Box rows stay short (kind + name only) so the box never balloons to a long error's width.
  const createdRows = result.created.map(
    ref => `${palette.green("✓")} ${cell(ref.resource.kind, resourceName(ref.resource))}`
  );
  const skippedRows = result.skipped.map(
    ref =>
      `${palette.dim("~")} ${cell(ref.resource.kind, resourceName(ref.resource))} ${palette.dim("(exists)")}`
  );
  const bundledRows = result.bundled.map(
    resource =>
      `${palette.dim("~")} ${cell(resource.kind, resourceName(resource))} ${palette.dim(SHIPS_WITH_WORKER)}`
  );
  const failedRows = result.failed.map(
    failure => `${palette.red("✗")} ${cell(failure.resource.kind, resourceName(failure.resource))}`
  );

  const failedCount =
    result.failed.length > 0 ? palette.red(`${String(result.failed.length)} failed`) : "0 failed";
  const counts = [
    `${String(result.created.length)} created`,
    `${String(result.skipped.length)} exist`
  ];
  if (result.bundled.length > 0) counts.push(`${String(result.bundled.length)} with worker`);
  const summary = `${counts.join(" · ")} · ${failedCount}`;

  ui.heading("Provisioned");
  ui.box([...createdRows, ...skippedRows, ...bundledRows, ...failedRows, "", summary]);

  // Full, readable failure detail under the box — each reason word-wrapped to the console width.
  if (result.failed.length > 0) {
    ui.line();
    for (const failure of result.failed) {
      ui.line(
        `  ${palette.red("✗")} ${cell(failure.resource.kind, resourceName(failure.resource))}`
      );
      for (const wrapped of wrapText(cleanError(failure.error), ui.width - 4)) {
        ui.line(palette.dim(`    ${wrapped}`));
      }
    }
  }
};

/**
 * Format an elapsed duration compactly: sub-second as `820ms`, otherwise one-decimal seconds (`4.2s`),
 * and minutes once it crosses 60s (`1m04s`) so a long deploy stays readable.
 *
 * @param ms - The elapsed milliseconds.
 * @returns The compact duration string.
 * @example
 * ```ts
 * formatDuration(4234); // "4.2s"
 * ```
 */
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60))}m${String(whole % 60).padStart(2, "0")}s`;
};

/**
 * Render the terminal deploy summary as a branded panel — the headline the user actually wants. The
 * live URL leads on its own line (pink, so it is the first thing the eye lands on), then a dim
 * key/value block: the target stage, the resource tally (with a red `failed` count when non-zero),
 * and the wall-clock time the whole deploy took. Replaces the prior single `deployed → url` line.
 *
 * @param ui - The branded console to render through.
 * @param summary - The deploy summary fields.
 * @param summary.url - The live deployed URL (the panel headline).
 * @param summary.stage - The target stage the worker deployed to.
 * @param summary.created - How many resources were created this run.
 * @param summary.exists - How many resources already existed (skipped).
 * @param summary.bundled - How many Durable Objects shipped with the Worker.
 * @param summary.failed - How many resources failed to provision.
 * @param summary.elapsedMs - The wall-clock deploy duration in milliseconds.
 * @example
 * ```ts
 * renderDeploySummary(ui, { url, stage: "production", created: 0, exists: 5, bundled: 1, failed: 0, elapsedMs: 4234 });
 * ```
 */
export const renderDeploySummary = (
  ui: BrandConsole,
  summary: {
    url: string;
    stage: string;
    created: number;
    exists: number;
    bundled: number;
    failed: number;
    elapsedMs: number;
  }
): void => {
  const { palette } = ui;

  const parts = [`${String(summary.exists)} exist`, `${String(summary.created)} created`];
  if (summary.bundled > 0) parts.push(`${String(summary.bundled)} with worker`);
  const tally = parts.join(" · ");
  const failedLabel = palette.red(`${String(summary.failed)} failed`);
  const resources = summary.failed > 0 ? `${tally} · ${failedLabel}` : tally;

  ui.heading("Deployed");
  ui.box([
    palette.pink(summary.url),
    "",
    `${palette.dim("stage".padEnd(10))}${summary.stage}`,
    `${palette.dim("resources".padEnd(10))}${resources}`,
    `${palette.dim("took".padEnd(10))}${formatDuration(summary.elapsedMs)}`
  ]);
};
