/**
 * @file deploy plugin — shared D1 seed helpers (resolve the target db, run a configured seed).
 *
 * Pure orchestration over an INJECTED wrangler runner, so the post-deploy REMOTE seed (api.ts) and
 * the dev-session LOCAL seed (dev/runner.ts) stay in lockstep — same file, same KV-reset semantics,
 * differing only in the `--remote` / `--local` scope. Migrations are NOT applied here: each caller
 * applies the schema first (the deploy's migration step / dev's local-migrate step), then seeds.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { d1Plugin } from "../d1";
import type { Ctx, ResourceManifest, SeedConfig, SeedOutcome } from "./types";

/** A one-shot wrangler runner; when it CAPTURES output its resolved string is parsed for seed stats. */
export type RunWrangler = (args: string[]) => Promise<unknown>;

/**
 * Parse the best-effort row/statement counts from wrangler's `d1 execute` output so the branded seed
 * panel can report them — degrading gracefully (each field simply omitted) when wrangler's format
 * differs or the runner streamed instead of captured. Wrangler prints lines like "🚣 18 commands
 * executed" and a rows-written total; both are matched loosely (case-insensitive).
 *
 * @param output - The captured stdout from `wrangler d1 execute` (empty when the runner streamed).
 * @returns The parsed counts — each field present only when found.
 * @example
 * ```ts
 * parseSeedStats("🚣 18 commands executed (30 rows written)"); // { statements: 18, rowsWritten: 30 }
 * ```
 */
export const parseSeedStats = (output: string): { statements?: number; rowsWritten?: number } => {
  // Single-space literals (wrangler's summary line uses them) keep these linear — no `\s+` backtracking.
  // The command count is matched in either word order: "N commands executed" or "Executed N commands".
  const rows = /(\d{1,12}) rows? written/iu.exec(output);
  const commands =
    /(\d{1,12}) commands? executed/iu.exec(output) ??
    /executed (\d{1,12}) commands?/iu.exec(output);

  const result: { statements?: number; rowsWritten?: number } = {};
  if (commands?.[1] !== undefined) result.statements = Number(commands[1]);
  if (rows?.[1] !== undefined) result.rowsWritten = Number(rows[1]);
  return result;
};

/**
 * Parse which migrations wrangler applied from its captured `d1 migrations apply` output, so the
 * branded migrate panel can name them instead of dumping wrangler's raw migration TUI. `upToDate` is
 * true when wrangler reported nothing pending ("No migrations to apply"); otherwise every
 * `NNNN_name.sql` filename token in the output is collected in order (de-duplicated). Degrades
 * safely — an unrecognized format yields no names, and the panel falls back to a generic "applied".
 * Lives here (not in api.ts) so both the deploy path and the dev path parse it without a cycle.
 *
 * @param output - The captured stdout from `wrangler d1 migrations apply`.
 * @returns The applied migration filenames and whether the database was already up to date.
 * @example
 * ```ts
 * parseMigrationsApplied("Applied 0003_x.sql\n0004_y.sql"); // { applied: ["0003_x.sql", "0004_y.sql"], upToDate: false }
 * ```
 */
export const parseMigrationsApplied = (
  output: string
): { applied: string[]; upToDate: boolean } => {
  if (/no migrations to apply/iu.test(output)) {
    return { applied: [], upToDate: true };
  }

  const applied: string[] = [];
  const seen = new Set<string>();
  for (const match of output.matchAll(/\b\d{3,}_[A-Za-z0-9_-]+\.sql\b/gu)) {
    const name = match[0];
    if (!seen.has(name)) {
      seen.add(name);
      applied.push(name);
    }
  }
  return { applied, upToDate: false };
};

/**
 * Resolve the single configured d1 database (or the one bound to `binding` when several exist) from
 * the d1 plugin's manifest. The shared resolver behind `seed()`, the post-deploy seed, and the dev
 * seed; throws a branded error when the choice is ambiguous (none/several, no binding) or unknown.
 *
 * @param ctx - The deploy plugin context.
 * @param binding - The d1 binding to target when more than one is configured; the sole one otherwise.
 * @returns The resolved d1 resource descriptor (its binding + optional migrations dir).
 * @throws {Error} When no single database resolves (none/several without a binding, or unknown binding).
 * @example
 * ```ts
 * const db = resolveD1(ctx, "DB");
 * ```
 */
export const resolveD1 = (
  ctx: Ctx,
  binding?: string
): Extract<ResourceManifest, { kind: "d1" }> => {
  const databases = ctx.require(d1Plugin).deployManifest();
  const matched =
    binding === undefined ? databases : databases.filter(db => db.binding === binding);
  const target = matched.length === 1 ? matched[0] : undefined;

  if (target === undefined) {
    throw new Error(
      binding === undefined
        ? `[worker] seed: ${String(databases.length)} d1 databases configured — pass { binding } to choose one.`
        : `[worker] seed: no d1 database is bound to "${binding}".`
    );
  }
  return target;
};

/**
 * Run a configured seed against one scope: execute the seed SQL against the d1 database, then delete
 * each configured cached KV key so the next read rebuilds it from the freshly-seeded rows. The
 * schema is assumed to exist (the caller applies migrations first), so this never migrates. The
 * wrangler runner is injected so the same orchestration serves the streamed deploy path and the
 * injectable dev path.
 *
 * @param ctx - The deploy plugin context.
 * @param run - The wrangler runner to execute each command through (a CAPTURING runner lets the
 *   returned outcome report row/statement counts; a streaming one still works, just without them).
 * @param seed - The resolved seed config (SQL file, optional binding, KV keys to reset).
 * @param scope - The wrangler scope: `--remote` (deploy) or `--local` (dev).
 * @returns The seed outcome (file, target binding, best-effort counts, and the KV keys that were reset).
 * @throws {Error} When no d1 database is configured, or the seed's binding cannot be resolved.
 * @example
 * ```ts
 * const outcome = await runConfiguredSeed(ctx, runWrangler, ctx.config.seed, "--remote");
 * ```
 */
export const runConfiguredSeed = async (
  ctx: Ctx,
  run: RunWrangler,
  seed: SeedConfig,
  scope: "--remote" | "--local"
): Promise<SeedOutcome> => {
  if (!ctx.has("d1")) {
    throw new Error("[worker] seed: no d1 database is configured.");
  }

  const database = resolveD1(ctx, seed.binding);
  const executed = await run(["d1", "execute", database.binding, scope, "--file", seed.file]);

  // Clear each cached KV key so the next read rebuilds it from the freshly-seeded rows.
  const resetKv = seed.resetKv ?? [];
  for (const entry of resetKv) {
    await run(["kv", "key", "delete", entry.key, "--binding", entry.binding, scope]);
  }

  return {
    file: seed.file,
    binding: database.binding,
    resetKv,
    ...parseSeedStats(typeof executed === "string" ? executed : "")
  };
};
