import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv, WorkerEvents } from "../../../../config";
import { createServerApi } from "../../api";
import { endpoint } from "../../helpers";
import { createServerState } from "../../state";
import type {
  EndpointHandler,
  RequestContext,
  ServerCtx,
  ServerEvents,
  ServerState
} from "../../types";

// ─── Unit tests: createServerApi (mock context, no kernel) ───────────────────

const noop: EndpointHandler = () => new Response("ok");

/** Emit spy that records calls as { event, payload } pairs. */
type EmitRecord = { event: string; payload: unknown };
type AnyEmit = ServerCtx["emit"];

/** Default require stub: returns an empty object for any plugin. */
// biome-ignore lint/suspicious/noExplicitAny: test mock
const defaultRequire = (_plugin: any): any => ({});

/** Handler that returns a 200 "hello" response (hoisted — no closure). */
const helloHandler: EndpointHandler = () => new Response("hello", { status: 200 });

/** Handler that returns a 200 "ok" response (hoisted — no closure). */
const okHandler: EndpointHandler = () => new Response("ok", { status: 200 });

/** Handler that returns a 201 "x" response for end-payload test (hoisted). */
const createdHandler: EndpointHandler = () => new Response("x", { status: 201 });

/** Build a mock ServerCtx with a compiled state table and spy emit. */
const createMockCtx = (overrides?: {
  state?: ServerState;
  emit?: AnyEmit;
  require?: ServerCtx["require"];
  has?: ServerCtx["has"];
}): ServerCtx => {
  const defaultState = createServerState([]);
  defaultState.compiled = true;

  // Standard-tier ctx also carries the global framework config (spec/08 §2);
  // inert here — handle()/scheduled() only read config/state/emit/require/has.
  return {
    global: {},
    config: { endpoints: [] },
    state: overrides?.state ?? defaultState,
    emit: (overrides?.emit ?? vi.fn()) as AnyEmit,
    require: overrides?.require ?? defaultRequire,
    has: overrides?.has ?? ((_name: string) => false)
  } as ServerCtx;
};

/** Return a recording emit + the records array it writes to. */
const makeRecordingEmit = (): { records: EmitRecord[]; emit: AnyEmit } => {
  const records: EmitRecord[] = [];
  // The return type must be `any` to satisfy the overloaded ServerCtx["emit"] signature.
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const emit = (event: string, payload: unknown): any => {
    records.push({ event, payload });
  };
  return { records, emit: emit as AnyEmit };
};

/** A minimal stub ExecutionContext. */
const makeExec = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  }) as unknown as ExecutionContext;

/** Build a fake Request. */
const makeReq = (method = "GET", url = "https://example.com/test") => new Request(url, { method });

