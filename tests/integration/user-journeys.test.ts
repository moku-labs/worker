/**
 * @file ROOT integration — end-to-end user journeys for `@moku-labs/worker`.
 *
 * These tests drive the REAL exported framework exactly as a consumer Worker
 * would: `createApp` returns an app whose defaults (core + bindings + server)
 * are pre-wired by `src/index.ts`; each journey adds only the extra plugins it
 * needs via `plugins: [...]` (bindings/server are NEVER re-listed). Requests
 * flow through `app.server.handle(request, env, ctx)`; cron through
 * `app.server.scheduled(controller, env, ctx)`; queue batches through
 * `app.queues.consume(batch, env, ctx)`.
 *
 * The Cloudflare runtime is absent, so each binding is an in-memory FAKE placed
 * on the per-request `env` (NOT a framework mock). The fake factories below are
 * copied verbatim from the proven plugin-level integration suites:
 *   - kv  → src/plugins/kv/__tests__/integration/kv.test.ts (makeFakeKv)
 *   - d1  → src/plugins/d1/__tests__/integration/d1.test.ts (makeFakeD1, seeded rows)
 *   - R2  → src/plugins/storage/__tests__/helpers/memory-provider.ts (createMemoryProvider as env.ASSETS)
 *   - queue → src/plugins/queues/__tests__/integration/queues.test.ts (makeFakeQueue/makeMessage/makeBatch)
 *   - DO  → src/plugins/durable-objects/__tests__/integration/durable-objects.test.ts (makeFakeNamespace)
 *
 * Handlers receive `{ params, env, require, has }` and call `require(<plugin>).<method>(env, ...)`
 * (env-first). Cloudflare types are ambient globals; fakes are cast `as unknown as X`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  d1Plugin,
  defineDurableObject,
  durableObjectsPlugin,
  endpoint,
  kvPlugin,
  queuesPlugin,
  storagePlugin
} from "../../src/index";
import { createMemoryProvider } from "../../src/plugins/storage/__tests__/helpers/memory-provider";

// ---------------------------------------------------------------------------
// Shared test scaffolding
// ---------------------------------------------------------------------------

/** Minimal ExecutionContext test double — the consumer Worker passes the real one. */
const makeCtx = (): ExecutionContext =>
  ({
    waitUntil() {},
    passThroughOnException() {}
  }) as unknown as ExecutionContext;

/** Build a Request for a path on a throwaway origin. */
const req = (path: string, init?: RequestInit): Request => new Request(`https://x${path}`, init);

// ---------------------------------------------------------------------------
// Fake bindings — copied from the proven plugin-level integration suites
// ---------------------------------------------------------------------------

/** Minimal KVNamespace stub — only the methods the kv plugin uses. */
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
      return {
        keys: limited.map(name => ({ name })),
        list_complete: true,
        cursor: ""
      };
    }
  };
};

/** Fake D1PreparedStatement — `first` defaults to null; overridden per seed. */
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

/** Fake D1Database — `prepare` returns a fake statement; overridden per seed. */
const makeFakeD1 = () => {
  const fakeDb: D1Database = {
    prepare: vi.fn((sql: string) => makeFakeStmt(sql)),
    batch: vi.fn(async (_stmts: D1PreparedStatement[]) => []),
    exec: vi.fn(async (_sql: string) => ({ results: [], count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0))
  } as unknown as D1Database;
  return fakeDb;
};

/**
 * Seed a single row so the NEXT `prepare(sql).bind(...).first()` resolves it.
 * Mirrors the d1 plugin-level "returns the matched row" pattern.
 *
 * @param fakeD1 - The fake D1Database to program.
 * @param row - The row the next `first()` call should resolve.
 */
const seedFirstRow = (fakeD1: D1Database, row: unknown): void => {
  (fakeD1.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce((sql: string) => {
    const s = makeFakeStmt(sql);
    return {
      ...s,
      bind: () => ({ ...s, first: vi.fn(async () => row) })
    } as unknown as D1PreparedStatement;
  });
};

/** Minimal Queue stub — records sent bodies for assertion. */
const makeFakeQueue = () => ({
  send: vi.fn().mockResolvedValue(undefined),
  sendBatch: vi.fn().mockResolvedValue(undefined)
});

/** Build a fake Message carrying a body. */
const makeMessage = (id: string, body: unknown = {}): Message =>
  ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body,
    noRetry: vi.fn(),
    retry: vi.fn(),
    ack: vi.fn()
  }) as unknown as Message;

