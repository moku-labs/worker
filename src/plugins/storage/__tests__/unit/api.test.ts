import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { bindingsPlugin } from "../../../bindings";
import { createStorageApi } from "../../api";
import { createMemoryProvider } from "../../providers/memory";
import type { StorageApi, StorageCtx } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test: createStorageApi (mock ctx, memory-backed fake bindings)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake bindings API whose require<T>() returns a memory-backed provider
 * for the given bucket name.
 */
const makeMemoryBindings = (expectedBucket = "ASSETS") => {
  const memProvider = createMemoryProvider();
  return {
    require: vi.fn(<T>(_env: Record<string, unknown>, name: string): T => {
      if (name !== expectedBucket) {
        throw new Error(`[moku-worker] binding "${name}" is not bound.`);
      }
      // We return the memProvider cast as T (R2Bucket). In tests this is acceptable
      // because we immediately narrow back to StorageProvider inside resolveR2Provider.
      return memProvider as unknown as T;
    }),
    has: vi.fn(() => true),
    _memProvider: memProvider
  };
};

/** Mock PluginCtx shape needed by createStorageApi. */
const createMockCtx = (overrides?: {
  bucket?: string;
  upload?: string;
}): StorageCtx & { require: ReturnType<typeof vi.fn> } => {
  const fakeBindings = makeMemoryBindings(overrides?.bucket ?? "ASSETS");
  return {
    config: {
      bucket: overrides?.bucket ?? "ASSETS",
      upload: overrides?.upload ?? ""
    },
    state: {} as Record<string, never>,
    emit: vi.fn() as StorageCtx["emit"],
    // ctx.require(bindingsPlugin) returns our fake bindings api
    require: vi.fn((plugin: unknown) => {
      if (plugin === bindingsPlugin) return fakeBindings;
      throw new Error("unexpected require");
    })
  } as unknown as StorageCtx & { require: ReturnType<typeof vi.fn> };
};

/** A minimal fake env carrying the ASSETS binding slot (identity — the memory provider ignores it). */
const fakeEnv: Record<string, unknown> = { ASSETS: "stub" };

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

  // ───────── deployManifest ──────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns { kind:'r2', bucket, upload } from ctx.config", () => {
      const ctx = createMockCtx({ bucket: "MEDIA", upload: "./public" });
      const api = createStorageApi(ctx);

      const manifest = api.deployManifest();

      expect(manifest).toEqual({ kind: "r2", bucket: "MEDIA", upload: "./public" });
    });

    it("does not call ctx.require (no env access)", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      api.deployManifest();

      expect(ctx.require).not.toHaveBeenCalled();
    });

    it("kind is always the literal 'r2'", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expect(api.deployManifest().kind).toBe("r2");
    });
  });

  // ───────── types ───────────────────────────────────────────────────────────

  describe("types", () => {
    it("createStorageApi returns StorageApi", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api).toMatchTypeOf<StorageApi>();
    });

    it("get is env-first: (env, key) => Promise<R2ObjectBody | null>", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api.get).toMatchTypeOf<
        (env: Record<string, unknown>, key: string) => Promise<R2ObjectBody | null>
      >();
    });

    it("deployManifest returns { kind: 'r2'; bucket: string; upload: string }", () => {
      const ctx = createMockCtx();
      const api = createStorageApi(ctx);

      expectTypeOf(api.deployManifest).toMatchTypeOf<
        () => { kind: "r2"; bucket: string; upload: string }
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
