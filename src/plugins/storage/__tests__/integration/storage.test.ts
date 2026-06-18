import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkerConfig, WorkerEvents } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { storagePlugin } from "../../index";
import type { StorageApi } from "../../types";
import { createMemoryProvider } from "../helpers/memory-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Integration test: storage plugin with createApp (full kernel wiring)
// ─────────────────────────────────────────────────────────────────────────────

// Test-local coreConfig — isolates from sibling plugins that may still be stubs.
const testCoreConfig = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
  config: {
    stage: "test",
    name: "storage-test",
    compatibilityDate: ""
  }
});

/**
 * Build a stub env that carries a memory-backed ASSETS binding. The bindings
 * plugin resolves env["ASSETS"] by name — here we inject the memory provider
 * as the bucket value so the R2 provider delegates to it.
 *
 * resolveR2Provider calls bindings.require<R2Bucket>(env, "ASSETS") and then
 * calls bucket.get/put/delete/list. The memory provider satisfies this
 * interface so it works as an in-process test double.
 */
const makeStubEnv = () => {
  const mem = createMemoryProvider();
  return {
    env: { ASSETS: mem } as Record<string, unknown>,
    mem
  };
};

// createApp is synchronous — no start/stop needed (Workers are request-scoped).
const createTestApp = (uploadDir = "./public") => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin, storagePlugin]
  });
  return createApp({
    pluginConfigs: {
      storage: { upload: uploadDir, bucket: "ASSETS" }
    }
  });
};

describe("storage plugin (integration)", () => {
  // ───────── wiring ──────────────────────────────────────────────────────────

  describe("wiring", () => {
    it("mounts app.storage after createApp", () => {
      const app = createTestApp();

      expect(app.storage).toBeDefined();
    });

    it("mounts app.bindings (bindingsPlugin wired as dependency)", () => {
      const app = createTestApp();

      expect(app.bindings).toBeDefined();
    });

    it("throws when bindingsPlugin is absent from the plugins array", () => {
      const { createApp } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [storagePlugin] // missing bindingsPlugin — depends: [bindingsPlugin] unsatisfied
      });

      expect(() => createApp()).toThrow();
    });
  });

  // ───────── runtime API ─────────────────────────────────────────────────────

  describe("runtime API", () => {
    it("put then get round-trips through the stub env binding", async () => {
      const app = createTestApp();
      const { env } = makeStubEnv();

      await app.storage.put(env, "test.txt", "hello");
      const body = await app.storage.get(env, "test.txt");

      expect(body).not.toBeNull();
    });

    it("get returns null for a key that was never put", async () => {
      const app = createTestApp();
      const { env } = makeStubEnv();

      const result = await app.storage.get(env, "phantom");

      expect(result).toBeNull();
    });

    it("delete then get returns null", async () => {
      const app = createTestApp();
      const { env } = makeStubEnv();

      await app.storage.put(env, "bye.txt", "data");
      await app.storage.delete(env, "bye.txt");

      expect(await app.storage.get(env, "bye.txt")).toBeNull();
    });

    it("list returns all stored objects", async () => {
      const app = createTestApp();
      const { env } = makeStubEnv();

      await app.storage.put(env, "a.png", "v");
      await app.storage.put(env, "b.png", "v");

      const result = await app.storage.list(env);

      expect(result.objects.length).toBeGreaterThanOrEqual(2);
    });

    it("each call uses the env supplied — no cross-env caching", async () => {
      const app = createTestApp();
      const { env: env1 } = makeStubEnv();
      const { env: env2 } = makeStubEnv();

      await app.storage.put(env1, "shared-key", "from-env1");

      // env2 has its own isolated mem provider — key absent
      const result = await app.storage.get(env2, "shared-key");
      expect(result).toBeNull();
    });
  });

  // ───────── missing binding ─────────────────────────────────────────────────

  describe("missing binding", () => {
    it("throws the [moku-worker] error when the binding is absent from env", async () => {
      const app = createTestApp();
      const emptyEnv: Record<string, unknown> = {}; // no ASSETS key

      await expect(app.storage.get(emptyEnv, "k")).rejects.toThrow("[moku-worker]");
    });
  });

  // ───────── deployManifest ──────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns { kind:'r2', bucket, upload } reflecting pluginConfigs", () => {
      const app = createTestApp("./public");

      const manifest = app.storage.deployManifest();

      expect(manifest).toEqual({ kind: "r2", bucket: "ASSETS", upload: "./public" });
    });

    it("does not require env (build-time only — no env argument)", () => {
      const app = createTestApp();

      expect(() => app.storage.deployManifest()).not.toThrow();
    });
  });

  // ───────── types ───────────────────────────────────────────────────────────

  describe("types", () => {
    it("app.storage exposes StorageApi surface", () => {
      const app = createTestApp();

      expectTypeOf(app.storage).toMatchTypeOf<StorageApi>();
    });

    it("app.storage.get is env-first: (env, key) => Promise<R2ObjectBody | null>", () => {
      const app = createTestApp();

      expectTypeOf(app.storage.get).toMatchTypeOf<
        (env: Record<string, unknown>, key: string) => Promise<R2ObjectBody | null>
      >();
    });

    it("app.storage.deployManifest returns { kind:'r2'; bucket:string; upload:string }", () => {
      const app = createTestApp();

      expectTypeOf(app.storage.deployManifest).toMatchTypeOf<
        () => { kind: "r2"; bucket: string; upload: string }
      >();
    });

    it("storagePlugin.name is the literal type 'storage'", () => {
      expectTypeOf(storagePlugin.name).toEqualTypeOf<"storage">();
    });
  });
});
