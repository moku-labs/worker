/**
 * @file ROOT integration tests — cross-plugin resource round-trips (build Step 5.8).
 *
 * Exercises the REAL exported `@moku-labs/worker` framework end-to-end: each test
 * adds one resource plugin plus a `server` endpoint that reaches the resource via
 * the per-request `require`, then drives a real HTTP request through
 * `app.server.handle(request, env, ctx)` and asserts the round-trip.
 *
 * The Cloudflare runtime is ABSENT under vitest, so bindings are substituted with
 * in-memory FAKES passed through `env`. These are NOT framework mocks — every
 * plugin (bindings, server, kv, d1, storage, queues, durableObjects) runs for real;
 * only the leaf Cloudflare primitives (KVNamespace, D1Database, R2Bucket, Queue,
 * DurableObjectNamespace) are faked. Fake factories are copied from each plugin's
 * own `__tests__/integration` suite. CF binding types are ambient globals — fakes
 * are cast `as unknown as <Type>`.
 *
 * createApp already wires core + bindings + server; only resource plugins are listed
 * in `plugins: [...]`. bindingsPlugin / serverPlugin are NEVER re-listed (re-listing
 * throws "Duplicate plugin name").
 */
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  d1Plugin,
  durableObjectsPlugin,
  endpoint,
  kvPlugin,
  queuesPlugin,
  storagePlugin
} from "../../src/index";
import { createMemoryProvider } from "../../src/plugins/storage/providers/memory";

// ---------------------------------------------------------------------------
// Shared test scaffolding
// ---------------------------------------------------------------------------

/** Minimal ExecutionContext stub — the server threads it but these tests never use it. */
const makeCtx = (): ExecutionContext =>
  ({
    waitUntil() {},

    passThroughOnException() {}
  }) as unknown as ExecutionContext;

/** Base framework config reused by every app under test. */
const baseConfig = { stage: "test", name: "xplugin", compatibilityDate: "" } as const;

// ---------------------------------------------------------------------------
// Fake bindings — copied verbatim in shape from each plugin's integration suite
// ---------------------------------------------------------------------------

/** Fake KVNamespace (in-memory) — mirrors `kv/__tests__/integration` `makeFakeKv`. */
const makeFakeKv = (initial: Record<string, string> = {}) => {
  const store = structuredClone(initial);

  return {
    // eslint-disable-next-line unicorn/no-null
    get: async (key: string): Promise<string | null> => store[key] ?? null,
    put: async (key: string, value: string, _opts?: unknown): Promise<void> => {
      store[key] = value;
    },
    delete: async (key: string): Promise<void> => {
      delete store[key];
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const allKeys = Object.keys(store);
      const filtered = opts?.prefix
        ? allKeys.filter(k => k.startsWith(opts.prefix ?? ""))
        : allKeys;
      const limited = opts?.limit === undefined ? filtered : filtered.slice(0, opts.limit);
      return { keys: limited.map(name => ({ name })), list_complete: true, cursor: "" };
    },
    // expose the backing store so tests can inspect a write without a second request
    __store: store
  };
};

/** Fake D1PreparedStatement seeded so `first()` resolves `firstRow` — mirrors `d1/__tests__/integration`. */
const makeFakeStmt = (firstRow: unknown): D1PreparedStatement =>
  ({
    bind: (..._params: unknown[]) => makeFakeStmt(firstRow),
    all: vi.fn(async <T = unknown>() => ({ results: [firstRow] as T[], success: true, meta: {} })),
    first: vi.fn(async <T = unknown>() => firstRow as T | null),
    run: vi.fn(async () => ({
      results: [],
      success: true,
      meta: { last_row_id: 1, rows_written: 1 }
    })),
    raw: vi.fn(async () => [])
  }) as unknown as D1PreparedStatement;

