/**
 * @file d1 plugin — API factory. Thin typed wrappers over prepare().bind().
 */

import type { WorkerEnv } from "../../config";
import { bindingsPlugin } from "../bindings";
import type { D1Ctx, DeployManifest } from "./types";

/**
 * Create the d1 api. Each method resolves the D1Database off the request
 * `env` via the bindings plugin, then forwards to the native D1 call. The
 * binding is never cached, so concurrent requests stay isolated (SB4).
 *
 * The return is intentionally NOT annotated `: Api`. Annotating it would
 * collapse the per-method call-site generic `<T>` on `query`/`first` to
 * `unknown`; instead the implementation forwards `<T>` to `all<T>()` /
 * `first<T>()` and `types.ts#Api` remains the public-surface source of truth.
 *
 * @param {D1Ctx} ctx - Plugin context (own config + require).
 * @returns {object} The d1 public api (query, first, run, batch, prepare, deployManifest).
 * @example
 * ```typescript
 * const api = createD1Api(ctx);
 * const { results } = await api.query<Product>(env, "SELECT * FROM products");
 * ```
 */
export const createD1Api = (ctx: D1Ctx) => {
  // Resolve the request-scoped D1Database from `env`. Private to this closure.
  // Throws via the bindings resolver if the configured binding is absent.
  // eslint-disable-next-line jsdoc/require-jsdoc -- private closure, not a public export
  const db = (env: WorkerEnv): D1Database =>
    ctx.require(bindingsPlugin).require<D1Database>(env, ctx.config.binding);

  return {
    /**
     * Run a statement and return all rows. Forwards the call-site generic to
     * `all<T>()` so the result type is not widened to `unknown`.
     *
     * @param {WorkerEnv} env - Per-request Cloudflare bindings object.
     * @param {string} sql - SQL text with `?` placeholders.
     * @param {unknown[]} params - Bind parameters, in placeholder order.
     * @returns {Promise<D1Result<T>>} All rows (`.results` is `T[]`).
     * @example
     * ```typescript
     * const { results } = await api.query<Product>(env, "SELECT * FROM products WHERE active = ?", 1);
     * ```
     */
    query: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) =>
      db(env)
        .prepare(sql)
        .bind(...params)
        .all<T>(),

    /**
     * Run a statement and return the first row, or `null` if there are none.
     * Forwards the call-site generic to `first<T>()`.
     *
     * @param {WorkerEnv} env - Per-request Cloudflare bindings object.
     * @param {string} sql - SQL text with `?` placeholders.
     * @param {unknown[]} params - Bind parameters, in placeholder order.
     * @returns {Promise<T | null>} The first row, or `null` if none matched.
     * @example
     * ```typescript
     * const row = await api.first<Product>(env, "SELECT * FROM products WHERE id = ?", id);
     * ```
     */
    first: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) =>
      db(env)
        .prepare(sql)
        .bind(...params)
        .first<T>(),

    /**
     * Run a write/DDL statement (INSERT/UPDATE/DELETE/DDL) and return the
     * D1 result carrying `.meta` (e.g. `rows_written`, `last_row_id`).
     *
     * @param {WorkerEnv} env - Per-request Cloudflare bindings object.
     * @param {string} sql - SQL text with `?` placeholders.
     * @param {unknown[]} params - Bind parameters, in placeholder order.
     * @returns {Promise<D1Result>} Result carrying `.meta`.
     * @example
     * ```typescript
     * const res = await api.run(env, "INSERT INTO products (name) VALUES (?)", name);
     * const id = res.meta.last_row_id;
     * ```
     */
    run: (env: WorkerEnv, sql: string, ...params: unknown[]) =>
      db(env)
        .prepare(sql)
        .bind(...params)
        .run(),

    /**
     * Execute caller-built prepared statements atomically in one round-trip,
     * returning one result per statement in order.
     *
     * @param {WorkerEnv} env - Per-request Cloudflare bindings object.
     * @param {D1PreparedStatement[]} stmts - Statements built from prepare(env).
     * @returns {Promise<D1Result[]>} One result per statement, order preserved.
     * @example
     * ```typescript
     * const handle = api.prepare(env);
     * await api.batch(env, [handle.prepare("INSERT INTO a VALUES (1)").bind()]);
     * ```
     */
    batch: (env: WorkerEnv, stmts: D1PreparedStatement[]) => db(env).batch(stmts),

    /**
     * Resolve the request-scoped D1Database so callers can build prepared
     * statements for batch(). Issues no query itself.
     *
     * @param {WorkerEnv} env - Per-request Cloudflare bindings object.
     * @returns {D1Database} The request-resolved database handle.
     * @example
     * ```typescript
     * const handle = api.prepare(env);
     * const stmt = handle.prepare("SELECT * FROM t").bind();
     * ```
     */
    prepare: (env: WorkerEnv) => db(env),

    /**
     * Return this plugin's deploy metadata for the deploy plugin to read.
     * Build-time only — takes no `env`. The return is typed `DeployManifest`
     * (from types.ts), which pins `kind` to the literal `"d1"` without an
     * inline `as` assertion.
     *
     * @returns {DeployManifest} Deploy manifest entry `{ kind: "d1", binding, migrations }`.
     * @example
     * ```typescript
     * const m = api.deployManifest();
     * // => { kind: "d1", binding: "DB", migrations: "./migrations" }
     * ```
     */
    deployManifest: (): DeployManifest => ({
      kind: "d1",
      binding: ctx.config.binding,
      migrations: ctx.config.migrations
    })
  };
};
