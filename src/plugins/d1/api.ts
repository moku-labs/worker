/**
 * @file d1 plugin — API factory. Thin typed wrappers over prepare().bind().
 */

import type { WorkerEnv } from "../../config";
import { bindingsPlugin } from "../bindings";
import { defaultInstanceKey, pickInstance } from "../bindings/instances";
import type { D1Ctx } from "./types";

/**
 * Create the d1 api over a keyed map of database instances. The default-database methods and
 * `use(key)` both resolve the `D1Database` off the REQUEST-SUPPLIED env on every call — env is
 * threaded, never stored (SB4), so concurrent requests stay isolated — and the instance key is
 * resolved lazily by binding-getter so an unconfigured-but-present plugin only errors when actually
 * called.
 *
 * The return is intentionally NOT annotated `: Api`. Annotating it would
 * collapse the per-method call-site generic `<T>` on `query`/`first` to
 * `unknown`; instead the implementation forwards `<T>` to `all<T>()` /
 * `first<T>()` and `types.ts#Api` remains the public-surface source of truth.
 *
 * @param {D1Ctx} ctx - Plugin context (keyed-map config + require).
 * @returns {object} The d1 public api (query, first, run, batch, prepare, use, deployManifest).
 * @example
 * ```typescript
 * const api = createD1Api(ctx);
 * const { results } = await api.query<Product>(env, "SELECT * FROM products");
 * await api.use("analytics").run(env, "INSERT INTO events (name) VALUES (?)", "click");
 * ```
 */
export const createD1Api = (ctx: D1Ctx) => {
  const bindings = ctx.require(bindingsPlugin);

  // The query/first/run/batch/prepare surface bound to one database, resolved lazily by binding-getter
  // so the default key (and a `use(key)` lookup) is resolved at call time, not at createApp time.
  // Throws via the bindings resolver if the configured binding is absent from the request env.
  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const surface = (binding: () => string) => {
    // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
    const db = (env: WorkerEnv): D1Database => bindings.require<D1Database>(env, binding());
    return {
      /**
       * Run a statement against this database and return all rows.
       *
       * @param env - The per-request Cloudflare env.
       * @param sql - SQL with `?` placeholders.
       * @param params - Bind parameters for the placeholders.
       * @returns All rows in a D1 result.
       * @example
       * ```typescript
       * const { results } = await api.query<Product>(env, "SELECT * FROM products");
       * ```
       */
      query: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) =>
        db(env)
          .prepare(sql)
          .bind(...params)
          .all<T>(),
      /**
       * Run a statement against this database and return the first row, or null when none.
       *
       * @param env - The per-request Cloudflare env.
       * @param sql - SQL with `?` placeholders.
       * @param params - Bind parameters for the placeholders.
       * @returns The first row, or null if none.
       * @example
       * ```typescript
       * const product = await api.first<Product>(env, "SELECT * FROM products WHERE id = ?", 1);
       * ```
       */
      first: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) =>
        db(env)
          .prepare(sql)
          .bind(...params)
          .first<T>(),
      /**
       * Run a write/DDL statement against this database and return its result meta.
       *
       * @param env - The per-request Cloudflare env.
       * @param sql - SQL with `?` placeholders.
       * @param params - Bind parameters for the placeholders.
       * @returns Result carrying `.meta`.
       * @example
       * ```typescript
       * await api.run(env, "INSERT INTO events (name) VALUES (?)", "click");
       * ```
       */
      run: (env: WorkerEnv, sql: string, ...params: unknown[]) =>
        db(env)
          .prepare(sql)
          .bind(...params)
          .run(),
      /**
       * Execute caller-built prepared statements atomically in one round-trip.
       *
       * @param env - The per-request Cloudflare env.
       * @param stmts - Caller-built prepared statements.
       * @returns One result per statement, order preserved.
       * @example
       * ```typescript
       * await api.batch(env, [api.prepare(env).prepare("INSERT INTO t (id) VALUES (1)")]);
       * ```
       */
      batch: (env: WorkerEnv, stmts: D1PreparedStatement[]) => db(env).batch(stmts),
      /**
       * Resolve the request `D1Database` so callers can build statements for `batch()`.
       *
       * @param env - The per-request Cloudflare env.
       * @returns The request-resolved database handle.
       * @example
       * ```typescript
       * const stmt = api.prepare(env).prepare("SELECT * FROM products");
       * ```
       */
      prepare: (env: WorkerEnv) => db(env)
    };
  };

  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const defaultBinding = (): string =>
    pickInstance(ctx.config, defaultInstanceKey(ctx.config, "d1"), "d1").binding;

  return {
    ...surface(defaultBinding),
    /**
     * Select a specific D1 database instance by its config key.
     *
     * @param key - The instance key (as configured under `pluginConfigs.d1`).
     * @returns The SQL surface bound to that database.
     * @example
     * ```typescript
     * await api.use("analytics").run(env, "INSERT INTO events (name) VALUES (?)", "click");
     * ```
     */
    use: (key: string) => surface(() => pickInstance(ctx.config, key, "d1").binding),
    /**
     * Return this plugin's deploy metadata — one descriptor per configured database.
     *
     * @returns One d1 deploy descriptor per instance.
     * @example
     * ```typescript
     * const manifest = api.deployManifest(); // [{ kind: "d1", name: "tracker-db", binding: "DB" }]
     * ```
     */
    deployManifest: () =>
      Object.values(ctx.config).map(instance => {
        const entry: { kind: "d1"; name: string; binding: string; migrations?: string } = {
          kind: "d1",
          name: instance.name,
          binding: instance.binding
        };
        if (instance.migrations !== undefined) {
          entry.migrations = instance.migrations;
        }
        return entry;
      })
  };
};
