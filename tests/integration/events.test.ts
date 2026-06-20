/**
 * @file Root integration tests — event system (spec/07).
 *
 * Exercises the REAL exported framework end-to-end. The Cloudflare runtime is
 * absent, so bindings are faked via `env` and an `ExecutionContext` stub. Events
 * are observed through an inline RECORDER plugin that declares `hooks`.
 *
 * Event visibility (spec/07 §2):
 *  - GLOBAL events (`request:start`, `request:end`) are declared in `WorkerEvents`
 *    and reach ANY plugin's hooks with no `depends`.
 *  - PLUGIN-LOCAL events (`server:matched` from server, `queue:message` from
 *    queues) are visible ONLY when the recorder `depends:` on that plugin. The
 *    recorder therefore depends on `[serverPlugin, queuesPlugin]` — a type/order
 *    edge that does NOT re-register the already-wired default `serverPlugin`.
 *
 * `emit` is fire-and-forget: hooks dispatch on an internal async microtask. After
 * each `await app.server.handle(...)` / `await app.queues.consume(...)` we flush
 * the microtask queue once (`setTimeout(…, 0)`) before asserting on `recorded`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, WorkerEnv } from "../../src/index";
import { createApp, createPlugin, endpoint, queuesPlugin, serverPlugin } from "../../src/index";

// ---------------------------------------------------------------------------
// Helpers — fake ExecutionContext + Queue MessageBatch + recorder plugin
// ---------------------------------------------------------------------------

/** A captured event: its name plus the raw payload the hook received. */
type Recorded = { name: string; payload: unknown };

const makeExec = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  }) as unknown as ExecutionContext;

const makeEnv = (): WorkerEnv => ({}) as WorkerEnv;

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

const makeBatch = (queueName: string, messages: Message[]): MessageBatch =>
  ({
    queue: queueName,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn()
  }) as unknown as MessageBatch;

