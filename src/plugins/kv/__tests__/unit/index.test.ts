/**
 * Unit tests for the kv plugin — mock ctx whose require(bindingsPlugin) wraps
 * an in-memory KV fake. No kernel / createApp — pure function-level assertions.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { WorkerEnv } from "../../../../config";
import type { bindingsPlugin } from "../../../bindings";
import type { Context } from "../../api";
import { createKvApi } from "../../api";
import type { KvApi } from "../../index";
import { kvPlugin } from "../../index";

// ---------------------------------------------------------------------------
// In-memory KV namespace fake
// ---------------------------------------------------------------------------

/** Minimal in-memory KVNamespace stub matching the methods kv uses. */
const makeKvFake = (initial: Record<string, string> = {}) => {
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
    list: vi.fn(
      async (
        _opts?: unknown
      ): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor: string }> => ({
        keys: Object.keys(store).map(name => ({ name })),
        list_complete: true,
        cursor: ""
      })
    ),
    _store: store
  };
};

// ---------------------------------------------------------------------------
// Mock context factory — satisfies the Context shape required by createKvApi.
// ctx.require(bindingsPlugin) returns a stub bindings api wrapping kvFake.
// ---------------------------------------------------------------------------

/**
 * Creates a mock Context for direct createKvApi testing. The config is the keyed-map shape
 * (`{ <key>: { name, binding } }`); a single entry is the implicit default.
 * ctx.require(bindingsPlugin) delegates to an in-memory KV fake.
 *
 * @param kvFake - The in-memory KV fake to resolve via require.
 * @param binding - The binding name stored in config (default "KV").
 * @param key - The instance key under which the namespace is configured (default "cache").
 * @param name - The base Cloudflare namespace name stored in config (default "tracker-cache").
 * @returns A mock Context compatible with createKvApi.
 */
const makeMockCtx = (
  kvFake: ReturnType<typeof makeKvFake>,
  binding = "KV",
  key = "cache",
  name = "tracker-cache"
): Context => {
  // Stub bindings API: require<T>(env, name) returns kvFake when name === binding
  const stubBindingsApi = {
    require: <T>(env: WorkerEnv, lookup: string): T => {
      // Prefer env-supplied value (integration-style testing)
      if (env[lookup] !== undefined) {
        return env[lookup] as T;
      }
      if (lookup === binding) {
        return kvFake as unknown as T;
      }
      throw new Error(
        `[moku-worker] binding "${lookup}" is not bound.\n  Declare it in wrangler config.`
      );
    },
    has: (env: WorkerEnv, lookup: string): boolean => env[lookup] !== undefined
  };

  const ctx = {
    config: { [key]: { name, binding } },
    state: {} as Record<string, never>,
    emit: vi.fn() as Context["emit"],
    require: (_plugin: typeof bindingsPlugin) => stubBindingsApi,
    has: vi.fn(() => true)
  };

  return ctx as unknown as Context;
};

// ---------------------------------------------------------------------------
// Convenience: produce a KvApi from an in-memory fake.
// ---------------------------------------------------------------------------

/**
 * Builds a KvApi instance backed by an in-memory KV fake (single-instance keyed-map config).
 *
 * @param kvFake - The KV fake to use.
 * @param binding - The binding name (default "KV").
 * @returns A KvApi instance ready for testing.
 */
const makeApi = (kvFake: ReturnType<typeof makeKvFake>, binding = "KV"): KvApi =>
  createKvApi(makeMockCtx(kvFake, binding));

/**
 * Build a ctx with two configured instances whose bindings resolve to distinct fakes,
 * so `use(key)` can be shown to pick the right namespace.
 *
 * @param cacheFake - The fake the CACHE binding resolves to.
 * @param sessionsFake - The fake the SESSIONS binding resolves to.
 * @returns A Context wiring the two fakes by binding name.
 */
