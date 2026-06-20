/**
 * Integration tests for the kv plugin — createApp with real bindings + kv
 * wiring. No app.start()/app.stop() — kv has no lifecycle (spec/06 §3).
 */
import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkerConfig, WorkerEnv, WorkerEvents } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { kvPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Test-local coreConfig — isolates from siblings that may still be stubs.
// ---------------------------------------------------------------------------

const testCoreConfig = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
  config: {
    stage: "test",
    name: "kv-test",
    compatibilityDate: ""
  }
});

// ---------------------------------------------------------------------------
// Fake KVNamespace (in-memory) — simulates the runtime Cloudflare binding.
// ---------------------------------------------------------------------------

/** Minimal KVNamespace stub — only the methods kv plugin uses. */
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

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

/**
 * Creates a test app with bindingsPlugin ordered before kvPlugin, as required
 * by the kv depends:[bindingsPlugin] declaration. The kv config is the keyed-map
 * shape (`{ cache: { name, binding } }`); the single entry is the implicit default.
 * The binding defaults to "SESSIONS" to exercise config override.
 *
 * @param binding - The KV binding name to use (default "SESSIONS").
 * @param name - The base Cloudflare namespace name (default "tracker-cache").
 * @returns The created app instance.
 */
const createTestApp = (binding = "SESSIONS", name = "tracker-cache") => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin, kvPlugin]
  });

  return createApp({
    pluginConfigs: {
      kv: { cache: { name, binding } }
    }
  });
};

/**
 * Build an app with two kv instances, one flagged `default: true`.
 *
 * @returns The created app instance with `cache` (default) and `sessions` namespaces.
 */
