import { describe, expect, expectTypeOf, it, type MockInstance, vi } from "vitest";

import { bindingsPlugin } from "../../../bindings";
import { createD1Api } from "../../api";
import type { D1Ctx } from "../../types";

// ---------------------------------------------------------------------------
// Fake D1 primitives — ambient types (D1Database, D1PreparedStatement, D1Result)
// ---------------------------------------------------------------------------

/** Minimal fake D1PreparedStatement that records calls. */
const makeFakeStmt = (sql: string, boundParams: unknown[] = []): D1PreparedStatement => {
  const stmt = {
    _sql: sql,
    _params: boundParams,
    bind: (...params: unknown[]) => makeFakeStmt(sql, params),
    all: vi.fn(async <T = unknown>() => ({
      results: [] as T[],
      success: true,
      meta: {}
    })),
    // eslint-disable-next-line unicorn/no-null -- D1 first() contract returns T | null
    first: vi.fn(async <T = unknown>() => null as T | null),
    run: vi.fn(async () => ({
      results: [],
      success: true,
      meta: { last_row_id: 1, rows_written: 1 }
    }))
  } as unknown as D1PreparedStatement;
  return stmt;
};

/** Fake D1Database that records calls. */
const makeFakeDb = () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  let batchResult: D1Result[] = [];

  const db = {
    _calls: calls,
    setBatchResult: (results: D1Result[]) => {
      batchResult = results;
    },
    prepare: vi.fn((sql: string) => {
      calls.push({ sql, params: [] });
      return makeFakeStmt(sql);
    }),
    batch: vi.fn(async (_stmts: D1PreparedStatement[]) => batchResult)
  } as unknown as D1Database & {
    _calls: typeof calls;
    setBatchResult: (r: D1Result[]) => void;
    prepare: MockInstance<(sql: string) => D1PreparedStatement>;
    batch: MockInstance<(stmts: D1PreparedStatement[]) => Promise<D1Result[]>>;
  };
  return db;
};

// ---------------------------------------------------------------------------
// Mock context — D1Ctx includes require(bindingsPlugin) so we compose a
// structural ctx type manually (PluginCtx carries require automatically).
// ---------------------------------------------------------------------------

type FakeBindingsApi = {
  require: <T>(env: Record<string, unknown>, name: string) => T;
  has: (env: Record<string, unknown>, name: string) => boolean;
};

const createMockCtx = (overrides?: {
  binding?: string;
  migrations?: string;
  bindingsApi?: Partial<FakeBindingsApi>;
  /** Override the require fn on the ctx directly */
  requireFn?: D1Ctx["require"];
}): D1Ctx => {
  const binding = overrides?.binding ?? "DB";
  const migrations = overrides?.migrations ?? "";

  const defaultBindingsApi: FakeBindingsApi = {
    require: <T>(env: Record<string, unknown>, name: string): T => {
      const value = env[name];
      if (value === undefined || value === null) {
        throw new Error(
          `[moku-worker] binding "${name}" is not bound.\n  Declare it in wrangler config and pass it in via the request env.`
        );
      }
      return value as T;
    },
    has: (env: Record<string, unknown>, name: string) =>
      env[name] !== undefined && env[name] !== null
  };

  const bindingsApi = { ...defaultBindingsApi, ...overrides?.bindingsApi };

  const requireFn =
    overrides?.requireFn ??
    ((plugin: unknown) => {
      // Only support bindingsPlugin in tests
      if (plugin === bindingsPlugin) {
        return bindingsApi as ReturnType<D1Ctx["require"]>;
      }
      throw new Error("unexpected require call in test");
    });

  return {
    config: { binding, migrations },
    state: {},
    emit: vi.fn(),
    require: requireFn as D1Ctx["require"],
    has: vi.fn(() => true)
  } as unknown as D1Ctx;
};

/** Build an env object with a given D1Database under `binding`. */
const makeEnv = (db: D1Database, binding = "DB"): Record<string, unknown> => ({ [binding]: db });

/**
 * Build a complete D1Meta object, overriding only the fields supplied.
 * D1Meta requires: duration, size_after, rows_read, rows_written, last_row_id,
 * changed_db, changes.
 *
 * @param over - Partial D1Meta overrides.
 * @returns A complete D1Meta object satisfying the D1Meta interface.
 */
const meta = (over: Partial<D1Meta> = {}): D1Meta & Record<string, unknown> => ({
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: 0,
  last_row_id: 0,
  changed_db: false,
  changes: 0,
  ...over
});

// ---------------------------------------------------------------------------
// Unit tests: createD1Api
// ---------------------------------------------------------------------------

