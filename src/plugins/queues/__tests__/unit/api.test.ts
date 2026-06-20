import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv } from "../../../../config";
import type { bindingsPlugin } from "../../../bindings";
import { createQueuesApi } from "../../api";
import type { Ctx } from "../../types";

// ---------------------------------------------------------------------------
// Helpers — fake Cloudflare Queue + MessageBatch
// ---------------------------------------------------------------------------

/** Minimal Queue stub recording send/sendBatch invocations. */
const makeFakeQueue = () => ({
  send: vi.fn().mockResolvedValue(undefined),
  sendBatch: vi.fn().mockResolvedValue(undefined)
});

type FakeQueue = ReturnType<typeof makeFakeQueue>;

/** Build a fake per-request env holding named Queue stubs. */
const makeEnv = (queues: Record<string, FakeQueue>): WorkerEnv => queues as unknown as WorkerEnv;

/** Minimal Message stub for use in MessageBatch. */
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

/** Minimal MessageBatch stub. */
const makeBatch = (queueName: string, messages: Message[]): MessageBatch =>
  ({
    queue: queueName,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn()
  }) as unknown as MessageBatch;

/** Minimal ExecutionContext stub. */
const makeExec = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  }) as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Mock context factory
//
// queues plugin uses ctx.require(bindingsPlugin) — this is NOT modelled by
// PluginCtx alone. We compose a local structural mock that adds `require`.
// ---------------------------------------------------------------------------

type MockBindingsApi = {
  require<T>(env: WorkerEnv, name: string): T;
  has(env: WorkerEnv, name: string): boolean;
};

/** Structural ctx type matching what createQueuesApi actually reads. */
type MockCtx = {
  config: { producers: string[]; onMessage: (message: Message, env: WorkerEnv) => Promise<void> };
  emit: Ctx["emit"];
  require: (plugin: typeof bindingsPlugin) => MockBindingsApi;
};

/**
 * Creates a mock context with a stub bindings api backed by the given env map.
 * Any queue name not in envQueues causes require<Queue> to throw (missing binding).
 */
const createMockCtx = (
  envQueues: Record<string, FakeQueue> = {},
  overrides?: {
    producers?: string[];
    onMessage?: (message: Message, env: WorkerEnv) => Promise<void>;
    emit?: Ctx["emit"];
  }
): { ctx: MockCtx; env: WorkerEnv } => {
  const env = makeEnv(envQueues);

  const fakeBindings: MockBindingsApi = {
    require: <T>(reqEnv: WorkerEnv, name: string): T => {
      const val = reqEnv[name];
      if (val === undefined || val === null) {
        throw new Error(
          `[moku-worker] binding "${name}" is not bound.\n` +
            `  Declare it in wrangler config and pass it in via the request env.`
        );
      }
      return val as T;
    },
    has: (reqEnv: WorkerEnv, name: string) => reqEnv[name] !== undefined && reqEnv[name] !== null
  };

  const ctx: MockCtx = {
    config: {
      producers: overrides?.producers ?? [],
      onMessage: overrides?.onMessage ?? vi.fn().mockResolvedValue(undefined)
    },
    emit: overrides?.emit ?? (vi.fn() as unknown as Ctx["emit"]),
    require: (_plugin: typeof bindingsPlugin) => fakeBindings
  };

  return { ctx, env };
};

// ---------------------------------------------------------------------------
// Unit tests: createQueuesApi
// ---------------------------------------------------------------------------