/** Build a fake MessageBatch for a queue. */
const makeBatch = (queueName: string, messages: Message[]): MessageBatch =>
  ({
    queue: queueName,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn()
  }) as unknown as MessageBatch;

/** Fake DurableObjectId. */
type FakeId = { name: string };

/** Fake DurableObjectStub. */
type FakeStub = { id: FakeId; fetch: (url: string) => Promise<Response> };

/** Fake DurableObjectNamespace. */
type FakeNamespace = {
  idFromName: (name: string) => FakeId;
  get: (id: FakeId) => FakeStub;
};

/**
 * Build a fake DO namespace whose stub `fetch` SIMULATES the runtime by
 * incrementing an in-closure per-room counter and returning it as JSON.
 *
 * The real DO class (from `defineDurableObject`) cannot run without the
 * Cloudflare runtime (it reads `this.ctx.storage`), so this stub stands in for
 * the isolate: it owns the counter the real DO would persist in durable storage.
 *
 * @returns A fake namespace whose stubs increment a shared per-id counter.
 */
const makeCountingNamespace = (): FakeNamespace => {
  const counts = new Map<string, number>();

  return {
    idFromName: (name: string): FakeId => ({ name }),
    get: (id: FakeId): FakeStub => ({
      id,
      fetch: (_url: string) => {
        const next = (counts.get(id.name) ?? 0) + 1;
        counts.set(id.name, next);
        return Promise.resolve(Response.json({ count: next }));
      }
    })
  };
};

// ---------------------------------------------------------------------------
// Journey 1 — JSON API worker (server + kv + d1)
// ---------------------------------------------------------------------------

describe("journey: JSON API worker (server + kv + d1)", () => {
  it("GET /users/{id} returns a seeded user as JSON, then POST+GET /cache round-trips KV", async () => {
    const app = createApp({
      plugins: [kvPlugin, d1Plugin],
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/users/{id}").get(async ({ params, env, require }) => {
              const user = await require(d1Plugin).first(
                env,
                "SELECT * FROM users WHERE id = ?",
                params.id
              );
              if (user === null) return new Response("Not Found", { status: 404 });
              return Response.json(user);
            }),
            endpoint("/cache/{key}").post(async ({ params, env, request, require }) => {
              const body = await request.text();
              await require(kvPlugin).put(env, params.key ?? "", body);
              return Response.json({ stored: params.key }, { status: 201 });
            }),
            endpoint("/cache/{key}").get(async ({ params, env, require }) => {
              const value = await require(kvPlugin).get(env, params.key ?? "");
              if (value === null) return new Response("Not Found", { status: 404 });
              return Response.json({ key: params.key, value });
            })
          ]
        }
      }
    });

    const fakeD1 = makeFakeD1();
    const fakeKv = makeFakeKv();
    const env = { DB: fakeD1, KV: fakeKv } as unknown as Record<string, unknown>;
    const ctx = makeCtx();

    // GET /users/42 → d1.first resolves the seeded row as JSON.
    seedFirstRow(fakeD1, { id: 42, name: "Ada" });
    const userRes = await app.server.handle(req("/users/42"), env, ctx);

    expect(userRes.status).toBe(200);
    expect(await userRes.json()).toEqual({ id: 42, name: "Ada" });

    // POST /cache/greeting writes to KV …
    const putRes = await app.server.handle(
      req("/cache/greeting", { method: "POST", body: "hello" }),
      env,
      ctx
    );

    expect(putRes.status).toBe(201);
    expect(await putRes.json()).toEqual({ stored: "greeting" });

    // … and GET /cache/greeting reads it back.
    const getRes = await app.server.handle(req("/cache/greeting"), env, ctx);

    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ key: "greeting", value: "hello" });
  });
});

