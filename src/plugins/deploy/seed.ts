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
import type { Ctx, ResourceManifest, SeedConfig } from "./types";

/** A one-shot wrangler runner (streams or inherits — its return value is unused by the seed steps). */
export type RunWrangler = (args: string[]) => Promise<unknown>;

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
        ? `[moku-worker] seed: ${String(databases.length)} d1 databases configured — pass { binding } to choose one.`
        : `[moku-worker] seed: no d1 database is bound to "${binding}".`
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
 * @param run - The wrangler runner to execute each command through.
 * @param seed - The resolved seed config (SQL file, optional binding, KV keys to reset).
 * @param scope - The wrangler scope: `--remote` (deploy) or `--local` (dev).
 * @returns Resolves once the seed file has executed and every cached KV key is cleared.
 * @throws {Error} When no d1 database is configured, or the seed's binding cannot be resolved.
 * @example
 * ```ts
 * await runConfiguredSeed(ctx, runWranglerInherit, ctx.config.seed, "--remote");
 * ```
 */
export const runConfiguredSeed = async (
  ctx: Ctx,
  run: RunWrangler,
  seed: SeedConfig,
  scope: "--remote" | "--local"
): Promise<void> => {
  if (!ctx.has("d1")) {
    throw new Error("[moku-worker] seed: no d1 database is configured.");
  }

  const database = resolveD1(ctx, seed.binding);
  await run(["d1", "execute", database.binding, scope, "--file", seed.file]);

  // Clear each cached KV key so the next read rebuilds it from the freshly-seeded rows.
  for (const entry of seed.resetKv ?? []) {
    await run(["kv", "key", "delete", entry.key, "--binding", entry.binding, scope]);
  }
};
