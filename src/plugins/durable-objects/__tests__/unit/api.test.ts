/**
 * Unit tests for createDoApi — mock context, no kernel / createApp.
 * Uses a structural mock (not PluginCtx) since the domain file needs require().
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { bindingsPlugin } from "../../../bindings";
import { createDoApi } from "../../api";

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
// The api needs config.bindings and ctx.require(bindingsPlugin) — nothing else.
// We use a structural type, not PluginCtx (which only has config/state/emit).
// ---------------------------------------------------------------------------

type MockCtx = {
  config: { bindings: Record<string, string> };
  state: Record<string, never>;
  emit: ReturnType<typeof vi.fn>;
  require: (plugin: typeof bindingsPlugin) => FakeBindingsApi;
};

const createMockCtx = (overrides?: {
  bindings?: Record<string, string>;
  bindingsApi?: FakeBindingsApi;
}): MockCtx => {
  const bindingsApi = overrides?.bindingsApi ?? makeFakeBindings();
  return {
    config: { bindings: overrides?.bindings ?? {} },
    state: {},
    emit: vi.fn(),
    require: (_plugin: typeof bindingsPlugin) => bindingsApi
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDoApi", () => {
  // ─── get: logical name → binding mapping ──────────────────────────────────

  describe("get: logical name → configured binding", () => {
    it("maps logicalName to config.bindings[logicalName] and resolves that binding", () => {
      const counterNs = makeFakeNamespace();
      const env = { COUNTER: counterNs };
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "counter", "room-1");

      expect(stub).toBeDefined();
      expect((stub as unknown as FakeStub).id.name).toBe("room-1");
    });

    it("resolves via the CF binding name (COUNTER), not the logical name (counter)", () => {
      const counterNs = makeFakeNamespace();
      // Only "COUNTER" is in env — if we resolved by "counter", it would throw
      const env = { COUNTER: counterNs };
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "counter", "room-2");
      // Successful resolution proves it looked up COUNTER, not counter
      expect((stub as unknown as FakeStub).id.name).toBe("room-2");
    });

    it("falls back to logicalName as the binding name when it is absent from config.bindings", () => {
      const myDoNs = makeFakeNamespace();
      // The logical name "MY_DO" is not in config.bindings, so falls back to itself
      const env = { MY_DO: myDoNs };
      const ctx = createMockCtx({ bindings: {} });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "MY_DO", "room-3");
      expect((stub as unknown as FakeStub).id.name).toBe("room-3");
    });
  });

  // ─── get: namespace resolution path ──────────────────────────────────────

  describe("get: namespace resolution and stub retrieval", () => {
    it("calls namespace.idFromName(idName) then namespace.get(id) and returns that stub", () => {
      const idFromName = vi.fn((name: string): FakeId => ({ name }));
      const get = vi.fn((id: FakeId): FakeStub => ({ id }));
      const fakeNs = { idFromName, get } as unknown as DurableObjectNamespace;
      const env = { COUNTER: fakeNs };

      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "counter", "room-42");

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
      const env = { COUNTER: fakeNs };

      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const result = api.get(env, "counter", "room-99");
      expect(result).toBe(expectedStub as unknown as DurableObjectStub);
    });
  });

  // ─── get: per-call env (no caching) ──────────────────────────────────────

  describe("get: per-call env — no caching between calls", () => {
    it("resolves namespace from the provided env on each call (different env = different ns)", () => {
      const ns1 = makeFakeNamespace();
      const ns2 = makeFakeNamespace();
      const env1 = { COUNTER: ns1 };
      const env2 = { COUNTER: ns2 };

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
        bindings: { counter: "COUNTER" },
        bindingsApi: trackingBindings
      });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      api.get(env1, "counter", "room-a");
      api.get(env2, "counter", "room-b");

      expect(requireCallArgs).toHaveLength(2);
      expect(requireCallArgs[0]?.[0]).toBe(env1);
      expect(requireCallArgs[1]?.[0]).toBe(env2);
    });
  });

  // ─── get: missing binding surfaces error ──────────────────────────────────

  describe("get: missing binding surfaces error", () => {
    it("throws when the binding is not present on env", () => {
      const env = {}; // COUNTER not present
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      expect(() => api.get(env, "counter", "room")).toThrow(
        '[moku-worker] binding "COUNTER" is not bound.'
      );
    });
  });

  // ─── deployManifest ───────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns { kind: 'do', bindings: {} } when config.bindings is empty (default)", () => {
      const ctx = createMockCtx({ bindings: {} });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();

      expect(manifest).toEqual({ kind: "do", bindings: {} });
    });

    it("returns the correct bindings when overridden from default", () => {
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();

      expect(manifest).toEqual({ kind: "do", bindings: { counter: "COUNTER" } });
    });

    it("manifest changes when config.bindings differ between two ctx instances", () => {
      const ctxEmpty = createMockCtx({ bindings: {} });
      const ctxFull = createMockCtx({ bindings: { chat: "CHAT", counter: "COUNTER" } });

      const manifestEmpty = createDoApi(
        ctxEmpty as Parameters<typeof createDoApi>[0]
      ).deployManifest();
      const manifestFull = createDoApi(
        ctxFull as Parameters<typeof createDoApi>[0]
      ).deployManifest();

      expect(manifestEmpty).toEqual({ kind: "do", bindings: {} });
      expect(manifestFull).toEqual({ kind: "do", bindings: { chat: "CHAT", counter: "COUNTER" } });
    });
  });

  // ─── types: API surface ───────────────────────────────────────────────────

  describe("types: API surface", () => {
    it("get returns DurableObjectStub synchronously (not a Promise)", () => {
      const fakeNs = {
        idFromName: (name: string) => ({ name }),
        get: (id: unknown) => ({ id })
      } as unknown as DurableObjectNamespace;
      const env = { COUNTER: fakeNs };

      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const stub = api.get(env, "counter", "room");
      expect(stub).not.toBeInstanceOf(Promise);
    });

    it("deployManifest().kind is the literal type 'do' (not a generic string)", () => {
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      const manifest = api.deployManifest();
      // Runtime assertion: kind is the string "do"
      expect(manifest.kind).toBe("do");
      // Type assertion: kind is the literal type "do"
      expectTypeOf(manifest.kind).toEqualTypeOf<"do">();
    });

    it("get takes env as the first argument (WorkerEnv = Record<string, unknown>)", () => {
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      expectTypeOf(api.get).toBeFunction();
      expectTypeOf(api.get).parameter(0).toEqualTypeOf<Record<string, unknown>>();
    });

    it("@ts-expect-error: get('counter', 'room') without env as first arg is a type error", () => {
      const ctx = createMockCtx({ bindings: { counter: "COUNTER" } });
      const api = createDoApi(ctx as Parameters<typeof createDoApi>[0]);

      // Wrap in a non-invoked arrow to keep compile-time check without runtime execution.
      const _typeCheckOnly = () => {
        // @ts-expect-error — env is mandatory first argument; two-arg form is rejected
        api.get("counter", "room");
      };

      expect(_typeCheckOnly).toBeDefined();
      expect(api).toBeDefined();
    });
  });
});