describe("createQueuesApi", () => {
  // ─── send ──────────────────────────────────────────────────────────────

  describe("send", () => {
    it("resolves the named binding and calls Queue.send(body) once", async () => {
      const fakeQueue = makeFakeQueue();
      const { ctx, env } = createMockCtx({ ORDERS: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.send(env, "ORDERS", { orderId: "123" });

      expect(fakeQueue.send).toHaveBeenCalledTimes(1);
      expect(fakeQueue.send).toHaveBeenCalledWith({ orderId: "123" });
    });

    it("propagates the error when the binding is missing", async () => {
      const { ctx, env } = createMockCtx({});
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(api.send(env, "MISSING_QUEUE", "data")).rejects.toThrow("[moku-worker] binding");
    });
  });

  // ─── sendBatch ─────────────────────────────────────────────────────────

  describe("sendBatch", () => {
    it("calls Queue.sendBatch once with bodies wrapped as { body } objects", async () => {
      const fakeQueue = makeFakeQueue();
      const { ctx, env } = createMockCtx({ JOBS: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const bodies = [{ id: 1 }, { id: 2 }, { id: 3 }];
      await api.sendBatch(env, "JOBS", bodies);

      expect(fakeQueue.sendBatch).toHaveBeenCalledTimes(1);
      expect(fakeQueue.sendBatch).toHaveBeenCalledWith([
        { body: { id: 1 } },
        { body: { id: 2 } },
        { body: { id: 3 } }
      ]);
    });

    it("preserves body order", async () => {
      const fakeQueue = makeFakeQueue();
      const { ctx, env } = createMockCtx({ Q: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.sendBatch(env, "Q", ["a", "b", "c"]);

      const [[wrappedBodies]] = fakeQueue.sendBatch.mock.calls as [[Array<{ body: unknown }>]];
      expect(wrappedBodies.map(w => w.body)).toEqual(["a", "b", "c"]);
    });
  });

  // ─── consume ───────────────────────────────────────────────────────────

  describe("consume", () => {
    it("awaits onMessage once per message in batch order", async () => {
      const calls: string[] = [];
      const onMessage = vi.fn(async (m: Message) => {
        calls.push(m.id);
      });
      const { ctx, env } = createMockCtx({}, { onMessage });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msgs = [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")];
      const batch = makeBatch("my-queue", msgs);

      await api.consume(batch, env, makeExec());

      expect(onMessage).toHaveBeenCalledTimes(3);
      expect(calls).toEqual(["m1", "m2", "m3"]);
    });

    it("passes (message, env) to onMessage", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const { ctx, env } = createMockCtx({}, { onMessage });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msg = makeMessage("x1", { data: 42 });
      const batch = makeBatch("q", [msg]);

      await api.consume(batch, env, makeExec());

      expect(onMessage).toHaveBeenCalledWith(msg, env);
    });

    it("emits queue:message once per message with correct payload", async () => {
      const emitSpy = vi.fn() as unknown as Ctx["emit"];
      const { ctx, env } = createMockCtx({}, { emit: emitSpy });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msgs = [makeMessage("id-1"), makeMessage("id-2")];
      const batch = makeBatch("jobs-queue", msgs);

      await api.consume(batch, env, makeExec());

      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenNthCalledWith(1, "queue:message", {
        queue: "jobs-queue",
        messageId: "id-1"
      });
      expect(emitSpy).toHaveBeenNthCalledWith(2, "queue:message", {
        queue: "jobs-queue",
        messageId: "id-2"
      });
    });

    it("emits queue:message AFTER onMessage resolves (fire-and-forget observability)", async () => {
      const order: string[] = [];
      const onMessage = vi.fn(async () => {
        order.push("handler");
      });
      const emitSpy = vi.fn((..._args: unknown[]) => {
        order.push("emit");
      }) as unknown as Ctx["emit"];
      const { ctx, env } = createMockCtx({}, { onMessage, emit: emitSpy });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.consume(makeBatch("q", [makeMessage("x")]), env, makeExec());

      expect(order).toEqual(["handler", "emit"]);
    });

    it("propagates a throwing onMessage so Cloudflare can retry", async () => {
      const onMessage = vi.fn().mockRejectedValue(new Error("handler error"));
      const { ctx, env } = createMockCtx({}, { onMessage });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const batch = makeBatch("q", [makeMessage("bad")]);

      await expect(api.consume(batch, env, makeExec())).rejects.toThrow("handler error");
    });

    it("does not emit when onMessage throws", async () => {
      const onMessage = vi.fn().mockRejectedValue(new Error("boom"));
      const emitSpy = vi.fn() as unknown as Ctx["emit"];
      const { ctx, env } = createMockCtx({}, { onMessage, emit: emitSpy });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(
        api.consume(makeBatch("q", [makeMessage("fail")]), env, makeExec())
      ).rejects.toThrow();

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // ─── deployManifest ────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns { kind: 'queue', producers } from config", () => {
      const { ctx } = createMockCtx({}, { producers: ["orders", "jobs"] });
      const api = createQueuesApi(ctx as unknown as Ctx);

      expect(api.deployManifest()).toEqual({ kind: "queue", producers: ["orders", "jobs"] });
    });

    it("returns empty producers array when config.producers is empty", () => {
      const { ctx } = createMockCtx({}, { producers: [] });
      const api = createQueuesApi(ctx as unknown as Ctx);

      expect(api.deployManifest()).toEqual({ kind: "queue", producers: [] });
    });
  });

  // ─── Type-level assertions ─────────────────────────────────────────────

  describe("types", () => {
    it("ctx.emit accepts queue:message with correct payload", () => {
      const { ctx } = createMockCtx();

      expectTypeOf(ctx.emit).toExtend<
        (event: "queue:message", payload: { queue: string; messageId: string }) => void
      >();
    });

    it("ctx.emit rejects wrong payload for queue:message", () => {
      const { ctx } = createMockCtx();

      // @ts-expect-error -- payload missing required fields
      ctx.emit("queue:message", { wrong: true });

      expect(ctx.emit).toBeDefined();
    });

    it("deployManifest() returns { kind: 'queue'; producers: string[] }", () => {
      const { ctx } = createMockCtx({}, { producers: ["a"] });
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.deployManifest).toEqualTypeOf<
        () => { kind: "queue"; producers: string[] }
      >();
    });

    it("config.onMessage parameter is typed as (message: Message, env: WorkerEnv) => Promise<void>", () => {
      const { ctx } = createMockCtx();

      expectTypeOf(ctx.config.onMessage).toEqualTypeOf<
        (message: Message, env: WorkerEnv) => Promise<void>
      >();
    });

    it("send return type is Promise<void>", () => {
      const { ctx } = createMockCtx({ Q: makeFakeQueue() });
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.send).toEqualTypeOf<
        (env: WorkerEnv, q: string, body: unknown) => Promise<void>
      >();
      expect(api.send).toBeDefined();
    });

    it("sendBatch return type is Promise<void>", () => {
      const { ctx } = createMockCtx({});
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.sendBatch).toEqualTypeOf<
        (env: WorkerEnv, q: string, bodies: unknown[]) => Promise<void>
      >();
      expect(api.sendBatch).toBeDefined();
    });

    it("consume return type is Promise<void>", () => {
      const { ctx } = createMockCtx({});
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.consume).toEqualTypeOf<
        (batch: MessageBatch, env: WorkerEnv, exec: ExecutionContext) => Promise<void>
      >();
      expect(api.consume).toBeDefined();
    });
  });
});
