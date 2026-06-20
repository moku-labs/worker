import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv } from "../../../../config";
import type { bindingsPlugin } from "../../../bindings";
import { createQueuesApi } from "../../api";
import type { Config, Ctx, QueueInstance } from "../../types";

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
  config: Config;
  emit: Ctx["emit"];
  require: (plugin: typeof bindingsPlugin) => MockBindingsApi;
};

/**
 * Creates a mock context with a stub bindings api backed by the given env map.
 * Any binding name not in envQueues causes require<Queue> to throw (missing binding).
 *
 * @param config - The keyed-map queues config the api reads.
 * @param envQueues - The named Queue stubs the request env exposes.
 * @param emit - Optional emit spy (defaults to a vi.fn()).
 * @returns The mock ctx plus a matching env object.
 */
const createMockCtx = (
  config: Config,
  envQueues: Record<string, FakeQueue> = {},
  emit?: Ctx["emit"]
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
    config,
    emit: emit ?? (vi.fn() as unknown as Ctx["emit"]),
    require: (_plugin: typeof bindingsPlugin) => fakeBindings
  };

  return { ctx, env };
};

// ---------------------------------------------------------------------------
// Unit tests: createQueuesApi
// ---------------------------------------------------------------------------

describe("createQueuesApi", () => {
  // ─── send (default + use) ────────────────────────────────────────────────

  describe("send", () => {
    it("sends to the DEFAULT instance's binding when one instance is configured", async () => {
      const fakeQueue = makeFakeQueue();
      const config: Config = { orders: { name: "orders", binding: "ORDERS" } };
      const { ctx, env } = createMockCtx(config, { ORDERS: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.send(env, { orderId: "123" });

      expect(fakeQueue.send).toHaveBeenCalledTimes(1);
      expect(fakeQueue.send).toHaveBeenCalledWith({ orderId: "123" });
    });

    it("resolves the default among many via `default: true`", async () => {
      const ordersQ = makeFakeQueue();
      const jobsQ = makeFakeQueue();
      const config: Config = {
        orders: { name: "orders", binding: "ORDERS", default: true },
        jobs: { name: "jobs", binding: "JOBS" }
      };
      const { ctx, env } = createMockCtx(config, { ORDERS: ordersQ, JOBS: jobsQ });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.send(env, { id: 1 });

      expect(ordersQ.send).toHaveBeenCalledWith({ id: 1 });
      expect(jobsQ.send).not.toHaveBeenCalled();
    });

    it("use(key).send targets the named instance's binding", async () => {
      const ordersQ = makeFakeQueue();
      const jobsQ = makeFakeQueue();
      const config: Config = {
        orders: { name: "orders", binding: "ORDERS", default: true },
        jobs: { name: "jobs", binding: "JOBS" }
      };
      const { ctx, env } = createMockCtx(config, { ORDERS: ordersQ, JOBS: jobsQ });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.use("jobs").send(env, { task: "x" });

      expect(jobsQ.send).toHaveBeenCalledWith({ task: "x" });
      expect(ordersQ.send).not.toHaveBeenCalled();
    });

    it("propagates the error when the binding is missing from env", async () => {
      const config: Config = { orders: { name: "orders", binding: "ORDERS" } };
      const { ctx, env } = createMockCtx(config, {});
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(api.send(env, "data")).rejects.toThrow("[moku-worker] binding");
    });

    it("use() rejects with a [moku-worker] error for an unknown instance key", async () => {
      const config: Config = { orders: { name: "orders", binding: "ORDERS" } };
      const { ctx, env } = createMockCtx(config, { ORDERS: makeFakeQueue() });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(api.use("missing").send(env, "x")).rejects.toThrow(
        '[moku-worker] No queues instance "missing"'
      );
    });
  });

  // ─── sendBatch ─────────────────────────────────────────────────────────

  describe("sendBatch", () => {
    it("calls Queue.sendBatch once with bodies wrapped as { body } objects (default)", async () => {
      const fakeQueue = makeFakeQueue();
      const config: Config = { jobs: { name: "jobs", binding: "JOBS" } };
      const { ctx, env } = createMockCtx(config, { JOBS: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      const bodies = [{ id: 1 }, { id: 2 }, { id: 3 }];
      await api.sendBatch(env, bodies);

      expect(fakeQueue.sendBatch).toHaveBeenCalledTimes(1);
      expect(fakeQueue.sendBatch).toHaveBeenCalledWith([
        { body: { id: 1 } },
        { body: { id: 2 } },
        { body: { id: 3 } }
      ]);
    });

    it("use(key).sendBatch preserves body order on the named instance", async () => {
      const fakeQueue = makeFakeQueue();
      const config: Config = {
        main: { name: "main", binding: "MAIN", default: true },
        side: { name: "side", binding: "SIDE" }
      };
      const { ctx, env } = createMockCtx(config, { MAIN: makeFakeQueue(), SIDE: fakeQueue });
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.use("side").sendBatch(env, ["a", "b", "c"]);

      const [[wrappedBodies]] = fakeQueue.sendBatch.mock.calls as [[Array<{ body: unknown }>]];
      expect(wrappedBodies.map(w => w.body)).toEqual(["a", "b", "c"]);
    });
  });

  // ─── consume (routing) ───────────────────────────────────────────────────

  describe("consume", () => {
    it("single instance → calls its onMessage once per message in batch order", async () => {
      const calls: string[] = [];
      const onMessage = vi.fn(async (m: Message) => {
        calls.push(m.id);
      });
      const config: Config = {
        activity: { name: "tracker-activity", binding: "ACTIVITY", onMessage }
      };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msgs = [makeMessage("m1"), makeMessage("m2"), makeMessage("m3")];
      await api.consume(makeBatch("any-queue", msgs), env, makeExec());

      expect(onMessage).toHaveBeenCalledTimes(3);
      expect(calls).toEqual(["m1", "m2", "m3"]);
    });

    it("single instance → passes (message, env) to onMessage", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const config: Config = { a: { name: "a", binding: "A", onMessage } };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msg = makeMessage("x1", { data: 42 });
      await api.consume(makeBatch("a", [msg]), env, makeExec());

      expect(onMessage).toHaveBeenCalledWith(msg, env);
    });

    it("multi instance → routes to the instance whose name === batch.queue", async () => {
      const activityHandler = vi.fn().mockResolvedValue(undefined);
      const ordersHandler = vi.fn().mockResolvedValue(undefined);
      const config: Config = {
        activity: {
          name: "tracker-activity",
          binding: "ACTIVITY",
          onMessage: activityHandler,
          default: true
        },
        orders: { name: "tracker-orders", binding: "ORDERS", onMessage: ordersHandler }
      };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.consume(makeBatch("tracker-orders", [makeMessage("o1")]), env, makeExec());

      expect(ordersHandler).toHaveBeenCalledTimes(1);
      expect(activityHandler).not.toHaveBeenCalled();
    });

    it("multi instance → matches a stage-suffixed CF queue name (name + '-dev')", async () => {
      const activityHandler = vi.fn().mockResolvedValue(undefined);
      const ordersHandler = vi.fn().mockResolvedValue(undefined);
      const config: Config = {
        activity: {
          name: "tracker-activity",
          binding: "ACTIVITY",
          onMessage: activityHandler,
          default: true
        },
        orders: { name: "tracker-orders", binding: "ORDERS", onMessage: ordersHandler }
      };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.consume(makeBatch("tracker-activity-dev", [makeMessage("a1")]), env, makeExec());

      expect(activityHandler).toHaveBeenCalledTimes(1);
      expect(ordersHandler).not.toHaveBeenCalled();
    });

    it("multi instance → falls back to the default when no name matches", async () => {
      const activityHandler = vi.fn().mockResolvedValue(undefined);
      const ordersHandler = vi.fn().mockResolvedValue(undefined);
      const config: Config = {
        activity: {
          name: "tracker-activity",
          binding: "ACTIVITY",
          onMessage: activityHandler,
          default: true
        },
        orders: { name: "tracker-orders", binding: "ORDERS", onMessage: ordersHandler }
      };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.consume(makeBatch("unrelated-queue", [makeMessage("u1")]), env, makeExec());

      expect(activityHandler).toHaveBeenCalledTimes(1);
      expect(ordersHandler).not.toHaveBeenCalled();
    });

    it("matched instance with no onMessage is a no-op (does not throw)", async () => {
      const config: Config = { silent: { name: "silent", binding: "SILENT" } };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(
        api.consume(makeBatch("silent", [makeMessage("s1")]), env, makeExec())
      ).resolves.toBeUndefined();
    });

    it("emits queue:message once per message with the batch queue + message id", async () => {
      const emitSpy = vi.fn() as unknown as Ctx["emit"];
      const config: Config = { jobs: { name: "jobs", binding: "JOBS", onMessage: async () => {} } };
      const { ctx, env } = createMockCtx(config, {}, emitSpy);
      const api = createQueuesApi(ctx as unknown as Ctx);

      const msgs = [makeMessage("id-1"), makeMessage("id-2")];
      await api.consume(makeBatch("jobs-queue", msgs), env, makeExec());

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
      const config: Config = { q: { name: "q", binding: "Q", onMessage } };
      const { ctx, env } = createMockCtx(config, {}, emitSpy);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.consume(makeBatch("q", [makeMessage("x")]), env, makeExec());

      expect(order).toEqual(["handler", "emit"]);
    });

    it("propagates a throwing onMessage so Cloudflare can retry", async () => {
      const onMessage = vi.fn().mockRejectedValue(new Error("handler error"));
      const config: Config = { q: { name: "q", binding: "Q", onMessage } };
      const { ctx, env } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(
        api.consume(makeBatch("q", [makeMessage("bad")]), env, makeExec())
      ).rejects.toThrow("handler error");
    });

    it("does not emit when onMessage throws", async () => {
      const onMessage = vi.fn().mockRejectedValue(new Error("boom"));
      const emitSpy = vi.fn() as unknown as Ctx["emit"];
      const config: Config = { q: { name: "q", binding: "Q", onMessage } };
      const { ctx, env } = createMockCtx(config, {}, emitSpy);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await expect(
        api.consume(makeBatch("q", [makeMessage("fail")]), env, makeExec())
      ).rejects.toThrow();

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  // ─── deployManifest ────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one { kind: 'queue', name, binding } entry per configured instance", () => {
      const config: Config = {
        activity: { name: "tracker-activity", binding: "ACTIVITY", default: true },
        orders: { name: "tracker-orders", binding: "ORDERS" }
      };
      const { ctx } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expect(api.deployManifest()).toEqual([
        { kind: "queue", name: "tracker-activity", binding: "ACTIVITY" },
        { kind: "queue", name: "tracker-orders", binding: "ORDERS" }
      ]);
    });

    it("returns an empty array when no instances are configured", () => {
      const { ctx } = createMockCtx({});
      const api = createQueuesApi(ctx as unknown as Ctx);

      expect(api.deployManifest()).toEqual([]);
    });
  });

  // ─── per-call env resolution ─────────────────────────────────────────────

  describe("per-call env resolution", () => {
    it("resolves the Queue from each call's env — no caching between calls", async () => {
      const q1 = makeFakeQueue();
      const q2 = makeFakeQueue();
      const config: Config = { orders: { name: "orders", binding: "ORDERS" } };
      const { ctx } = createMockCtx(config);
      const api = createQueuesApi(ctx as unknown as Ctx);

      await api.send(makeEnv({ ORDERS: q1 }), "a");
      await api.send(makeEnv({ ORDERS: q2 }), "b");

      expect(q1.send).toHaveBeenCalledWith("a");
      expect(q2.send).toHaveBeenCalledWith("b");
    });
  });

  // ─── Type-level assertions ─────────────────────────────────────────────

  describe("types", () => {
    const baseConfig: Config = { q: { name: "q", binding: "Q" } };

    it("QueueInstance.onMessage is optional and typed (Message, WorkerEnv) => Promise<void>", () => {
      expectTypeOf<QueueInstance["onMessage"]>().toEqualTypeOf<
        ((message: Message, env: WorkerEnv) => Promise<void>) | undefined
      >();
    });

    it("Config is a keyed map of QueueInstance", () => {
      expectTypeOf<Config>().toEqualTypeOf<Record<string, QueueInstance>>();
    });

    it("ctx.emit accepts queue:message with correct payload", () => {
      const { ctx } = createMockCtx(baseConfig);

      expectTypeOf(ctx.emit).toExtend<
        (event: "queue:message", payload: { queue: string; messageId: string }) => void
      >();
    });

    it("ctx.emit rejects wrong payload for queue:message", () => {
      const { ctx } = createMockCtx(baseConfig);

      // @ts-expect-error -- payload missing required fields
      ctx.emit("queue:message", { wrong: true });

      expect(ctx.emit).toBeDefined();
    });

    it("send return type is (env, body) => Promise<void>", () => {
      const { ctx } = createMockCtx(baseConfig);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.send).toEqualTypeOf<(env: WorkerEnv, body: unknown) => Promise<void>>();
    });

    it("sendBatch return type is (env, bodies) => Promise<void>", () => {
      const { ctx } = createMockCtx(baseConfig);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.sendBatch).toEqualTypeOf<
        (env: WorkerEnv, bodies: unknown[]) => Promise<void>
      >();
    });

    it("use(key) returns a producer surface (send + sendBatch)", () => {
      const { ctx } = createMockCtx(baseConfig);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.use("q")).toHaveProperty("send");
      expectTypeOf(api.use("q")).toHaveProperty("sendBatch");
    });

    it("consume return type is (batch, env, ctx) => Promise<void>", () => {
      const { ctx } = createMockCtx(baseConfig);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.consume).toEqualTypeOf<
        (batch: MessageBatch, env: WorkerEnv, ctx: ExecutionContext) => Promise<void>
      >();
    });

    it("deployManifest() returns Array<{ kind: 'queue'; name: string; binding: string }>", () => {
      const { ctx } = createMockCtx(baseConfig);
      const api = createQueuesApi(ctx as unknown as Ctx);

      expectTypeOf(api.deployManifest()).toEqualTypeOf<
        Array<{ kind: "queue"; name: string; binding: string }>
      >();
    });
  });
});