/** Flush the fire-and-forget hook dispatch microtask before asserting. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// App builder — REAL exported framework. Defaults (core + bindings + server)
// are pre-wired; only the extras (queues + recorder) are listed in `plugins`.
// The recorder writes into the supplied `recorded` array so each test owns its
// own capture buffer.
// ---------------------------------------------------------------------------

const createEventsApp = (
  recorded: Recorded[],
  options: {
    endpoints?: Server.Endpoint[];
    producers?: string[];
    onMessage?: (message: Message, env: WorkerEnv) => Promise<void>;
  } = {}
) => {
  const recorderPlugin = createPlugin("recorder", {
    // Required to see the plugin-LOCAL events `server:matched` and `queue:message`.
    depends: [serverPlugin, queuesPlugin] as const,
    hooks: () => ({
      "request:start": payload => {
        recorded.push({ name: "request:start", payload });
      },
      "request:end": payload => {
        recorded.push({ name: "request:end", payload });
      },
      "server:matched": payload => {
        recorded.push({ name: "server:matched", payload });
      },
      "queue:message": payload => {
        recorded.push({ name: "queue:message", payload });
      }
    })
  });

  return createApp({
    // queuesPlugin is an extra (listed before the recorder that depends on it);
    // serverPlugin is a pre-wired default and is NEVER re-listed here.
    plugins: [queuesPlugin, recorderPlugin],
    config: { stage: "test", name: "events", compatibilityDate: "" },
    pluginConfigs: {
      server: { endpoints: options.endpoints ?? [] },
      queues: {
        // Single keyed instance — its CF `name` is the (optional) first producer; `binding` is the
        // producer env var. With one instance, consume() routes every batch to it regardless of
        // batch.queue, so the queue name asserted below is the one the batch carries.
        jobs: {
          name: options.producers?.[0] ?? "jobs",
          binding: "JOBS",
          onMessage: options.onMessage ?? (async () => {})
        }
      }
    }
  });
};

/** Narrow a captured payload to a plain record for property assertions. */
const asRecord = (payload: unknown): Record<string, unknown> => payload as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("event system (integration)", () => {
  let recorded: Recorded[];

  beforeEach(() => {
    recorded = [];
  });

  // ─── request:start + request:end around a matched handle ─────────────

  it("emits request:start and request:end around a matched request", async () => {
    const route = endpoint("/ping").get(() => new Response("ok"));
    const app = createEventsApp(recorded, { endpoints: [route] });

    const response = await app.server.handle(
      new Request("https://x/ping", { method: "GET" }),
      makeEnv(),
      makeExec()
    );
    await flush();

    expect(response.status).toBe(200);

    const start = recorded.find(e => e.name === "request:start");
    const end = recorded.find(e => e.name === "request:end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();

    expect(asRecord(start?.payload)).toEqual({
      method: "GET",
      path: "/ping",
      requestId: expect.any(String)
    });
    expect(asRecord(end?.payload)).toEqual({
      method: "GET",
      path: "/ping",
      status: 200,
      ms: expect.any(Number)
    });
    expect(asRecord(end?.payload).ms as number).toBeGreaterThanOrEqual(0);
  });

  // ─── server:matched on a matched route ───────────────────────────────

  it("emits server:matched for a matched route", async () => {
    const route = endpoint("/matched").get(() => new Response("ok"));
    const app = createEventsApp(recorded, { endpoints: [route] });

    await app.server.handle(
      new Request("https://x/matched", { method: "GET" }),
      makeEnv(),
      makeExec()
    );
    await flush();

    const matched = recorded.find(e => e.name === "server:matched");
    expect(matched).toBeDefined();
    expect(asRecord(matched?.payload)).toEqual({ path: "/matched", method: "GET" });
  });

  // ─── unmatched route → request:start fires, server:matched does NOT ───

  it("does not emit server:matched for an unmatched route (404)", async () => {
    // Only `/known` is registered; request `/missing`.
    const route = endpoint("/known").get(() => new Response("ok"));
    const app = createEventsApp(recorded, { endpoints: [route] });

    const response = await app.server.handle(
      new Request("https://x/missing", { method: "GET" }),
      makeEnv(),
      makeExec()
    );
    await flush();

    expect(response.status).toBe(404);

    // `request:start` fires before the route table is consulted.
    expect(recorded.some(e => e.name === "request:start")).toBe(true);

    // Negative assertion: no match ⇒ `server:matched` is never emitted.
    expect(recorded.some(e => e.name === "server:matched")).toBe(false);

    // The real `handle` returns early on a miss, BEFORE the `request:end` emit
    // (server/api.ts: the 404 path returns before `ctx.emit("request:end", …)`).
    // So `request:end` is also absent for an unmatched route — asserted truthfully
    // rather than against an end-event the implementation never fires.
    expect(recorded.some(e => e.name === "request:end")).toBe(false);
  });

  // ─── queue:message per consumed message ──────────────────────────────

  it("emits queue:message for each consumed message", async () => {
    const app = createEventsApp(recorded, { producers: ["jobs"] });

    const messages = [makeMessage("id-a"), makeMessage("id-b")];
    const batch = makeBatch("event-queue", messages);

    await app.queues.consume(batch, makeEnv(), makeExec());
    await flush();

    const queueEvents = recorded.filter(e => e.name === "queue:message");
    expect(queueEvents).toHaveLength(2);
    expect(asRecord(queueEvents[0]?.payload)).toEqual({
      queue: "event-queue",
      messageId: "id-a"
    });
    expect(asRecord(queueEvents[1]?.payload)).toEqual({
      queue: "event-queue",
      messageId: "id-b"
    });
  });

  // ─── payload type fidelity ───────────────────────────────────────────

  it("preserves payload types on request:start and request:end", async () => {
    const route = endpoint("/typed").get(() => new Response("ok"));
    const app = createEventsApp(recorded, { endpoints: [route] });

    await app.server.handle(
      new Request("https://x/typed", { method: "GET" }),
      makeEnv(),
      makeExec()
    );
    await flush();

    const start = asRecord(recorded.find(e => e.name === "request:start")?.payload);
    const end = asRecord(recorded.find(e => e.name === "request:end")?.payload);

    // request:end carries numeric `status` and `ms` (ms is a non-negative duration).
    expect(typeof end.status).toBe("number");
    expect(typeof end.ms).toBe("number");
    expect(end.ms as number).toBeGreaterThanOrEqual(0);

    // request:start carries a non-empty `requestId` string (crypto.randomUUID()).
    expect(typeof start.requestId).toBe("string");
    expect((start.requestId as string).length).toBeGreaterThan(0);
  });
});