// ---------------------------------------------------------------------------
// Journey 2 — Asset server (server + storage)
// ---------------------------------------------------------------------------

describe("journey: asset server (server + storage)", () => {
  it("GET serves a seeded object, 404s a missing key, and PUT then GET round-trips", async () => {
    const app = createApp({
      plugins: [storagePlugin],
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/assets/{key}").get(async ({ params, env, require }) => {
              const object = await require(storagePlugin).get(env, params.key ?? "");
              if (object === null) return new Response("Not Found", { status: 404 });
              return new Response(await object.text());
            }),
            endpoint("/assets/{key}").put(async ({ params, env, request, require }) => {
              const body = await request.text();
              await require(storagePlugin).put(env, params.key ?? "", body);
              // eslint-disable-next-line unicorn/no-null -- explicit empty body for 204 No Content
              return new Response(null, { status: 204 });
            })
          ]
        }
      }
    });

    // The storage plugin resolves the "ASSETS" binding off env; the memory
    // provider IS the R2Bucket-shaped fake for this journey.
    const bucket = createMemoryProvider();
    await bucket.put("logo.png", "PNGDATA");
    const env = { ASSETS: bucket } as unknown as Record<string, unknown>;
    const ctx = makeCtx();

    // GET an existing key → 200 + body.
    const hit = await app.server.handle(req("/assets/logo.png"), env, ctx);
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe("PNGDATA");

    // GET a missing key → 404.
    const miss = await app.server.handle(req("/assets/missing.png"), env, ctx);
    expect(miss.status).toBe(404);

    // PUT a new key → 204, then a follow-up GET returns it.
    const stored = await app.server.handle(
      req("/assets/styles.css", { method: "PUT", body: "BODYBYTES" }),
      env,
      ctx
    );
    expect(stored.status).toBe(204);

    const readBack = await app.server.handle(req("/assets/styles.css"), env, ctx);
    expect(readBack.status).toBe(200);
    expect(await readBack.text()).toBe("BODYBYTES");
  });
});

// ---------------------------------------------------------------------------
// Journey 3 — DO-backed counter (server + durableObjects + defineDurableObject)
// ---------------------------------------------------------------------------

describe("journey: DO-backed counter (server + durableObjects)", () => {
  // The real DO class body is exercised only STRUCTURALLY here: it is declared
  // and extends the base, but cannot run without the Cloudflare runtime (its
  // fetch reads this.ctx.storage). The fake namespace stub above SIMULATES the
  // isolate by owning the per-room counter the real DO would persist.
  class Counter extends defineDurableObject("Counter") {
    async fetch(): Promise<Response> {
      const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
      await this.ctx.storage.put("n", n);
      return Response.json({ count: n });
    }
  }

  it("declares the Counter DO class structurally (extends base, static doName)", () => {
    expect(Counter.doName).toBe("Counter");
    const instance = new Counter(
      { storage: {} } as unknown as DurableObjectState,
      {} as Record<string, unknown>
    );
    expect(instance.ctx).toBeDefined();
  });

  it("GET /count/{room} twice returns an increasing count (stub simulates the DO)", async () => {
    const app = createApp({
      plugins: [durableObjectsPlugin],
      pluginConfigs: {
        durableObjects: { bindings: { counter: "COUNTER" } },
        server: {
          endpoints: [
            endpoint("/count/{room}").get(async ({ params, env, require }) => {
              const stub = require(durableObjectsPlugin).get(env, "counter", params.room ?? "");
              return stub.fetch("https://do/increment");
            })
          ]
        }
      }
    });

    const env = { COUNTER: makeCountingNamespace() } as unknown as Record<string, unknown>;
    const ctx = makeCtx();

    const first = await app.server.handle(req("/count/lobby"), env, ctx);
    const second = await app.server.handle(req("/count/lobby"), env, ctx);

    const firstBody = (await first.json()) as { count: number };
    const secondBody = (await second.json()) as { count: number };

    expect(firstBody.count).toBe(1);
    expect(secondBody.count).toBe(2);
    expect(secondBody.count).toBeGreaterThan(firstBody.count);
  });
});

