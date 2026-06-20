/**
 * Integration tests for the durableObjects plugin — real createApp (no start/stop).
 * Uses a test-local coreConfig to isolate from sibling plugins (some may still be stubs).
 */
import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkerConfig, WorkerEnv, WorkerEvents } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { defineDurableObject } from "../../helpers";
import { durableObjectsPlugin } from "../../index";
import type { Config } from "../../types";

// ---------------------------------------------------------------------------
// Test-local coreConfig — isolates from siblings that may still be stubs.
// ---------------------------------------------------------------------------

const testCoreConfig = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
  config: {
    stage: "test",
    name: "do-test",
    compatibilityDate: ""
  }
});

// ---------------------------------------------------------------------------
// Fake DO types (test doubles)
// ---------------------------------------------------------------------------

/** Fake DurableObjectId */
type FakeId = { name: string };

/** Fake DurableObjectStub */
type FakeStub = { id: FakeId; fetch: (url: string) => Promise<Response> };

/** Fake DurableObjectNamespace */
type FakeNamespace = {
  idFromName: (name: string) => FakeId;
  get: (id: FakeId) => FakeStub;
};

const makeFakeNamespace = (): FakeNamespace => ({
  idFromName: (name: string): FakeId => ({ name }),
  get: (id: FakeId): FakeStub => ({
    id,
    fetch: (_url: string) => Promise.resolve(new Response("ok"))
  })
});

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

/** Default keyed-map config used by createTestApp when no override is provided. */
const defaultTestConfig: Config = { board: { binding: "BOARD", className: "BoardChannel" } };

/**
 * Creates a test app with bindingsPlugin ordered before durableObjectsPlugin,
 * satisfying the depends:[bindingsPlugin] requirement.
 *
 * @param config - Optional keyed-map plugin config override for durableObjects.
 * @returns The created app instance.
 */