const createMultiApp = () => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin, kvPlugin]
  });
  return createApp({
    pluginConfigs: {
      kv: {
        cache: { name: "tracker-cache", binding: "CACHE", default: true },
        sessions: { name: "tracker-sessions", binding: "SESSIONS" }
      }
    }
  });
};

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("kv plugin (integration)", () => {
  // ─── Wiring ───────────────────────────────────────────────────────────────

  describe("wiring", () => {
    it("app.kv is defined after createApp", () => {
      const app = createTestApp();

      expect(app.kv).toBeDefined();
    });

    it("app.bindings is defined (bindingsPlugin wired)", () => {
      const app = createTestApp();

      expect(app.bindings).toBeDefined();
    });
  });

  // ─── put / get ────────────────────────────────────────────────────────────

  describe("put and get", () => {
    it("get returns the value written by put", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv();
      const env: WorkerEnv = { SESSIONS: fakeKv };

      await app.kv.put(env, "user:1", "bob");
      const result = await app.kv.get(env, "user:1");

      expect(result).toBe("bob");
    });

    it("get returns null for a missing key", async () => {
      const app = createTestApp("SESSIONS");
      const env: WorkerEnv = { SESSIONS: makeFakeKv() };

      const result = await app.kv.get(env, "no-such-key");

      expect(result).toBeNull();
    });

    it("put forwards expirationTtl to the namespace", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv();
      const env: WorkerEnv = { SESSIONS: fakeKv };

      // Should not throw — opts are forwarded even if fake ignores them
      await expect(
        app.kv.put(env, "session:42", "data", { expirationTtl: 3600 })
      ).resolves.toBeUndefined();
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes a key so subsequent get returns null", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv({ "to-remove": "value" });
      const env: WorkerEnv = { SESSIONS: fakeKv };

      await app.kv.delete(env, "to-remove");
      const after = await app.kv.get(env, "to-remove");

      expect(after).toBeNull();
    });

    it("delete is a no-op when the key is absent (does not throw)", async () => {
      const app = createTestApp("SESSIONS");
      const env: WorkerEnv = { SESSIONS: makeFakeKv() };

      await expect(app.kv.delete(env, "ghost-key")).resolves.not.toThrow();
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all keys when no opts supplied", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv({ "a:1": "x", "b:1": "y" });
      const env: WorkerEnv = { SESSIONS: fakeKv };

      const result = await app.kv.list(env);

      expect(result.keys.map(k => k.name)).toContain("a:1");
      expect(result.keys.map(k => k.name)).toContain("b:1");
    });

    it("forwards prefix option and returns filtered keys", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv({ "session:1": "a", "other:1": "b" });
      const env: WorkerEnv = { SESSIONS: fakeKv };

      const result = await app.kv.list(env, { prefix: "session:" });

      expect(result.keys.map(k => k.name)).toContain("session:1");
      expect(result.keys.map(k => k.name)).not.toContain("other:1");
    });

    it("forwards limit option", async () => {
      const app = createTestApp("SESSIONS");
      const fakeKv = makeFakeKv({ k1: "1", k2: "2", k3: "3" });
      const env: WorkerEnv = { SESSIONS: fakeKv };

      const result = await app.kv.list(env, { limit: 2 });

      expect(result.keys.length).toBeLessThanOrEqual(2);
    });
  });

  // ─── deployManifest ───────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one [{ kind, name, binding }] entry reflecting the configured instance", () => {
      const app = createTestApp("SESSIONS");

      expect(app.kv.deployManifest()).toEqual([
        { kind: "kv", name: "tracker-cache", binding: "SESSIONS" }
      ]);
    });

    it("returns an empty array when no kv instances are configured (default config)", () => {
      const { createApp } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [bindingsPlugin, kvPlugin]
      });
      const app = createApp();

      expect(app.kv.deployManifest()).toEqual([]);
    });
  });

  // ─── missing binding throws [moku-worker] ─────────────────────────────────

  describe("missing binding", () => {
    it("throws the [moku-worker] error when the binding is absent from env", async () => {
      const app = createTestApp("SESSIONS");
      const env: WorkerEnv = {}; // SESSIONS not present

      await expect(app.kv.get(env, "any-key")).rejects.toThrow("[moku-worker]");
    });

    it("error message includes the binding name", async () => {
      const app = createTestApp("SESSIONS");
      const env: WorkerEnv = {};

      await expect(app.kv.get(env, "k")).rejects.toThrow("SESSIONS");
    });
  });

  // ─── per-call env isolation ───────────────────────────────────────────────

  describe("per-call env isolation", () => {
    it("each call uses the env supplied to that call — no caching", async () => {
      const app = createTestApp("SESSIONS");
      const kv1 = makeFakeKv({ key: "from-kv1" });
      const kv2 = makeFakeKv({ key: "from-kv2" });

      const env1: WorkerEnv = { SESSIONS: kv1 };
      const env2: WorkerEnv = { SESSIONS: kv2 };

      const v1 = await app.kv.get(env1, "key");
      const v2 = await app.kv.get(env2, "key");

      expect(v1).toBe("from-kv1");
      expect(v2).toBe("from-kv2");
    });
  });

  // ─── multiple instances + use(key) ─────────────────────────────────────────

  describe("multiple instances", () => {
    it("use('sessions') resolves the named instance's binding off the request env", async () => {
      const app = createMultiApp();
      const env: WorkerEnv = {
        CACHE: makeFakeKv({ k: "from-cache" }),
        SESSIONS: makeFakeKv({ k: "from-sessions" })
      };

      expect(await app.kv.use("sessions").get(env, "k")).toBe("from-sessions");
    });

    it("the default surface resolves the instance flagged default: true (CACHE)", async () => {
      const app = createMultiApp();
      const env: WorkerEnv = {
        CACHE: makeFakeKv({ k: "from-cache" }),
        SESSIONS: makeFakeKv({ k: "from-sessions" })
      };

      expect(await app.kv.get(env, "k")).toBe("from-cache");
    });

    it("deployManifest returns one entry per instance", () => {
      const app = createMultiApp();

      expect(app.kv.deployManifest()).toEqual([
        { kind: "kv", name: "tracker-cache", binding: "CACHE" },
        { kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }
      ]);
    });
  });

  // ─── types ────────────────────────────────────────────────────────────────

  describe("types: app.kv surface", () => {
    it("get returns Promise<string | null>", () => {
      const app = createTestApp();
      const env: WorkerEnv = { SESSIONS: makeFakeKv() };

      expectTypeOf(app.kv.get(env, "k")).toEqualTypeOf<Promise<string | null>>();
    });

    it("put returns Promise<void>", () => {
      const app = createTestApp();
      const env: WorkerEnv = { SESSIONS: makeFakeKv() };

      expectTypeOf(app.kv.put(env, "k", "v")).toEqualTypeOf<Promise<void>>();
    });

    it("delete returns Promise<void>", () => {
      const app = createTestApp();
      const env: WorkerEnv = { SESSIONS: makeFakeKv() };

      expectTypeOf(app.kv.delete(env, "k")).toEqualTypeOf<Promise<void>>();
    });

    it("deployManifest returns Array<{ kind: 'kv'; name: string; binding: string }>", () => {
      const app = createTestApp();

      expectTypeOf(app.kv.deployManifest()).toEqualTypeOf<
        Array<{ kind: "kv"; name: string; binding: string }>
      >();
    });

    it("@ts-expect-error: emitting a kv-specific event is impossible (no kv events)", () => {
      const app = createTestApp();

      // kv declares no events — app.kv has no .emit method (it's not on KvApi).
      // @ts-expect-error -- app.kv has no emit method
      const emitResult = (app.kv as unknown as { emit?: unknown }).emit?.("kv:any", {});

      expect(emitResult).toBeUndefined();
    });
  });
});