/** Fake D1Database whose prepared statements return `firstRow` — mirrors `d1/__tests__/integration`. */
const makeFakeD1 = (firstRow: unknown): D1Database =>
  ({
    prepare: vi.fn((_sql: string) => makeFakeStmt(firstRow)),
    batch: vi.fn(async (_stmts: D1PreparedStatement[]) => []),
    exec: vi.fn(async (_sql: string) => ({ results: [], count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0))
  }) as unknown as D1Database;

/** Fake Queue capturing `send`/`sendBatch` — mirrors `queues/__tests__/integration` `makeFakeQueue`. */
const makeFakeQueue = () => ({
  send: vi.fn().mockResolvedValue(undefined),
  sendBatch: vi.fn().mockResolvedValue(undefined)
});

/** Fake DurableObjectId. */
type FakeId = { name: string };
/** Fake DurableObjectStub whose fetch echoes the addressed id name. */
type FakeStub = { id: FakeId; fetch: (url: string) => Promise<Response> };
/** Fake DurableObjectNamespace. */
type FakeNamespace = { idFromName: (name: string) => FakeId; get: (id: FakeId) => FakeStub };

/** Fake DO namespace — mirrors `durable-objects/__tests__/integration` `makeFakeNamespace`. */
const makeFakeNamespace = (): FakeNamespace => ({
  idFromName: (name: string): FakeId => ({ name }),
  get: (id: FakeId): FakeStub => ({
    id,
    fetch: (_url: string) => Promise.resolve(new Response(`room:${id.name}`))
  })
});

// ---------------------------------------------------------------------------
// Cross-plugin integration tests
// ---------------------------------------------------------------------------

describe("cross-plugin resources (root integration)", () => {
  // ─── 1. server + kv read ──────────────────────────────────────────────────

  it("server + kv: GET /kv/{key} returns the seeded KV value", async () => {
    const app = createApp({
      plugins: [kvPlugin],
      config: baseConfig,
      pluginConfigs: {
        kv: { binding: "MY_KV" },
        server: {
          endpoints: [
            endpoint("/kv/{key}").get(({ params, env, require }) =>
              require(kvPlugin)
                .get(env, params.key ?? "")
                .then(value => new Response(value ?? "", { status: value === null ? 404 : 200 }))
            )
          ]
        }
      }
    });

    const env = { MY_KV: makeFakeKv({ greeting: "hi" }) } as Record<string, unknown>;
    const res = await app.server.handle(
      new Request("https://x/kv/greeting", { method: "GET" }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  // ─── 2. server + kv write ─────────────────────────────────────────────────

  it("server + kv: PUT /kv/{key} writes through to the KV store", async () => {
    const app = createApp({
      plugins: [kvPlugin],
      config: baseConfig,
      pluginConfigs: {
        kv: { binding: "MY_KV" },
        server: {
          endpoints: [
            endpoint("/kv/{key}").put(async ({ params, env, request, require }) => {
              await require(kvPlugin).put(env, params.key ?? "", await request.text());
              return new Response("stored", { status: 201 });
            }),
            endpoint("/kv/{key}").get(({ params, env, require }) =>
              require(kvPlugin)
                .get(env, params.key ?? "")
                .then(value => new Response(value ?? "", { status: value === null ? 404 : 200 }))
            )
          ]
        }
      }
    });

    const fakeKv = makeFakeKv();
    const env = { MY_KV: fakeKv } as Record<string, unknown>;

    const writeRes = await app.server.handle(
      new Request("https://x/kv/color", { method: "PUT", body: "blue" }),
      env,
      makeCtx()
    );

    expect(writeRes.status).toBe(201);
    // inspect the fake's backing store directly …
    expect(fakeKv.__store.color).toBe("blue");

    // … and confirm a second request reads the value back through the framework
    const readRes = await app.server.handle(
      new Request("https://x/kv/color", { method: "GET" }),
      env,
      makeCtx()
    );
    expect(await readRes.text()).toBe("blue");
  });

  // ─── 3. server + d1 ───────────────────────────────────────────────────────

  it("server + d1: GET /users/{id} returns the row from d1.first as JSON", async () => {
    const app = createApp({
      plugins: [d1Plugin],
      config: baseConfig,
      pluginConfigs: {
        d1: { binding: "DB", migrations: "" },
        server: {
          endpoints: [
            endpoint("/users/{id}").get(async ({ params, env, require }) => {
              const row = await require(d1Plugin).first(
                env,
                "SELECT id, name FROM users WHERE id = ?",
                params.id
              );
              return row === null ? new Response("Not Found", { status: 404 }) : Response.json(row);
            })
          ]
        }
      }
    });

    const env = { DB: makeFakeD1({ id: "7", name: "Ada" }) } as Record<string, unknown>;
    const res = await app.server.handle(
      new Request("https://x/users/7", { method: "GET" }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "7", name: "Ada" });
  });

  // ─── 4. server + storage (R2) ─────────────────────────────────────────────

  it("server + storage: GET /assets/{key} streams an object, 404 when absent", async () => {
    const app = createApp({
      plugins: [storagePlugin],
      config: baseConfig,
      pluginConfigs: {
        storage: { bucket: "ASSETS", upload: "./public" },
        server: {
          endpoints: [
            endpoint("/assets/{key}").get(async ({ params, env, require }) => {
              const body = await require(storagePlugin).get(env, params.key ?? "");
              return body === null
                ? new Response("Not Found", { status: 404 })
                : new Response(await body.text(), { status: 200 });
            })
          ]
        }
      }
    });

    const bucket = createMemoryProvider();
    await bucket.put("logo.png", "PNG");
    const env = { ASSETS: bucket } as Record<string, unknown>;

    const hit = await app.server.handle(
      new Request("https://x/assets/logo.png", { method: "GET" }),
      env,
      makeCtx()
    );
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe("PNG");

    const miss = await app.server.handle(
      new Request("https://x/assets/missing.png", { method: "GET" }),
      env,
      makeCtx()
    );
    expect(miss.status).toBe(404);
  });

  // ─── 5. server + durableObjects ───────────────────────────────────────────

  it("server + durableObjects: GET /do/{room} returns the DO stub's response", async () => {
    const app = createApp({
      plugins: [durableObjectsPlugin],
      config: baseConfig,
      pluginConfigs: {
        durableObjects: { bindings: { counter: "COUNTER" } },
        server: {
          endpoints: [
            endpoint("/do/{room}").get(({ params, env, require }) =>
              require(durableObjectsPlugin)
                .get(env, "counter", params.room ?? "")
                .fetch("https://do/")
            )
          ]
        }
      }
    });

    const env = { COUNTER: makeFakeNamespace() } as Record<string, unknown>;
    const res = await app.server.handle(
      new Request("https://x/do/lobby", { method: "GET" }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("room:lobby");
  });

  // ─── 6. server + queues (produce) ─────────────────────────────────────────

  it("server + queues: POST /enqueue sends the body to the Queue binding", async () => {
    const app = createApp({
      plugins: [queuesPlugin],
      config: baseConfig,
      pluginConfigs: {
        queues: { producers: ["jobs"], onMessage: async () => {} },
        server: {
          endpoints: [
            endpoint("/enqueue").post(async ({ env, require }) => {
              await require(queuesPlugin).send(env, "JOBS", { task: "x" });
              return new Response("queued", { status: 202 });
            })
          ]
        }
      }
    });

    const fakeQueue = makeFakeQueue();
    const env = { JOBS: fakeQueue } as Record<string, unknown>;

    const res = await app.server.handle(
      new Request("https://x/enqueue", { method: "POST" }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(202);
    expect(fakeQueue.send).toHaveBeenCalledTimes(1);
    expect(fakeQueue.send).toHaveBeenCalledWith({ task: "x" });
  });

  // ─── 7. multi-resource require / has ──────────────────────────────────────

  it("multi-resource: handler branches on has() and reaches kv + d1 via require", async () => {
    const app = createApp({
      plugins: [kvPlugin, d1Plugin],
      config: baseConfig,
      pluginConfigs: {
        kv: { binding: "MY_KV" },
        d1: { binding: "DB", migrations: "" },
        server: {
          endpoints: [
            endpoint("/probe").get(async ({ env, require, has }) => {
              const hasKv = has("kv");
              const hasNope = has("nope");
              const greeting = await require(kvPlugin).get(env, "greeting");
              const row = await require(d1Plugin).first<{ id: string }>(
                env,
                "SELECT id FROM t LIMIT 1"
              );
              // eslint-disable-next-line unicorn/no-null -- explicit JSON "no row" value
              return Response.json({ hasKv, hasNope, greeting, rowId: row?.id ?? null });
            })
          ]
        }
      }
    });

    const env = {
      MY_KV: makeFakeKv({ greeting: "hi" }),
      DB: makeFakeD1({ id: "42" })
    } as Record<string, unknown>;

    const res = await app.server.handle(
      new Request("https://x/probe", { method: "GET" }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hasKv: true,
      hasNope: false,
      greeting: "hi",
      rowId: "42"
    });
  });
});