const createTestApp = (config: Config = defaultTestConfig) => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin, durableObjectsPlugin]
  });
  return createApp({
    pluginConfigs: {
      durableObjects: config
    }
  });
};

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("durableObjects plugin (integration)", () => {
  // ─── wiring & api surface ─────────────────────────────────────────────────

  describe("wiring: createApp with bindingsPlugin + durableObjectsPlugin", () => {
    it("mounts app.durableObjects after createApp", () => {
      const app = createTestApp();

      expect(app.durableObjects).toBeDefined();
    });

    it("exposes get and deployManifest on app.durableObjects", () => {
      const app = createTestApp();

      expect(typeof app.durableObjects.get).toBe("function");
      expect(typeof app.durableObjects.deployManifest).toBe("function");
    });

    it("does not require app.start() or app.stop() — request-scoped plugin", () => {
      // Should not throw when used without lifecycle
      expect(() => createTestApp()).not.toThrow();
    });

    it("app.bindings is also present (bindingsPlugin is a dependency)", () => {
      const app = createTestApp();

      expect(app.bindings).toBeDefined();
    });
  });

  // ─── runtime: get resolves stub ───────────────────────────────────────────

  describe("runtime: get resolves a DO stub from a stub env", () => {
    it("get(env, 'board', id) resolves a stub from the BOARD namespace", () => {
      const fakeBoard = makeFakeNamespace();
      const env: WorkerEnv = { BOARD: fakeBoard };

      const app = createTestApp();

      const stub = app.durableObjects.get(env, "board", "room");

      expect(stub).toBeDefined();
      expect((stub as unknown as FakeStub).id.name).toBe("room");
    });

    it("get selects the instance by its logical key (key → instance binding)", () => {
      const fakeChat = makeFakeNamespace();
      const env: WorkerEnv = { CHAT_DO: fakeChat };

      const app = createTestApp({ chat: { binding: "CHAT_DO", className: "ChatRoom" } });

      const stub = app.durableObjects.get(env, "chat", "room-99");

      expect((stub as unknown as FakeStub).id.name).toBe("room-99");
    });

    it("get resolves idName via idFromName and returns the stub from namespace.get", () => {
      const fakeNs = makeFakeNamespace();
      const env: WorkerEnv = { BOARD: fakeNs };

      const app = createTestApp();

      const stub = app.durableObjects.get(env, "board", "specific-room");
      expect((stub as unknown as FakeStub).id.name).toBe("specific-room");
    });

    it("throws a branded error when the logical key is not configured", () => {
      const env: WorkerEnv = { BOARD: makeFakeNamespace() };
      const app = createTestApp();

      expect(() => app.durableObjects.get(env, "nope", "room")).toThrow(
        '[moku-worker] No durableObjects instance "nope".'
      );
    });
  });

  // ─── runtime: deployManifest ──────────────────────────────────────────────

  describe("runtime: deployManifest returns correct metadata", () => {
    it("deployManifest() returns one { kind: 'do', binding, className } per instance", () => {
      const app = createTestApp();

      const manifest = app.durableObjects.deployManifest();

      expect(manifest).toEqual([{ kind: "do", binding: "BOARD", className: "BoardChannel" }]);
    });

    it("deployManifest() decouples className from the logical key", () => {
      const app = createTestApp({ board: { binding: "BOARD", className: "BoardChannel" } });

      const [entry] = app.durableObjects.deployManifest();

      expect(entry?.binding).toBe("BOARD");
      expect(entry?.className).toBe("BoardChannel");
    });

    it("deployManifest() returns [] with the empty default config", () => {
      const { createApp } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [bindingsPlugin, durableObjectsPlugin]
      });
      const app = createApp();

      const manifest = app.durableObjects.deployManifest();

      expect(manifest).toEqual([]);
    });
  });

  // ─── re-exported defineDurableObject ──────────────────────────────────────

  describe("re-exported defineDurableObject: consumer can extend the base class", () => {
    it("a class from defineDurableObject can be extended and instantiated", () => {
      const Base = defineDurableObject("BoardChannel");

      expect(Base).toBeDefined();
      expect(Base.doName).toBe("BoardChannel");

      class BoardChannel extends Base {
        async fetch(): Promise<Response> {
          return new Response("count");
        }
      }

      const fakeState = { storage: {}, id: {} } as unknown as DurableObjectState;
      const fakeEnv: WorkerEnv = {};
      const instance = new BoardChannel(fakeState, fakeEnv);

      expect(instance.ctx).toBe(fakeState);
      expect(instance.env).toBe(fakeEnv);
      expect(instance).toBeInstanceOf(Base);
    });
  });

  // ─── depends: bindingsPlugin must be registered first ─────────────────────

  describe("depends: bindingsPlugin must be registered before durableObjectsPlugin", () => {
    it("createApp succeeds when bindingsPlugin precedes durableObjectsPlugin", () => {
      expect(() => {
        const { createApp } = testCoreConfig.createCore(testCoreConfig, {
          plugins: [bindingsPlugin, durableObjectsPlugin]
        });
        createApp({
          pluginConfigs: {
            durableObjects: { board: { binding: "BOARD", className: "BoardChannel" } }
          }
        });
      }).not.toThrow();
    });
  });

  // ─── types: app.durableObjects surface ────────────────────────────────────

  describe("types: app.durableObjects API surface", () => {
    it("app.durableObjects has get (function) and deployManifest (function)", () => {
      const app = createTestApp();

      expectTypeOf(app.durableObjects.get).toBeFunction();
      expectTypeOf(app.durableObjects.deployManifest).toBeFunction();
    });

    it("get(env, logical, id) returns DurableObjectStub synchronously (not a Promise)", () => {
      const fakeNs = makeFakeNamespace();
      const env: WorkerEnv = { BOARD: fakeNs };
      const app = createTestApp();

      const result = app.durableObjects.get(env, "board", "room");

      expect(result).not.toBeInstanceOf(Promise);
    });

    it("deployManifest() returns an array of { kind: 'do'; binding; className }", () => {
      const app = createTestApp();

      const manifest = app.durableObjects.deployManifest();

      expectTypeOf(manifest).toEqualTypeOf<
        Array<{ kind: "do"; binding: string; className: string }>
      >();
      expect(manifest[0]?.kind).toBe("do");
    });

    it("@ts-expect-error: get('board', 'room') without env as first arg is rejected", () => {
      const app = createTestApp();

      // Wrap in a non-invoked arrow to keep compile-time check without runtime execution.
      const _typeCheckOnly = () => {
        // @ts-expect-error — env is the mandatory first argument; two-arg form is rejected
        app.durableObjects.get("board", "room");
      };

      expect(_typeCheckOnly).toBeDefined();
      expect(app).toBeDefined();
    });

    it("defineDurableObject produces instances with ctx: DurableObjectState and env: WorkerEnv", () => {
      const Base = defineDurableObject("TypeTest");
      const fakeState = { storage: {} } as unknown as DurableObjectState;
      const fakeEnv: WorkerEnv = {};

      class TypeTest extends Base {}
      const instance = new TypeTest(fakeState, fakeEnv);

      expectTypeOf(instance.ctx).toEqualTypeOf<DurableObjectState>();
      expectTypeOf(instance.env).toEqualTypeOf<Record<string, unknown>>();
    });
  });
});
