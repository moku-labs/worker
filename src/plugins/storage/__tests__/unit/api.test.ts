import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { bindingsPlugin } from "../../../bindings";
import { createStorageApi } from "../../api";
import type { StorageApi, StorageConfig, StorageCtx } from "../../types";
import { createMemoryProvider } from "../helpers/memory-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test: createStorageApi (mock ctx, memory-backed fake bindings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mock PluginCtx shape needed by createStorageApi. Defaults to a single `files`
 * instance whose `binding` (env var) and `name` (CF bucket) are distinct.
 *
 * @param config - Optional keyed-map storage config override.
 * @returns A mock StorageCtx whose require(bindingsPlugin) wraps a memory provider.
 */
const createMockCtx = (
  config?: StorageConfig
): StorageCtx & {
  require: ReturnType<typeof vi.fn>;
  _bindingsRequire: ReturnType<typeof vi.fn>;
} => {
  const resolved: StorageConfig = config ?? {
    files: { name: "tracker-files", binding: "FILES" }
  };
  // The binding name to honour is the (single / default) instance's binding.
  const bindingNames = new Set(Object.values(resolved).map(instance => instance.binding));
  const memProvider = createMemoryProvider();
  const bindingsRequire = vi.fn(<T>(_env: Record<string, unknown>, name: string): T => {
    if (!bindingNames.has(name)) {
      throw new Error(`[worker] binding "${name}" is not bound.`);
    }
    return memProvider as unknown as T;
  });
  const fakeBindings = {
    require: bindingsRequire,
    has: vi.fn(() => true),
    _memProvider: memProvider
  };
  return {
    // Standard-tier ctx also carries global framework config + `has` (spec/08 §2);
    // both inert here — createStorageApi only reads config and require(bindingsPlugin).
    global: {},
    config: resolved,
    state: {} as Record<string, never>,
    emit: vi.fn() as StorageCtx["emit"],
    has: () => false,
    // ctx.require(bindingsPlugin) returns our fake bindings api
    require: vi.fn((plugin: unknown) => {
      if (plugin === bindingsPlugin) return fakeBindings;
      throw new Error("unexpected require");
    }),
    // Exposed for assertions: the inner env-resolver (bindings.require(env, name)).
    _bindingsRequire: bindingsRequire
  } as unknown as StorageCtx & {
    require: ReturnType<typeof vi.fn>;
    _bindingsRequire: ReturnType<typeof vi.fn>;
  };
};

/** A minimal fake env carrying the FILES binding slot (identity — the memory provider ignores it). */
const fakeEnv: Record<string, unknown> = { FILES: "stub" };

