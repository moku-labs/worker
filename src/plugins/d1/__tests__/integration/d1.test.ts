import { describe, expect, it, vi } from "vitest";

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

import { d1Plugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration test: d1 plugin with real createApp + real bindings plugin
// ---------------------------------------------------------------------------

// Fake D1PreparedStatement
const makeFakeStmt = (sql: string): D1PreparedStatement => {
  const stmt: D1PreparedStatement = {
    bind: (..._params: unknown[]) => makeFakeStmt(sql),
    all: vi.fn(async <T = unknown>() => ({ results: [] as T[], success: true, meta: {} })),
    // eslint-disable-next-line unicorn/no-null -- D1 first() contract returns T | null
    first: vi.fn(async <T = unknown>() => null as T | null),
    run: vi.fn(async () => ({
      results: [],
      success: true,
      meta: { last_row_id: 1, rows_written: 1 }
    })),
    raw: vi.fn(async () => [])
  } as unknown as D1PreparedStatement;
  return stmt;
};

// Fake D1Database
const makeFakeD1 = () => {
  const fakeDb: D1Database = {
    prepare: vi.fn((sql: string) => makeFakeStmt(sql)),
    batch: vi.fn(async (_stmts: D1PreparedStatement[]) => []),
    exec: vi.fn(async (_sql: string) => ({ results: [], count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0))
  } as unknown as D1Database;
  return fakeDb;
};

// ---------------------------------------------------------------------------
// createTestApp — uses the coreConfig factory directly to avoid the
// framework-default serverPlugin (which is a sibling stub, not yet built).
// bindingsPlugin MUST come before d1Plugin (d1 declares depends:[bindingsPlugin]).
// ---------------------------------------------------------------------------

import { coreConfig } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";

const createTestApp = (bindingName = "DB") => {
  const { createApp } = coreConfig.createCore(coreConfig, {
    plugins: [bindingsPlugin, d1Plugin]
  });

  const fakeD1 = makeFakeD1();
  const env: Record<string, unknown> = { [bindingName]: fakeD1 };

  const app = createApp({
    pluginConfigs: {
      d1: { main: { name: "tracker-db", binding: bindingName, migrations: "./migrations" } }
    }
  });

  return { app, env, fakeD1 };
};

describe("d1 plugin (integration)", () => {
  // ── wiring ─────────────────────────────────────────────────────────────────

  describe("wiring", () => {
    it("d1 mounts on app.d1 (regular plugin, F3)", () => {
      const { app } = createTestApp();

      expect(app.d1).toBeDefined();
      expect(typeof app.d1.query).toBe("function");
      expect(typeof app.d1.first).toBe("function");
      expect(typeof app.d1.run).toBe("function");
      expect(typeof app.d1.batch).toBe("function");
      expect(typeof app.d1.prepare).toBe("function");
      expect(typeof app.d1.use).toBe("function");
      expect(typeof app.d1.deployManifest).toBe("function");
    });

    it("app.d1.use(key) returns a surface bound to the named instance", () => {
      const { app, env, fakeD1 } = createTestApp("DB");

      const db = app.d1.use("main").prepare(env);

      expect(db).toBe(fakeD1);
    });

    it("bindingsPlugin mounts on app.bindings", () => {
      const { app } = createTestApp();

      expect(app.bindings).toBeDefined();
    });
  });

  // ── query ─────────────────────────────────────────────────────────────────

  describe("query", () => {
    it("resolves DB through real bindings plugin and returns D1Result", async () => {
      const { app, env, fakeD1 } = createTestApp();

      const fakeResult = { results: [{ id: 1 }], success: true, meta: {} };
      (fakeD1.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({ ...s, all: vi.fn(async () => fakeResult) })
        } as unknown as D1PreparedStatement;
      });

      const result = await app.d1.query(env, "SELECT * FROM products");

      expect(fakeD1.prepare).toHaveBeenCalledWith("SELECT * FROM products");
      expect(result).toEqual(fakeResult);
    });
  });

  // ── first ─────────────────────────────────────────────────────────────────

  describe("first", () => {
    it("returns null when no row matches", async () => {
      const { app, env, fakeD1 } = createTestApp();

      (fakeD1.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          // eslint-disable-next-line unicorn/no-null -- D1 first() returns T | null
          bind: () => ({ ...s, first: vi.fn(async () => null) })
        } as unknown as D1PreparedStatement;
      });

      const row = await app.d1.first(env, "SELECT * FROM users WHERE id=?", 999);

      expect(row).toBeNull();
    });

    it("returns the matched row", async () => {
      const { app, env, fakeD1 } = createTestApp();
      const fakeRow = { id: 1, name: "Alice" };

      (fakeD1.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({ ...s, first: vi.fn(async () => fakeRow) })
        } as unknown as D1PreparedStatement;
      });

      const row = await app.d1.first(env, "SELECT * FROM users WHERE id=?", 1);

      expect(row).toEqual(fakeRow);
    });
  });

  // ── run ───────────────────────────────────────────────────────────────────

  describe("run", () => {
    it("executes write statement and returns result meta", async () => {
      const { app, env, fakeD1 } = createTestApp();
      const fakeMeta = { last_row_id: 42, rows_written: 1 };
      const fakeResult = { results: [], success: true, meta: fakeMeta };

      (fakeD1.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce((sql: string) => {
        const s = makeFakeStmt(sql);
        return {
          ...s,
          bind: () => ({ ...s, run: vi.fn(async () => fakeResult) })
        } as unknown as D1PreparedStatement;
      });

      const result = await app.d1.run(env, "INSERT INTO products (name) VALUES (?)", "widget");

      expect(result.meta).toEqual(fakeMeta);
    });
  });

  // ── batch ─────────────────────────────────────────────────────────────────

  describe("batch", () => {
    it("executes multiple statements and returns results order-preserved", async () => {
      const { app, env, fakeD1 } = createTestApp();

      const stmt1 = makeFakeStmt("UPDATE a SET x=1");
      const stmt2 = makeFakeStmt("UPDATE b SET x=2");
      const batchResults: D1Result[] = [
        { results: [], success: true, meta: meta({ rows_written: 1 }) },
        { results: [], success: true, meta: meta({ rows_written: 1 }) }
      ];
      (fakeD1.batch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(batchResults);

      const results = await app.d1.batch(env, [stmt1, stmt2]);

      expect(fakeD1.batch).toHaveBeenCalledWith([stmt1, stmt2]);
      expect(results).toEqual(batchResults);
    });
  });

  // ── prepare ───────────────────────────────────────────────────────────────

  describe("prepare", () => {
    it("returns the D1Database so callers can build statements", () => {
      const { app, env, fakeD1 } = createTestApp();

      const db = app.d1.prepare(env);

      expect(db).toBe(fakeD1);
    });
  });

  // ── deployManifest ────────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one entry per configured instance with name, binding and migrations", () => {
      const { app } = createTestApp("DB");

      const manifest = app.d1.deployManifest();

      expect(manifest).toEqual([
        { kind: "d1", name: "tracker-db", binding: "DB", migrations: "./migrations" }
      ]);
    });

    it("returns an empty array when no instances are configured (default empty map)", () => {
      const { createApp: createAppDefault } = coreConfig.createCore(coreConfig, {
        plugins: [bindingsPlugin, d1Plugin]
      });
      const app = createAppDefault();

      const manifest = app.d1.deployManifest();

      expect(manifest).toEqual([]);
    });
  });

  // ── error: missing binding ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws framework-prefixed error when binding is absent from env", () => {
      const { app } = createTestApp();
      const emptyEnv: Record<string, unknown> = {};

      // db(env) throws synchronously; use .toThrow not .rejects
      expect(() => app.d1.query(emptyEnv, "SELECT 1")).toThrow(
        '[worker] binding "DB" is not bound.'
      );
    });
  });
});