const twoInstanceCtx = (
  cacheFake: ReturnType<typeof makeKvFake>,
  sessionsFake: ReturnType<typeof makeKvFake>
): Context =>
  ({
    config: {
      cache: { name: "tracker-cache", binding: "CACHE", default: true },
      sessions: { name: "tracker-sessions", binding: "SESSIONS" }
    },
    state: {} as Record<string, never>,
    emit: vi.fn() as Context["emit"],
    require: (_plugin: typeof bindingsPlugin) => ({
      require: <T>(_env: WorkerEnv, name: string): T =>
        (name === "SESSIONS" ? sessionsFake : cacheFake) as unknown as T,
      has: (_env: WorkerEnv, _name: string) => true
    }),
    has: vi.fn(() => true)
  }) as unknown as Context;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kv plugin — unit", () => {
  // ─── get ──────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns the stored string value for a present key", async () => {
      const kv = makeKvFake({ "session:1": "alice" });
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      const value = await api.get(env, "session:1");

      expect(value).toBe("alice");
    });

    it("returns null when the key is absent", async () => {
      const kv = makeKvFake();
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      const value = await api.get(env, "missing-key");

      expect(value).toBeNull();
    });
  });

  // ─── put ──────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("writes the value and makes it retrievable via get", async () => {
      const kv = makeKvFake();
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await api.put(env, "flag", "enabled");
      const value = await api.get(env, "flag");

      expect(value).toBe("enabled");
    });

    it("forwards opts (e.g. expirationTtl) to the underlying namespace", async () => {
      const kv = makeKvFake();
      const putSpy = vi.spyOn(kv, "put");
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await api.put(env, "session:42", "data", { expirationTtl: 3600 });

      expect(putSpy).toHaveBeenCalledWith("session:42", "data", { expirationTtl: 3600 });
    });

    it("put without opts passes opts as undefined to the namespace", async () => {
      const kv = makeKvFake();
      const putSpy = vi.spyOn(kv, "put");
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await api.put(env, "k", "v");

      expect(putSpy).toHaveBeenCalledWith("k", "v", undefined);
    });
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes an existing key so subsequent get returns null", async () => {
      const kv = makeKvFake({ "to-delete": "bye" });
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await api.delete(env, "to-delete");
      const value = await api.get(env, "to-delete");

      expect(value).toBeNull();
    });

    it("is a no-op when the key is absent (does not throw)", async () => {
      const kv = makeKvFake();
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await expect(api.delete(env, "non-existent")).resolves.not.toThrow();
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns keys from the namespace", async () => {
      const kv = makeKvFake({ "session:1": "a", "session:2": "b" });
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      const result = await api.list(env);

      expect(result.keys.map(k => k.name)).toContain("session:1");
      expect(result.keys.map(k => k.name)).toContain("session:2");
    });

    it("forwards opts (prefix / limit / cursor) to the namespace list call", async () => {
      const kv = makeKvFake();
      const api = makeApi(kv);
      const env: WorkerEnv = {};
      const opts = { prefix: "session:", limit: 10, cursor: "abc" };

      await api.list(env, opts);

      expect(kv.list).toHaveBeenCalledWith(opts);
    });

    it("list without opts passes opts as undefined to the namespace", async () => {
      const kv = makeKvFake();
      const api = makeApi(kv);
      const env: WorkerEnv = {};

      await api.list(env);

      expect(kv.list).toHaveBeenCalledWith(undefined);
    });
  });

  // ─── deployManifest ───────────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one [{ kind: 'kv', name, binding }] entry for the default instance", () => {
      const api = makeApi(makeKvFake());

      expect(api.deployManifest()).toEqual([{ kind: "kv", name: "tracker-cache", binding: "KV" }]);
    });

    it("reflects the overridden binding name (SESSIONS)", () => {
      const api = makeApi(makeKvFake(), "SESSIONS");

      expect(api.deployManifest()).toEqual([
        { kind: "kv", name: "tracker-cache", binding: "SESSIONS" }
      ]);
    });

    it("returns one entry per configured instance (keyed map)", () => {
      const ctx = {
        config: {
          cache: { name: "tracker-cache", binding: "CACHE", default: true },
          sessions: { name: "tracker-sessions", binding: "SESSIONS" }
        },
        state: {} as Record<string, never>,
        emit: vi.fn() as Context["emit"],
        require: (_plugin: typeof bindingsPlugin) => ({
          require: <T>(_env: WorkerEnv, _name: string): T => makeKvFake() as unknown as T,
          has: (_env: WorkerEnv, _name: string) => true
        }),
        has: vi.fn(() => true)
      } as unknown as Context;

      expect(createKvApi(ctx).deployManifest()).toEqual([
        { kind: "kv", name: "tracker-cache", binding: "CACHE" },
        { kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }
      ]);
    });

    it("kind is always the literal 'kv' (not a generic string)", () => {
      const api = makeApi(makeKvFake(), "CACHE");
      const [entry] = api.deployManifest();

      expect(entry?.kind).toBe("kv");
    });
  });

  // ─── per-call env resolution (no env caching between calls) ───────────────

  describe("per-call env resolution", () => {
    it("resolves namespace from each call's env — second call uses second env's KV", async () => {
      const kv1 = makeKvFake({ key: "from-kv1" });
      const kv2 = makeKvFake({ key: "from-kv2" });

      // Build a ctx whose require routes based on the env passed at call time
      const ctx = {
        config: { cache: { name: "tracker-cache", binding: "KV" } },
        state: {} as Record<string, never>,
        emit: vi.fn() as Context["emit"],
        require: (_plugin: typeof bindingsPlugin) => ({
          require: <T>(env: WorkerEnv, _name: string): T => {
            // Route to kv1 if env has __kv1 marker, else kv2
            return (env.__kv1 === true ? kv1 : kv2) as unknown as T;
          },
          has: (_env: WorkerEnv, _name: string) => true
        }),
        has: vi.fn(() => true)
      } as unknown as Context;

      const api = createKvApi(ctx);

      const env1: WorkerEnv = { __kv1: true };
      const env2: WorkerEnv = { __kv1: false };

      const v1 = await api.get(env1, "key");
      const v2 = await api.get(env2, "key");

      expect(v1).toBe("from-kv1");
      expect(v2).toBe("from-kv2");
    });
  });

  // ─── use(key) — named instance selection ──────────────────────────────────

  describe("use(key)", () => {
    it("use('sessions') reads from the named instance's binding", async () => {
      const api = createKvApi(
        twoInstanceCtx(makeKvFake({ k: "from-cache" }), makeKvFake({ k: "from-sessions" }))
      );

      expect(await api.use("sessions").get({}, "k")).toBe("from-sessions");
    });

    it("the default surface reads from the instance flagged default: true", async () => {
      const api = createKvApi(
        twoInstanceCtx(makeKvFake({ k: "from-cache" }), makeKvFake({ k: "from-sessions" }))
      );

      expect(await api.get({}, "k")).toBe("from-cache");
    });

    it("rejects with a [moku-worker] error naming the missing key when use(key) is unconfigured", async () => {
      const api = createKvApi(twoInstanceCtx(makeKvFake(), makeKvFake()));

      await expect(api.use("nope").get({}, "k")).rejects.toThrow(
        '[moku-worker] No kv instance "nope"'
      );
    });
  });

  // ─── type-level assertions ─────────────────────────────────────────────────

  describe("types: KvApi surface", () => {
    it("get returns Promise<string | null>", () => {
      const api = makeApi(makeKvFake());
      const env: WorkerEnv = {};

      expectTypeOf(api.get(env, "k")).toEqualTypeOf<Promise<string | null>>();
    });

    it("put returns Promise<void>", () => {
      const api = makeApi(makeKvFake());
      const env: WorkerEnv = {};

      expectTypeOf(api.put(env, "k", "v")).toEqualTypeOf<Promise<void>>();
    });

    it("delete returns Promise<void>", () => {
      const api = makeApi(makeKvFake());
      const env: WorkerEnv = {};

      expectTypeOf(api.delete(env, "k")).toEqualTypeOf<Promise<void>>();
    });

    it("deployManifest returns Array<{ kind: 'kv'; name: string; binding: string }>", () => {
      const api = makeApi(makeKvFake());

      expectTypeOf(api.deployManifest()).toEqualTypeOf<
        Array<{ kind: "kv"; name: string; binding: string }>
      >();
    });

    it("KvApi exposes get, put, delete, list, use, deployManifest", () => {
      expectTypeOf<KvApi>().toHaveProperty("get");
      expectTypeOf<KvApi>().toHaveProperty("put");
      expectTypeOf<KvApi>().toHaveProperty("delete");
      expectTypeOf<KvApi>().toHaveProperty("list");
      expectTypeOf<KvApi>().toHaveProperty("use");
      expectTypeOf<KvApi>().toHaveProperty("deployManifest");
    });

    it("kvPlugin.name is the literal type 'kv'", () => {
      expectTypeOf(kvPlugin.name).toEqualTypeOf<"kv">();
    });

    it("@ts-expect-error: get without env (env is mandatory first arg)", () => {
      const api = makeApi(makeKvFake());

      // @ts-expect-error -- env is required; calling with only key is a type error
      const badCall = api.get("key-only");

      expect(badCall).toBeDefined();
    });
  });
});