describe("createStorageApi", () => {
  // ───────── get ─────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns null for a key that has never been put", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      const result = await api.get(fakeEnv, "no-such-key");

      expect(result).toBeNull();
    });

    it("returns the stored body after a put", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      await api.put(fakeEnv, "hello", "world");
      const result = await api.get(fakeEnv, "hello");

      expect(result).not.toBeNull();
    });

    it("threads env to the provider on every call (env-first wiring)", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      await api.get(fakeEnv, "k");

      // ctx.require(bindingsPlugin) must have been called to resolve the bindings api
      expect(ctx.require).toHaveBeenCalledWith(bindingsPlugin);
    });
  });

  // ───────── put ─────────────────────────────────────────────────────────────

  describe("put", () => {
    it("stores a string value and returns an R2Object with the correct key", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      const obj = await api.put(fakeEnv, "file.txt", "content");

      expect(obj.key).toBe("file.txt");
    });

    it("round-trip: put → get returns the stored body", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      await api.put(fakeEnv, "round-trip", "payload");
      const body = await api.get(fakeEnv, "round-trip");

      expect(body).not.toBeNull();
    });
  });

  // ───────── delete ──────────────────────────────────────────────────────────

  describe("delete", () => {
    it("delete of an absent key is a no-op (does not throw)", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      await expect(api.delete(fakeEnv, "phantom")).resolves.toBeUndefined();
    });

    it("removes an existing key so get returns null", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);
      await api.put(fakeEnv, "bye", "data");

      await api.delete(fakeEnv, "bye");

      expect(await api.get(fakeEnv, "bye")).toBeNull();
    });
  });

  // ───────── list ────────────────────────────────────────────────────────────

  describe("list", () => {
    it("honors prefix filter — only matching keys are returned", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);
      await api.put(fakeEnv, "images/a.png", "v");
      await api.put(fakeEnv, "images/b.png", "v");
      await api.put(fakeEnv, "docs/readme.md", "v");

      const result = await api.list(fakeEnv, { prefix: "images/" });

      expect(result.objects).toHaveLength(2);
    });

    it("returns all objects when called with no opts", async () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);
      await api.put(fakeEnv, "x", "v");
      await api.put(fakeEnv, "y", "v");

      const result = await api.list(fakeEnv);

      expect(result.objects.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ───────── use(key) — named instance selection ──────────────────────────────

  describe("use", () => {
    it("resolves a named instance's binding and round-trips through it", async () => {
      const ctx = createMockCtx({
        files: { name: "tracker-files", binding: "FILES", default: true },
        uploads: { name: "tracker-uploads", binding: "UPLOADS" }
      });
      const api = createStorageApi(ctx);
      const env: Record<string, unknown> = { UPLOADS: "stub" };

      await api.use("uploads").put(env, "avatar.png", "data");
      const body = await api.use("uploads").get(env, "avatar.png");

      expect(body).not.toBeNull();
    });

    it("throws a [worker] error for an unknown instance key", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);
      const env: Record<string, unknown> = { FILES: "stub" };

      expect(() => api.use("nope").get(env, "k")).toThrow("[worker]");
    });
  });

  // ───────── deployManifest ──────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one r2 descriptor per configured instance", () => {
      const ctx = createMockCtx({
        files: { name: "tracker-files", binding: "FILES" }
      });
      const api = createStorageApi(ctx);

      const manifest = api.deployManifest();

      expect(manifest).toEqual([{ kind: "r2", name: "tracker-files", binding: "FILES" }]);
    });

    it("includes `upload` only when defined on the instance", () => {
      const ctx = createMockCtx({
        files: { name: "tracker-files", binding: "FILES" },
        media: { name: "tracker-media", binding: "MEDIA", upload: "./public" }
      });
      const api = createStorageApi(ctx);

      const manifest = api.deployManifest();

      expect(manifest).toEqual([
        { kind: "r2", name: "tracker-files", binding: "FILES" },
        { kind: "r2", name: "tracker-media", binding: "MEDIA", upload: "./public" }
      ]);
    });

    it("does not resolve any binding off env (build-time only — no env access)", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      api.deployManifest();

      expect(ctx._bindingsRequire).not.toHaveBeenCalled();
    });

    it("every entry's kind is the literal 'r2'", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      for (const entry of api.deployManifest()) {
        expect(entry.kind).toBe("r2");
      }
    });
  });

  // ───────── types ───────────────────────────────────────────────────────────

  describe("types", () => {
    it("createStorageApi returns StorageApi", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api).toExtend<StorageApi>();
    });

    it("get is env-first: (env, key) => Promise<R2ObjectBody | null>", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api.get).toEqualTypeOf<
        (env: Record<string, unknown>, key: string) => Promise<R2ObjectBody | null>
      >();
    });

    it("deployManifest returns an array of { kind:'r2'; name; binding; upload? }", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api.deployManifest).toEqualTypeOf<
        () => Array<{ kind: "r2"; name: string; binding: string; upload?: string }>
      >();
    });

    it("get(key) without env is a type error", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      // @ts-expect-error -- get requires env as first argument
      const _unused1 = api.get("key-without-env");

      expect(_unused1).toBeDefined();
    });

    it("ctx.emit does not accept storage:... events (no storage events declared)", () => {
      const ctx = createMockCtx();

      // @ts-expect-error -- no storage events exist in WorkerEvents
      const _unused2 = ctx.emit("storage:changed", {});

      expect(_unused2).toBeUndefined();
    });
  });
});
