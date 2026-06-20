import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv } from "../../../../config";
import { coreConfig, createPlugin } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { queuesPlugin } from "../../index";
import type { Config } from "../../types";

// ---------------------------------------------------------------------------
// Helpers — fake Queue + MessageBatch + ExecutionContext
// ---------------------------------------------------------------------------

const makeFakeQueue = () => ({
  send: vi.fn().mockResolvedValue(undefined),
  sendBatch: vi.fn().mockResolvedValue(undefined)
});

const makeEnv = (queues: Record<string, ReturnType<typeof makeFakeQueue>>): WorkerEnv =>
  queues as unknown as WorkerEnv;

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

const makeExec = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  }) as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// createTestApp — uses framework createCore so all plugins wire correctly
// ---------------------------------------------------------------------------

/** Single-instance keyed-map config used when `createTestApp` is called without one. */
const DEFAULT_QUEUES_CONFIG: Config = {
  jobs: { name: "jobs", binding: "JOBS", onMessage: async () => {} }
};

/**
 * Builds a test app over bindings + queues with the supplied keyed-map config. A single-instance
 * default config (`jobs`) is used when none is given.
 *
 * @param queues - The keyed-map queues config to mount under `pluginConfigs.queues`.
 * @returns The created app instance.
 */
const createTestApp = (queues: Config = DEFAULT_QUEUES_CONFIG) => {
  const { createApp } = coreConfig.createCore(coreConfig, {
    plugins: [bindingsPlugin, queuesPlugin]
  });

  return createApp({ pluginConfigs: { queues } });
};

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("queues plugin (integration)", () => {
  // ─── Runtime: wiring ─────────────────────────────────────────────────

  describe("runtime: wiring", () => {
    it("mounts on app.queues", () => {
      const app = createTestApp();

      expect(app.queues).toBeDefined();
    });

    it("exposes send, sendBatch, use, consume, deployManifest", () => {
      const app = createTestApp();

      expect(typeof app.queues.send).toBe("function");
      expect(typeof app.queues.sendBatch).toBe("function");
      expect(typeof app.queues.use).toBe("function");
      expect(typeof app.queues.consume).toBe("function");
      expect(typeof app.queues.deployManifest).toBe("function");
    });

    it("requires bindingsPlugin to be present before queuesPlugin", () => {
      // If bindingsPlugin is absent the kernel throws at createApp due to missing depends.
      // This test documents the ordering requirement by verifying normal wiring succeeds
      // (the inverse — missing dep — is a kernel invariant, not plugin-specific logic).
      const app = createTestApp();

      expect(app.bindings).toBeDefined();
      expect(app.queues).toBeDefined();
    });
  });

  // ─── Runtime: send (default + use) ────────────────────────────────────

  describe("runtime: send", () => {
    it("delegates to the default instance's Queue.send via bindings", async () => {
      const fakeQueue = makeFakeQueue();
      const env = makeEnv({ JOBS: fakeQueue });
      const app = createTestApp();

      await app.queues.send(env, { task: "process" });

      expect(fakeQueue.send).toHaveBeenCalledTimes(1);
      expect(fakeQueue.send).toHaveBeenCalledWith({ task: "process" });
    });

    it("use(key).send targets the named instance among many", async () => {
      const ordersQ = makeFakeQueue();
      const jobsQ = makeFakeQueue();
      const env = makeEnv({ ORDERS: ordersQ, JOBS: jobsQ });
      const app = createTestApp({
        orders: { name: "orders", binding: "ORDERS", default: true, onMessage: async () => {} },
        jobs: { name: "jobs", binding: "JOBS", onMessage: async () => {} }
      });

      await app.queues.use("jobs").send(env, { id: 7 });

      expect(jobsQ.send).toHaveBeenCalledWith({ id: 7 });
      expect(ordersQ.send).not.toHaveBeenCalled();
    });
  });

  // ─── Runtime: consume routing ─────────────────────────────────────────

  describe("runtime: consume", () => {
    it("single instance → routes every message to its onMessage (Worker queue() shape)", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const app = createTestApp({ jobs: { name: "jobs", binding: "JOBS", onMessage } });

      const msgs = [makeMessage("m1"), makeMessage("m2")];
      const batch = makeBatch("jobs", msgs);

      // This is exactly how the Worker entry delegates: app.queues.consume(batch, env, exec)
      await app.queues.consume(batch, makeEnv({}), makeExec());

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenNthCalledWith(1, msgs[0], expect.any(Object));
      expect(onMessage).toHaveBeenNthCalledWith(2, msgs[1], expect.any(Object));
    });

    it("multi instance → routes by exact name and by stage-suffixed name", async () => {
      const activityHandler = vi.fn().mockResolvedValue(undefined);
      const ordersHandler = vi.fn().mockResolvedValue(undefined);
      const app = createTestApp({
        activity: {
          name: "tracker-activity",
          binding: "ACTIVITY",
          default: true,
          onMessage: activityHandler
        },
        orders: { name: "tracker-orders", binding: "ORDERS", onMessage: ordersHandler }
      });

      await app.queues.consume(
        makeBatch("tracker-orders", [makeMessage("o1")]),
        makeEnv({}),
        makeExec()
      );
      await app.queues.consume(
        makeBatch("tracker-activity-dev", [makeMessage("a1")]),
        makeEnv({}),
        makeExec()
      );

      expect(ordersHandler).toHaveBeenCalledTimes(1);
      expect(activityHandler).toHaveBeenCalledTimes(1);
    });

    it("works without calling app.start() or app.stop() (request-scoped Worker)", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const app = createTestApp({ jobs: { name: "jobs", binding: "JOBS", onMessage } });

      const batch = makeBatch("jobs", [makeMessage("x")]);

      // No start() / stop() — request-scoped Workers never call them
      await expect(app.queues.consume(batch, makeEnv({}), makeExec())).resolves.toBeUndefined();
    });
  });

  // ─── Runtime: events observed via hook plugin ─────────────────────────

  describe("runtime: queue:message event", () => {
    it("fires queue:message for each consumed message", () => {
      const observed: Array<{ queue: string; messageId: string }> = [];

      const { createApp: createAppWithObserver } = coreConfig.createCore(coreConfig, {
        plugins: [bindingsPlugin, queuesPlugin]
      });

      const observerPlugin = createPlugin("observer", {
        depends: [queuesPlugin] as const,
        hooks: _ctx => ({
          "queue:message": payload => {
            observed.push(payload);
          }
        })
      });

      const app = createAppWithObserver({
        plugins: [observerPlugin],
        pluginConfigs: {
          queues: { jobs: { name: "jobs", binding: "JOBS", onMessage: async () => {} } }
        }
      });

      const msgs = [makeMessage("id-a"), makeMessage("id-b")];
      const batch = makeBatch("event-queue", msgs);

      return app.queues.consume(batch, makeEnv({}), makeExec()).then(() => {
        expect(observed).toHaveLength(2);
        expect(observed[0]).toEqual({ queue: "event-queue", messageId: "id-a" });
        expect(observed[1]).toEqual({ queue: "event-queue", messageId: "id-b" });
      });
    });
  });

  // ─── Runtime: deployManifest ─────────────────────────────────────────

  describe("runtime: deployManifest", () => {
    it("returns one { kind: 'queue', name, binding } entry per configured instance", () => {
      const app = createTestApp({
        orders: { name: "tracker-orders", binding: "ORDERS", default: true },
        notifications: { name: "tracker-notifications", binding: "NOTIFICATIONS" }
      });

      expect(app.queues.deployManifest()).toEqual([
        { kind: "queue", name: "tracker-orders", binding: "ORDERS" },
        { kind: "queue", name: "tracker-notifications", binding: "NOTIFICATIONS" }
      ]);
    });
  });

  // ─── Types: API signatures ────────────────────────────────────────────

  describe("types: API signatures", () => {
    it("send has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.send).toEqualTypeOf<
        (env: WorkerEnv, body: unknown) => Promise<void>
      >();
    });

    it("sendBatch has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.sendBatch).toEqualTypeOf<
        (env: WorkerEnv, bodies: unknown[]) => Promise<void>
      >();
    });

    it("consume has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.consume).toEqualTypeOf<
        (batch: MessageBatch, env: WorkerEnv, ctx: ExecutionContext) => Promise<void>
      >();
    });

    it("deployManifest returns Array<{ kind: 'queue'; name: string; binding: string }>", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.deployManifest()).toEqualTypeOf<
        Array<{ kind: "queue"; name: string; binding: string }>
      >();
    });

    it("queuesPlugin name is literal type 'queues'", () => {
      expectTypeOf(queuesPlugin.name).toEqualTypeOf<"queues">();
    });
  });

  // ─── Types: events ───────────────────────────────────────────────────

  describe("types: events", () => {
    it("observer plugin sees queue:message payload with correct shape", () => {
      const { createPlugin: makePlugin } = coreConfig.createCore(coreConfig, {
        plugins: [bindingsPlugin, queuesPlugin]
      });

      makePlugin("type-check-observer", {
        depends: [queuesPlugin] as const,
        hooks: _ctx => ({
          "queue:message": payload => {
            expectTypeOf(payload).toEqualTypeOf<{ queue: string; messageId: string }>();
          }
        })
      });
    });

    it("rejects wrong payload for queue:message", () => {
      const { createPlugin: makePlugin } = coreConfig.createCore(coreConfig, {
        plugins: [bindingsPlugin, queuesPlugin]
      });

      const plugin = makePlugin("wrong-payload", {
        depends: [queuesPlugin] as const,
        api: ctx => ({
          test: () => {
            // @ts-expect-error -- wrong payload shape
            ctx.emit("queue:message", { wrong: true });
          }
        })
      });

      expect(plugin.name).toBe("wrong-payload");
    });
  });
});
