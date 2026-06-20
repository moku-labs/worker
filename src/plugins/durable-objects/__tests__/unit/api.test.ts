/**
 * Unit tests for createDoApi — mock context, no kernel / createApp.
 * Uses a structural mock (not PluginCtx) since the domain file needs require().
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { bindingsPlugin } from "../../../bindings";
import { createDoApi } from "../../api";
import type { Config } from "../../types";

// ---------------------------------------------------------------------------
// Fake types
// ---------------------------------------------------------------------------

/** Fake DurableObjectId returned by idFromName. */
type FakeId = { name: string };

/** Fake DurableObjectStub returned by namespace.get. */
type FakeStub = { id: FakeId };

/** Fake DurableObjectNamespace backed by fake stubs. */
type FakeNamespace = {
  idFromName: (name: string) => FakeId;
  get: (id: FakeId) => FakeStub;
};

const makeFakeNamespace = (): FakeNamespace => ({
  idFromName: (name: string): FakeId => ({ name }),
  get: (id: FakeId): FakeStub => ({ id })
});

/** Fake bindings API — structural (not imported from bindings). */
type FakeBindingsApi = {
  require: <T>(env: Record<string, unknown>, name: string) => T;
  has: (env: Record<string, unknown>, name: string) => boolean;
};

const makeFakeBindings = (): FakeBindingsApi => ({
  require: <T>(env: Record<string, unknown>, name: string): T => {
    const value = env[name];
    if (value === undefined || value === null) {
      throw new Error(
        `[moku-worker] binding "${name}" is not bound.\n` +
          `  Declare it in wrangler config and pass it in via the request env.`
      );
    }
    return value as T;
  },
  has: (env: Record<string, unknown>, name: string): boolean =>
    env[name] !== undefined && env[name] !== null
});

// ---------------------------------------------------------------------------
// Structural mock context factory
// The api needs the keyed-map config and ctx.require(bindingsPlugin) — nothing else.
// We use a structural type, not PluginCtx (which only has config/state/emit).
// ---------------------------------------------------------------------------

type MockCtx = {
  config: Config;
  state: Record<string, never>;
  emit: ReturnType<typeof vi.fn>;
  require: (plugin: typeof bindingsPlugin) => FakeBindingsApi;
};

