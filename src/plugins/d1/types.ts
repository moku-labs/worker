/**
 * @file d1 plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import type { BindingsApi, bindingsPlugin } from "../bindings";

/**
 * A single D1 database instance: its base Cloudflare name + the env binding it resolves off, plus
 * optional deploy-time migrations metadata.
 *
 * @example
 * ```ts
 * { name: "tracker-db", binding: "DB", migrations: "db/migrations" }
 * ```
 */
export type D1Instance = {
  /** Base Cloudflare D1 database name (stage-suffixed at deploy). */
  name: string;
  /** Env binding name the database resolves off the per-request `env` (e.g. `env.DB`). */
  binding: string;
  /** Migrations directory; deploy-time metadata only. Omit when there are none. */
  migrations?: string;
  /** Marks this instance the default when more than one is configured. */
  default?: boolean;
};

/**
 * d1 plugin config — a keyed map of D1 database instances. The key is the stable logical id used by
 * `app.d1.use("key")`; a single entry (or one flagged `default: true`) is the implicit default.
 *
 * @example
 * ```ts
 * { main: { name: "tracker-db", binding: "DB", migrations: "db/migrations" } }
 * ```
 */
export type Config = Record<string, D1Instance>;

/**
 * The SQL surface for one D1 database (the thin typed wrappers bound to a single instance).
 *
 * @example
 * ```ts
 * const { results } = await app.d1.query<Product>(env, "SELECT * FROM products");
 * await app.d1.use("analytics").run(env, "INSERT INTO events (name) VALUES (?)", "click");
 * ```
 */
export type D1DatabaseApi = {
  /**
   * Run a statement and return all rows.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param sql - SQL with `?` placeholders.
   * @param params - Bind parameters.
   * @returns All rows in a D1 result.
   */
  query: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) => Promise<D1Result<T>>;
  /**
   * Run a statement and return the first row or null.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param sql - SQL with `?` placeholders.
   * @param params - Bind parameters.
   * @returns The first row, or null if none.
   */
  first: <T = unknown>(env: WorkerEnv, sql: string, ...params: unknown[]) => Promise<T | null>;
  /**
   * Run a write/DDL statement and return its result meta.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param sql - SQL with `?` placeholders.
   * @param params - Bind parameters.
   * @returns Result carrying `.meta`.
   */
  run: (env: WorkerEnv, sql: string, ...params: unknown[]) => Promise<D1Result>;
  /**
   * Execute prepared statements atomically in one round-trip.
   *
   * @param env - Per-request Cloudflare bindings.
   * @param stmts - Caller-built prepared statements.
   * @returns One result per statement, order preserved.
   */
  batch: (env: WorkerEnv, stmts: D1PreparedStatement[]) => Promise<D1Result[]>;
  /**
   * Resolve the request D1Database so callers can build statements for batch().
   *
   * @param env - Per-request Cloudflare bindings.
   * @returns The request-resolved database handle.
   */
  prepare: (env: WorkerEnv) => D1Database;
};

/**
 * The app.d1 surface — the default database's methods, a `use(key)` selector for the others, plus
 * deploy metadata.
 *
 * @example
 * ```ts
 * const { results } = await app.d1.query<Product>(env, "SELECT * FROM products"); // default db
 * await app.d1.use("analytics").run(env, "INSERT INTO events (name) VALUES (?)", "click");
 * ```
 */
export type Api = D1DatabaseApi & {
  /**
   * Select a specific D1 database instance by its config key.
   *
   * @param key - The instance key (as configured under `pluginConfigs.d1`).
   * @returns The SQL surface bound to that database.
   */
  use(key: string): D1DatabaseApi;
  /**
   * Return this plugin's deploy metadata (one entry per configured database), read by the deploy
   * plugin. Build-time only — takes no `env`.
   *
   * @returns One d1 deploy descriptor per configured instance.
   */
  deployManifest(): Array<{ kind: "d1"; name: string; binding: string; migrations?: string }>;
};

/**
 * Internal context type — own config first, no state, no d1-local events.
 * Intersected with a narrow `require` typed to the one dependency d1 resolves.
 */
export type D1Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /**
   * Resolve a dependency plugin's api. d1 only ever resolves `bindingsPlugin`.
   *
   * @param plugin - The bindingsPlugin instance.
   * @returns The resolved bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};