// ---------------------------------------------------------------------------
// Journey 4 — Queue produce → consume round-trip (server + queues)
// ---------------------------------------------------------------------------

describe("journey: queue produce -> consume round-trip (server + queues)", () => {
  it("POST /enqueue sends to the fake queue, then consume() runs onMessage per message", async () => {
    const processed: unknown[] = [];

    const app = createApp({
      plugins: [queuesPlugin],
      pluginConfigs: {
        queues: {
          producers: ["JOBS"],
          onMessage: async (message: Message) => {
            processed.push(message.body);
          }
        },
        server: {
          endpoints: [
            endpoint("/enqueue").post(async ({ env, request, require }) => {
              const body = await request.json();
              await require(queuesPlugin).send(env, "JOBS", body);
              return Response.json({ enqueued: true }, { status: 202 });
            })
          ]
        }
      }
    });

    const fakeQueue = makeFakeQueue();
    const env = { JOBS: fakeQueue } as unknown as Record<string, unknown>;
    const ctx = makeCtx();

    // Producer side: POST /enqueue → fake queue receives the body.
    const enqueueRes = await app.server.handle(
      req("/enqueue", { method: "POST", body: JSON.stringify({ task: "resize" }) }),
      env,
      ctx
    );

    expect(enqueueRes.status).toBe(202);
    expect(fakeQueue.send).toHaveBeenCalledTimes(1);
    expect(fakeQueue.send).toHaveBeenCalledWith({ task: "resize" });

    // Consumer side: deliver a batch and assert the onMessage side effect ran.
    const batch = makeBatch("JOBS", [makeMessage("m1", { task: "resize" })]);
    await app.queues.consume(batch, env, ctx);

    expect(processed).toEqual([{ task: "resize" }]);
  });
});

// ---------------------------------------------------------------------------
// Journey 5 — Scheduled / cron path
// ---------------------------------------------------------------------------

describe("journey: scheduled / cron path (server.scheduled)", () => {
  it("app.server.scheduled resolves without throwing for a fired controller", async () => {
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [endpoint("/health").get(() => new Response("ok"))]
        }
      }
    });

    const controller = {
      scheduledTime: 0,
      cron: "* * * * *",
      noRetry() {}
    } as unknown as ScheduledController;
    const env = {} as Record<string, unknown>;
    const ctx = makeCtx();

    // No cron endpoint matches "* * * * *", so scheduled returns immediately —
    // the contract under test is that the cron entrypoint exists and resolves.
    await expect(app.server.scheduled(controller, env, ctx)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Journey 6 — Unmatched route → 404 (edge)
// ---------------------------------------------------------------------------

describe("edge: unmatched route", () => {
  it("GET on an unregistered path returns 404", async () => {
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [endpoint("/known").get(() => new Response("ok"))]
        }
      }
    });

    const response = await app.server.handle(
      req("/nope"),
      {} as Record<string, unknown>,
      makeCtx()
    );

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Journey 7 — Empty / default config (edge)
// ---------------------------------------------------------------------------

describe("edge: empty / default config", () => {
  it("createApp() with no pluginConfigs boots; server has [] endpoints so any request 404s", async () => {
    const app = createApp();

    expect(app.server).toBeDefined();
    expect(typeof app.server.handle).toBe("function");
    expect(typeof app.server.scheduled).toBe("function");

    // Defaults are complete (no undefined): the empty endpoint table 404s everything.
    const response = await app.server.handle(
      req("/anything"),
      {} as Record<string, unknown>,
      makeCtx()
    );

    expect(response.status).toBe(404);
  });
});