const createMockCtx = (overrides?: { config?: Config; bindingsApi?: FakeBindingsApi }): MockCtx => {
  const bindingsApi = overrides?.bindingsApi ?? makeFakeBindings();
  return {
    config: overrides?.config ?? {},
    state: {},
    emit: vi.fn(),
    require: (_plugin: typeof bindingsPlugin) => bindingsApi
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDoApi", () => {
  // ─── get: logical key → instance binding ──────────────────────────────────

  describe("get: logical key → configured instance binding", () => {
    it("selects the instance by key and resolves env.<binding>", () => {
      const boardNs = makeFakeNamespace();
      const env = { BOARD: boardNs };
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "board", "room-1");

      expect(stub).toBeDefined();
      expect((stub as unknown as FakeStub).id.name).toBe("room-1");
    });

    it("resolves via the instance binding (BOARD), not the logical key (board)", () => {
      const boardNs = makeFakeNamespace();
      // Only "BOARD" is in env — if we resolved by "board", it would throw
      const env = { BOARD: boardNs };
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "board", "room-2");
      // Successful resolution proves it looked up BOARD, not board
      expect((stub as unknown as FakeStub).id.name).toBe("room-2");
    });

    it("throws a branded error when the logical key is not configured", () => {
      const env = { BOARD: makeFakeNamespace() };
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      expect(() => api.get(env, "missing", "room-3")).toThrow(
        '[moku-worker] No durableObjects instance "missing".'
      );
    });
  });

  // ─── get: namespace resolution path ──────────────────────────────────────

  describe("get: namespace resolution and stub retrieval", () => {
    it("calls namespace.idFromName(idName) then namespace.get(id) and returns that stub", () => {
      const idFromName = vi.fn((name: string): FakeId => ({ name }));
      const get = vi.fn((id: FakeId): FakeStub => ({ id }));
      const fakeNs = { idFromName, get } as unknown as DurableObjectNamespace;
      const env = { BOARD: fakeNs };

      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "board", "room-42");

      expect(idFromName).toHaveBeenCalledWith("room-42");
      expect(get).toHaveBeenCalledWith({ name: "room-42" });
      expect(stub).toBe((get.mock.results[0] as { type: "return"; value: FakeStub }).value);
    });

    it("returns the exact stub produced by namespace.get(id)", () => {
      const expectedStub = { id: { name: "room-99" }, specialProp: "unique" };
      const fakeNs = {
        idFromName: (name: string) => ({ name }),
        get: () => expectedStub
      } as unknown as DurableObjectNamespace;
      const env = { BOARD: fakeNs };

      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const result = api.get(env, "board", "room-99");
      expect(result).toBe(expectedStub as unknown as DurableObjectStub);
    });
  });

  // ─── get: default instance resolution ─────────────────────────────────────

  describe("get: multi-instance selection by key", () => {
    it("selects the right instance among several by its key", () => {
      const boardNs = makeFakeNamespace();
      const chatNs = makeFakeNamespace();
      const env = { BOARD: boardNs, CHAT: chatNs };
      const ctx = createMockCtx({
        config: {
          board: { binding: "BOARD", className: "BoardChannel" },
          chat: { binding: "CHAT", className: "ChatRoom" }
        }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "chat", "room-7");

      expect((stub as unknown as FakeStub).id.name).toBe("room-7");
    });
  });

  // ─── get: per-call env (no caching) ──────────────────────────────────────

  describe("get: per-call env — no caching between calls", () => {
    it("resolves namespace from the provided env on each call (different env = different ns)", () => {
      const ns1 = makeFakeNamespace();
      const ns2 = makeFakeNamespace();
      const env1 = { BOARD: ns1 };
      const env2 = { BOARD: ns2 };

      const requireCallArgs: Array<[Record<string, unknown>, string]> = [];
      const trackingBindings: FakeBindingsApi = {
        require: <T>(env: Record<string, unknown>, name: string): T => {
          requireCallArgs.push([env, name]);
          const value = env[name];
          if (value === undefined || value === null) {
            throw new Error(`[moku-worker] binding "${name}" is not bound.`);
          }
          return value as T;
        },
        has: () => true
      };

      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } },
        bindingsApi: trackingBindings
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      api.get(env1, "board", "room-a");
      api.get(env2, "board", "room-b");

      expect(requireCallArgs).toHaveLength(2);
      expect(requireCallArgs[0]?.[0]).toBe(env1);
      expect(requireCallArgs[1]?.[0]).toBe(env2);
    });
  });

  // ─── get: missing binding surfaces error ──────────────────────────────────

  describe("get: missing binding surfaces error", () => {
    it("throws when the binding is not present on env", () => {
      const env = {}; // BOARD not present
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      expect(() => api.get(env, "board", "room")).toThrow(
        '[moku-worker] binding "BOARD" is not bound.'
      );
    });
  });

  // ─── deployManifest ───────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns [] when config is empty (default)", () => {
      const ctx = createMockCtx({ config: {} });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();

      expect(manifest).toEqual([]);
    });

    it("returns one { kind: 'do', binding, className } entry per configured instance", () => {
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();

      expect(manifest).toEqual([{ kind: "do", binding: "BOARD", className: "BoardChannel" }]);
    });

    it("decouples className from the logical key (key 'board' → class 'BoardChannel')", () => {
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const [entry] = api.deployManifest();

      expect(entry?.className).toBe("BoardChannel");
      expect(entry?.binding).toBe("BOARD");
    });

    it("emits one entry per instance for multi-instance configs", () => {
      const ctx = createMockCtx({
        config: {
          board: { binding: "BOARD", className: "BoardChannel" },
          chat: { binding: "CHAT", className: "ChatRoom" }
        }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();

      expect(manifest).toEqual([
        { kind: "do", binding: "BOARD", className: "BoardChannel" },
        { kind: "do", binding: "CHAT", className: "ChatRoom" }
      ]);
    });
  });

  // ─── types: API surface ───────────────────────────────────────────────────

  describe("types: API surface", () => {
    it("get returns DurableObjectStub synchronously (not a Promise)", () => {
      const fakeNs = {
        idFromName: (name: string) => ({ name }),
        get: (id: unknown) => ({ id })
      } as unknown as DurableObjectNamespace;
      const env = { BOARD: fakeNs };

      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "board", "room");
      expect(stub).not.toBeInstanceOf(Promise);
    });

    it("deployManifest() entries' kind is the literal type 'do' (not a generic string)", () => {
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();
      // Runtime assertion: every entry's kind is the string "do"
      expect(manifest[0]?.kind).toBe("do");
      // Type assertion: the array element type is the do descriptor
      expectTypeOf(manifest).toEqualTypeOf<
        Array<{ kind: "do"; binding: string; className: string }>
      >();
    });

    it("get takes env as the first argument (WorkerEnv = Record<string, unknown>)", () => {
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      expectTypeOf(api.get).toBeFunction();
      expectTypeOf(api.get).parameter(0).toEqualTypeOf<Record<string, unknown>>();
    });

    it("@ts-expect-error: get('board', 'room') without env as first arg is a type error", () => {
      const ctx = createMockCtx({
        config: { board: { binding: "BOARD", className: "BoardChannel" } }
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      // Wrap in a non-invoked arrow to keep compile-time check without runtime execution.
      const _typeCheckOnly = () => {
        // @ts-expect-error — env is mandatory first argument; two-arg form is rejected
        api.get("board", "room");
      };

      expect(_typeCheckOnly).toBeDefined();
      expect(api).toBeDefined();
    });
  });
});
