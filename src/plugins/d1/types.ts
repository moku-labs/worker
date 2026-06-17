/**
 * @file d1 plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";

/**
 * d1 plugin configuration.
 *
 * @example
 * ```ts
 * { binding: "DB", migrations: "./migrations" }
 * ```
 */
export type Config = {
  /** D1 binding name resolved off the per-request env. */
  binding: string;
  /** Migrations directory; deploy-time metadata only. */
  migrations: string;
};

/**
 * Deploy metadata entry for a D1 database, read by the deploy plugin.
 *
 * @example
 * ```ts
 * { kind: "d1", binding: "DB", migrations: "./migrations" }
 * ```
 */
export type DeployManifest = {
  /** Discriminant identifying this as a D1 resource. */
  kind: "d1";
  /** D1 binding name. */
  binding: string;
  /** Migrations directory (or "" if none). */
  migrations: string;
};

/** Public api surface of the d1 plugin (thin typed wrappers over prepare().bind()). */
export type Api = {
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
  /**
   * Return this plugin's deploy metadata (read by the deploy plugin).
   *
   * @returns Deploy manifest entry `{ kind: "d1", binding, migrations }`.
   */
  deployManifest: () => DeployManifest;
};

/** Internal context type — own config first, no state, no d1-local events. */
export type D1Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents>;