describe("createServerApi", () => {
  // ─── handle: 404 for no match ────────────────────────────────────────────

  it("returns 404 when no endpoint matches", async () => {
    const ctx = createMockCtx();
    const api = createServerApi(ctx);
    const res = await api.handle(makeReq(), {} as WorkerEnv, makeExec());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  // ─── handle: matched response ─────────────────────────────────────────────

  it("returns the handler's Response on a match", async () => {
    const state = createServerState([endpoint("/test").get(helloHandler)]);
    state.compiled = true;

    const ctx = createMockCtx({ state });
    const api = createServerApi(ctx);
    const res = await api.handle(makeReq("GET", "https://example.com/test"), {}, makeExec());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  // ─── handle: emit sequence ────────────────────────────────────────────────

  it("emits request:start → server:matched → request:end in order", async () => {
    const state = createServerState([endpoint("/path").get(okHandler)]);
    state.compiled = true;

    const { records, emit } = makeRecordingEmit();
    const ctx = createMockCtx({ state, emit });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/path"), {}, makeExec());

    expect(records).toHaveLength(3);
    expect(records[0]?.event).toBe("request:start");
    expect(records[1]?.event).toBe("server:matched");
    expect(records[2]?.event).toBe("request:end");
  });

  it("request:start payload has method, path, requestId", async () => {
    const state = createServerState([endpoint("/p").get(noop)]);
    state.compiled = true;

    const { records, emit } = makeRecordingEmit();
    const ctx = createMockCtx({ state, emit });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/p"), {}, makeExec());

    const start = records[0]?.payload as { method: string; path: string; requestId: string };
    expect(start.method).toBe("GET");
    expect(start.path).toBe("/p");
    expect(typeof start.requestId).toBe("string");
    expect(start.requestId).toHaveLength(36); // UUID length
  });

  it("server:matched payload has path and method", async () => {
    const state = createServerState([endpoint("/p").get(noop)]);
    state.compiled = true;

    const { records, emit } = makeRecordingEmit();
    const ctx = createMockCtx({ state, emit });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/p"), {}, makeExec());

    const matched = records[1]?.payload as { path: string; method: string };
    expect(matched.path).toBe("/p");
    expect(matched.method).toBe("GET");
  });

  it("request:end payload has method, path, status, ms", async () => {
    const state = createServerState([endpoint("/p").get(createdHandler)]);
    state.compiled = true;

    const { records, emit } = makeRecordingEmit();
    const ctx = createMockCtx({ state, emit });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/p"), {}, makeExec());

    const endPayload = records[2]?.payload as {
      method: string;
      path: string;
      status: number;
      ms: number;
    };
    expect(endPayload.method).toBe("GET");
    expect(endPayload.path).toBe("/p");
    expect(endPayload.status).toBe(201);
    expect(typeof endPayload.ms).toBe("number");
    expect(endPayload.ms).toBeGreaterThanOrEqual(0);
  });

  it("does NOT emit server:matched on a 404 (no match)", async () => {
    const emitMock = vi.fn() as unknown as AnyEmit;
    const ctx = createMockCtx({ emit: emitMock });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/no-match"), {}, makeExec());

    const eventNames = (vi.mocked(emitMock) as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => args[0] as string
    );
    expect(eventNames).not.toContain("server:matched");
    expect(eventNames).toContain("request:start");
  });

  // ─── handle: env isolation (SB4) ─────────────────────────────────────────

  it("env threaded to handler's RequestContext — never stored on state", async () => {
    let capturedEnv: WorkerEnv | undefined;
    // Closes over `capturedEnv` — must stay in-scope
    const envCapture: EndpointHandler = rc => {
      capturedEnv = rc.env;
      return new Response("ok");
    };
    const state = createServerState([endpoint("/e").get(envCapture)]);
    state.compiled = true;

    const ctx = createMockCtx({ state });
    const api = createServerApi(ctx);
    const env: WorkerEnv = { REGION: "us-east-1" };
    await api.handle(makeReq("GET", "https://example.com/e"), env, makeExec());

    expect(capturedEnv).toBe(env);
    // env is NOT stored on state
    expect((ctx.state as Record<string, unknown>).env).toBeUndefined();
  });

  it("two concurrent handle calls observe their own distinct env objects", async () => {
    const captured: WorkerEnv[] = [];
    // Closes over `captured` — must stay in-scope
    const concurrentHandler: EndpointHandler = async rc => {
      await Promise.resolve();
      captured.push(rc.env);
      return new Response("ok");
    };
    const state = createServerState([endpoint("/c").get(concurrentHandler)]);
    state.compiled = true;

    const ctx = createMockCtx({ state });
    const api = createServerApi(ctx);

    const env1: WorkerEnv = { ID: "request-1" };
    const env2: WorkerEnv = { ID: "request-2" };

    await Promise.all([
      api.handle(makeReq("GET", "https://example.com/c"), env1, makeExec()),
      api.handle(makeReq("GET", "https://example.com/c"), env2, makeExec())
    ]);

    expect(captured).toHaveLength(2);
    const ids = new Set(captured.map(e => e.ID));
    expect(ids).toContain("request-1");
    expect(ids).toContain("request-2");
    expect(captured[0]).not.toBe(captured[1]);
  });

  // ─── handle: require/has threaded ────────────────────────────────────────

  it("require and has from ctx are threaded into RequestContext", async () => {
    let capturedRequire: RequestContext["require"] | undefined;
    let capturedHas: RequestContext["has"] | undefined;
    // Closes over `capturedRequire` and `capturedHas` — must stay in-scope
    const requireCapture: EndpointHandler = rc => {
      capturedRequire = rc.require;
      capturedHas = rc.has;
      return new Response("ok");
    };
    const state = createServerState([endpoint("/rh").get(requireCapture)]);
    state.compiled = true;

    const fakeRequire = vi.fn();
    const fakeHas = vi.fn(() => true);
    const ctx = createMockCtx({
      state,
      require: fakeRequire as unknown as ServerCtx["require"],
      has: fakeHas
    });
    const api = createServerApi(ctx);
    await api.handle(makeReq("GET", "https://example.com/rh"), {}, makeExec());

    expect(capturedRequire).toBe(fakeRequire);
    expect(capturedHas).toBe(fakeHas);
  });

  // ─── scheduled ───────────────────────────────────────────────────────────

  it("scheduled — returns void when no cron endpoint matches", async () => {
    const ctx = createMockCtx();
    const api = createServerApi(ctx);
    const controller = {
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: vi.fn()
    } as unknown as ScheduledController;
    const result = await api.scheduled(controller, {}, makeExec());
    expect(result).toBeUndefined();
  });

  it("scheduled — awaits the matched cron handler", async () => {
    let called = false;
    // Closes over `called` — must stay in-scope
    const cronHandler: EndpointHandler = async () => {
      await Promise.resolve();
      called = true;
      return new Response("cron done");
    };
    const cronExpr = "0 * * * *";
    const state = createServerState([endpoint(cronExpr).all(cronHandler)]);
    state.compiled = true;

    const ctx = createMockCtx({ state });
    const api = createServerApi(ctx);
    const controller = {
      cron: cronExpr,
      scheduledTime: Date.now(),
      noRetry: vi.fn()
    } as unknown as ScheduledController;

    await api.scheduled(controller, {}, makeExec());
    expect(called).toBe(true);
  });

  // ─── Type-level tests ─────────────────────────────────────────────────────

  it("handle signature is (Request, WorkerEnv, ExecutionContext) => Promise<Response>", () => {
    const ctx = createMockCtx();
    const api = createServerApi(ctx);
    expectTypeOf(api.handle).toMatchTypeOf<
      (req: Request, env: WorkerEnv, exec: ExecutionContext) => Promise<Response>
    >();
  });

  it("scheduled signature is (ScheduledController, WorkerEnv, ExecutionContext) => Promise<void>", () => {
    const ctx = createMockCtx();
    const api = createServerApi(ctx);
    expectTypeOf(api.scheduled).toMatchTypeOf<
      (c: ScheduledController, env: WorkerEnv, exec: ExecutionContext) => Promise<void>
    >();
  });

  it("ctx.emit('server:matched', …) typechecks", () => {
    const ctx = createMockCtx();
    ctx.emit("server:matched", { path: "/x", method: "GET" });
    expect(ctx).toBeDefined();
  });

  it("ctx.emit('request:start', …) typechecks", () => {
    const ctx = createMockCtx();
    ctx.emit("request:start", { method: "GET", path: "/x", requestId: "id" });
    expect(ctx).toBeDefined();
  });

  it("ctx.emit with misspelled event is a type error", () => {
    const ctx = createMockCtx();
    // @ts-expect-error -- typo:event is not a known event
    ctx.emit("typo:event", {});
    expect(ctx).toBeDefined();
  });

  it("ctx.emit('server:matched') with wrong payload is a type error", () => {
    const ctx = createMockCtx();
    // @ts-expect-error -- wrong payload shape (missing required fields)
    ctx.emit("server:matched", { wrong: true });
    expect(ctx).toBeDefined();
  });

  it("ServerEvents type has server:matched", () => {
    expectTypeOf<ServerEvents>().toMatchTypeOf<{
      "server:matched": { path: string; method: string };
    }>();
  });

  it("WorkerEvents type has request:start and request:end", () => {
    expectTypeOf<WorkerEvents>().toMatchTypeOf<{
      "request:start": { method: string; path: string; requestId: string };
      "request:end": { method: string; path: string; status: number; ms: number };
    }>();
  });
});
