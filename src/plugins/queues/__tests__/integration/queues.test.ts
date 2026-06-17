import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv } from "../../../../config";
import { coreConfig, createPlugin } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { queuesPlugin } from "../../index";

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

const createTestApp = (
  onMessage?: (message: Message, env: WorkerEnv) => Promise<void>,
  producers: string[] = ["jobs"]
) => {
  const { createApp } = coreConfig.createCore(coreConfig, {
    plugins: [bindingsPlugin, queuesPlugin]
  });

  return createApp({
    pluginConfigs: {
      queues: {
        producers,
        onMessage: onMessage ?? (async () => {})
      }
    }
  });
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

    it("exposes send, sendBatch, consume, deployManifest", () => {
      const app = createTestApp();

      expect(typeof app.queues.send).toBe("function");
      expect(typeof app.queues.sendBatch).toBe("function");
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

  // ─── Runtime: send ───────────────────────────────────────────────────

  describe("runtime: send", () => {
    it("delegates to Queue.send via bindings", async () => {
      const fakeQueue = makeFakeQueue();
      const env = makeEnv({ JOBS: fakeQueue });
      const app = createTestApp();

      await app.queues.send(env, "JOBS", { task: "process" });

      expect(fakeQueue.send).toHaveBeenCalledTimes(1);
      expect(fakeQueue.send).toHaveBeenCalledWith({ task: "process" });
    });
  });

  // ─── Runtime: consume + Worker queue() delegation shape ───────────────

  describe("runtime: consume", () => {
    it("matches the Worker queue() delegation shape", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const app = createTestApp(onMessage);

      const msgs = [makeMessage("m1"), makeMessage("m2")];
      const batch = makeBatch("jobs", msgs);
      const exec = makeExec();

      // This is exactly how the Worker entry delegates: app.queues.consume(batch, env, exec)
      await app.queues.consume(batch, makeEnv({}), exec);

      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(onMessage).toHaveBeenNthCalledWith(1, msgs[0], expect.any(Object));
      expect(onMessage).toHaveBeenNthCalledWith(2, msgs[1], expect.any(Object));
    });

    it("works without calling app.start() or app.stop() (request-scoped Worker)", async () => {
      const onMessage = vi.fn().mockResolvedValue(undefined);
      const app = createTestApp(onMessage);

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
          queues: { producers: ["jobs"], onMessage: async () => {} }
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
    it("returns { kind: 'queue', producers } from config", () => {
      const app = createTestApp(undefined, ["orders", "notifications"]);

      expect(app.queues.deployManifest()).toEqual({
        kind: "queue",
        producers: ["orders", "notifications"]
      });
    });
  });

  // ─── Types: API signatures ────────────────────────────────────────────

  describe("types: API signatures", () => {
    it("send has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.send).toEqualTypeOf<
        (env: WorkerEnv, q: string, body: unknown) => Promise<void>
      >();
    });

    it("sendBatch has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.sendBatch).toEqualTypeOf<
        (env: WorkerEnv, q: string, bodies: unknown[]) => Promise<void>
      >();
    });

    it("consume has the correct signature", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.consume).toEqualTypeOf<
        (batch: MessageBatch, env: WorkerEnv, exec: ExecutionContext) => Promise<void>
      >();
    });

    it("deployManifest returns { kind: 'queue'; producers: string[] }", () => {
      const app = createTestApp();

      expectTypeOf(app.queues.deployManifest).toEqualTypeOf<
        () => { kind: "queue"; producers: string[] }
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