describe("createD1Api", () => {
  // ── query ─────────────────────────────────────────────────────────────────

  describe("query", () => {
    it("forwards sql and params to prepare().bind().all<T>() and returns D1Result", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const fakeResult = { results: [{ id: 1 }], success: true, meta: {} };
      // Override the all() on the stmt returned by prepare
      fakeDb.prepare.mockImplementationOnce((sql: string) => {
        const stmt = makeFakeStmt(sql);
        const boundStmt = {
          ...stmt,
          bind: (...params: unknown[]) => {
            const s = makeFakeStmt(sql, params);
            (s as unknown as { all: ReturnType<typeof vi.fn> }).all = vi.fn(async () => fakeResult);
            return s;
          }
        } as unknown as D1PreparedStatement;
        return boundStmt;
      });

      const result = await api.query<{ id: number }>(env, "SELECT * FROM t WHERE id = ?", 1);

      expect(fakeDb.prepare).toHaveBeenCalledWith("SELECT * FROM t WHERE id = ?");
      expect(result).toEqual(fakeResult);
    });

    it("returns empty results array when DB returns no rows", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const emptyResult = { results: [], success: true, meta: {} };
      fakeDb.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({
            ...s,
            all: vi.fn(async () => emptyResult)
          })
        } as unknown as D1PreparedStatement;
      });

      const result = await api.query(env, "SELECT * FROM t");

      expect(result).toEqual(emptyResult);
    });
  });

  // ── first ─────────────────────────────────────────────────────────────────

  describe("first", () => {
    it("returns the first row when DB yields a result", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const fakeRow = { id: 42, name: "widget" };
      fakeDb.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: (...params: unknown[]) => ({
            ...s,
            _params: params,
            first: vi.fn(async () => fakeRow)
          })
        } as unknown as D1PreparedStatement;
      });

      const row = await api.first<{ id: number; name: string }>(
        env,
        "SELECT * FROM t WHERE id=?",
        42
      );

      expect(row).toEqual(fakeRow);
    });

    it("returns null when DB yields null (no matching rows)", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      fakeDb.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({
            ...s,
            // eslint-disable-next-line unicorn/no-null -- D1 first() returns T | null
            first: vi.fn(async () => null)
          })
        } as unknown as D1PreparedStatement;
      });

      const row = await api.first(env, "SELECT * FROM t WHERE id=?", 999);

      expect(row).toBeNull();
    });
  });

  // ── run ───────────────────────────────────────────────────────────────────

  describe("run", () => {
    it("forwards sql and params to prepare().bind().run() and returns result with meta", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const fakeMeta = { last_row_id: 7, rows_written: 1 };
      const fakeResult = { results: [], success: true, meta: fakeMeta };
      fakeDb.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({
            ...s,
            run: vi.fn(async () => fakeResult)
          })
        } as unknown as D1PreparedStatement;
      });

      const result = await api.run(env, "INSERT INTO t (name) VALUES (?)", "foo");

      expect(fakeDb.prepare).toHaveBeenCalledWith("INSERT INTO t (name) VALUES (?)");
      expect(result.meta).toEqual(fakeMeta);
    });
  });

  // ── batch ─────────────────────────────────────────────────────────────────

  describe("batch", () => {
    it("forwards the statement array to db.batch() and returns results order-preserved", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const stmt1 = makeFakeStmt("UPDATE a SET x=1");
      const stmt2 = makeFakeStmt("UPDATE b SET x=2");
      const batchResults: D1Result[] = [
        { results: [], success: true, meta: meta({ rows_written: 1 }) },
        { results: [], success: true, meta: meta({ rows_written: 1 }) }
      ];
      fakeDb.setBatchResult(batchResults);

      const results = await api.batch(env, [stmt1, stmt2]);

      expect(fakeDb.batch).toHaveBeenCalledWith([stmt1, stmt2]);
      expect(results).toEqual(batchResults);
      expect(results[0]).toBe(batchResults[0]);
      expect(results[1]).toBe(batchResults[1]);
    });

    it("returns one result per statement, preserving order", async () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const stmts = [
        makeFakeStmt("INSERT INTO a VALUES (1)"),
        makeFakeStmt("INSERT INTO b VALUES (2)"),
        makeFakeStmt("INSERT INTO c VALUES (3)")
      ];
      const batchResults: D1Result[] = stmts.map((_, i) => ({
        results: [],
        success: true,
        meta: meta({ last_row_id: i + 1 })
      }));
      fakeDb.setBatchResult(batchResults);

      const results = await api.batch(env, stmts);

      expect(results).toHaveLength(3);
      expect(results[0]?.meta.last_row_id).toBe(1);
      expect(results[2]?.meta.last_row_id).toBe(3);
    });
  });

  // ── prepare ───────────────────────────────────────────────────────────────

  describe("prepare", () => {
    it("returns the resolved D1Database without issuing a query", () => {
      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const db = api.prepare(env);

      expect(db).toBe(fakeDb);
      expect(fakeDb.prepare).not.toHaveBeenCalled();
    });
  });

  // ── binding error ─────────────────────────────────────────────────────────

  describe("binding resolution", () => {
    it("throws the framework-prefixed error when the binding is missing", () => {
      const ctx = createMockCtx();
      const api = createD1Api(ctx);
      const emptyEnv: Record<string, unknown> = {};

      // db(env) throws synchronously inside the non-async arrow; use .toThrow not .rejects
      expect(() => api.query(emptyEnv, "SELECT 1")).toThrow(
        '[moku-worker] binding "DB" is not bound.'
      );
    });

    it("throws the framework-prefixed error for a custom binding name", () => {
      const ctx = createMockCtx({ binding: "MY_DB" });
      const api = createD1Api(ctx);
      const emptyEnv: Record<string, unknown> = {};

      expect(() => api.query(emptyEnv, "SELECT 1")).toThrow(
        '[moku-worker] binding "MY_DB" is not bound.'
      );
    });
  });

  // ── deployManifest ────────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns kind:d1 with binding and migrations from ctx.config", () => {
      const ctx = createMockCtx({ binding: "PROD_DB", migrations: "./migrations" });
      const api = createD1Api(ctx);

      const manifest = api.deployManifest();

      expect(manifest).toEqual({ kind: "d1", binding: "PROD_DB", migrations: "./migrations" });
    });

    it("returns empty migrations string when not configured", () => {
      const ctx = createMockCtx({ binding: "DB", migrations: "" });
      const api = createD1Api(ctx);

      const manifest = api.deployManifest();

      expect(manifest).toEqual({ kind: "d1", binding: "DB", migrations: "" });
    });

    it("takes no env argument (build-time only)", () => {
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      // Should not throw even with no env
      expect(() => api.deployManifest()).not.toThrow();
    });
  });

  // ── env threading (SB4) ───────────────────────────────────────────────────

  describe("env threading — no state (SB4)", () => {
    it("two calls with different env objects resolve different databases", async () => {
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const fakeDb1 = makeFakeDb();
      const fakeDb2 = makeFakeDb();
      const env1 = makeEnv(fakeDb1);
      const env2 = makeEnv(fakeDb2);

      // Set up both to return distinct results
      fakeDb1.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({ ...s, first: vi.fn(async () => ({ db: "db1" })) })
        } as unknown as D1PreparedStatement;
      });
      fakeDb2.prepare.mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({ ...s, first: vi.fn(async () => ({ db: "db2" })) })
        } as unknown as D1PreparedStatement;
      });

      const row1 = await api.first(env1, "SELECT 1");
      const row2 = await api.first(env2, "SELECT 1");

      expect(row1).toEqual({ db: "db1" });
      expect(row2).toEqual({ db: "db2" });
      // Each env's DB was prepared exactly once
      expect(fakeDb1.prepare).toHaveBeenCalledTimes(1);
      expect(fakeDb2.prepare).toHaveBeenCalledTimes(1);
    });

    it("the same api instance resolves env on every call (no cached env)", () => {
      const ctx = createMockCtx();
      const api = createD1Api(ctx);

      const fakeDb = makeFakeDb();
      const env = makeEnv(fakeDb);

      // Call prepare twice — should hit the db each time
      api.prepare(env);
      api.prepare(env);

      // bindings.require is called each time (no caching)
      // We verify this by confirming prepare(env) returns the same db both times
      // (if env were cached after first call, changing the env would go unnoticed)
      const anotherDb = makeFakeDb();
      const env2 = makeEnv(anotherDb);
      const resolvedDb = api.prepare(env2);

      expect(resolvedDb).toBe(anotherDb);
      expect(resolvedDb).not.toBe(fakeDb);
    });
  });

  // ── type-level tests ──────────────────────────────────────────────────────

  describe("types", () => {
    it("query<T> preserves the generic — result is Promise<D1Result<Product>>, not unknown", () => {
      type Product = { id: number; name: string };

      const ctx = createMockCtx();
      const api = createD1Api(ctx);
      const env = makeEnv(makeFakeDb());

      const resultPromise = api.query<Product>(env, "SELECT * FROM products");

      expectTypeOf(resultPromise).toEqualTypeOf<Promise<D1Result<Product>>>();
    });

    it("first<T> preserves the generic — result is Promise<Product | null>", () => {
      type Product = { id: number; name: string };

      const ctx = createMockCtx();
      const api = createD1Api(ctx);
      const env = makeEnv(makeFakeDb());

      const resultPromise = api.first<Product>(env, "SELECT * FROM products WHERE id=?", 1);

      expectTypeOf(resultPromise).toEqualTypeOf<Promise<Product | null>>();
    });

    it("@ts-expect-error: ctx.emit rejects d1-local events (d1 declares no events)", () => {
      const ctx = createMockCtx();

      // @ts-expect-error -- "d1:migrated" is not a declared event in WorkerEvents
      ctx.emit("d1:migrated", { binding: "DB" });

      expect(ctx).toBeDefined();
    });

    it("deployManifest() return has literal kind 'd1'", () => {
      const ctx = createMockCtx({ binding: "DB", migrations: "" });
      const api = createD1Api(ctx);

      const manifest = api.deployManifest();

      expectTypeOf(manifest.kind).toEqualTypeOf<"d1">();
    });

    it("@ts-expect-error: no flat ctx.d1 injection (d1 is regular, not core)", () => {
      const ctx = createMockCtx();

      // @ts-expect-error -- d1 is a regular plugin; ctx does not have a .d1 property
      ctx.d1;

      expect(ctx).toBeDefined();
    });
  });
});
