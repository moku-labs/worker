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
const testCoreConfig = createCoreConfig<WorkerConfig, WorkerEvents>("worker", {
  config: {
    stage: "test",
    name: "storage-test",
    compatibilityDate: ""
  }
});

/**
 * Build a stub env that carries a memory-backed FILES binding. The bindings
 * plugin resolves env["FILES"] by name — here we inject the memory provider
 * as the bucket value so the R2 provider delegates to it.
 *
 * resolveR2Provider calls bindings.require<R2Bucket>(env, "FILES") and then
 * calls bucket.get/put/delete/list. The memory provider satisfies this
 * interface so it works as an in-process test double.
 *
 * @returns The stub env plus the underlying memory provider.
 */
const makeStubEnv = () => {
  const mem = createMemoryProvider();
  return {
    env: { FILES: mem } as Record<string, unknown>,
    mem
  };
};

/**
 * Create a test app with a single `files` R2 instance. `binding` (env var) and
 * `name` (CF bucket name) are distinct, mirroring the keyed-map config shape.
 *
 * @param upload - Optional deploy-time upload directory for the `files` instance.
 * @returns The created app instance.
 */
const createTestApp = (upload?: string) => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin, storagePlugin]
  });
  const files =
    upload === undefined
      ? { name: "tracker-files", binding: "FILES" }
      : { name: "tracker-files", binding: "FILES", upload };
  return createApp({
    pluginConfigs: {
      storage: { files }
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

  // ───────── use(key) — named instance selection ──────────────────────────────

  describe("use", () => {
    it("round-trips through a named (non-default) instance", async () => {
      const { createApp } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [bindingsPlugin, storagePlugin]
      });
      const app = createApp({
        pluginConfigs: {
          storage: {
            files: { name: "tracker-files", binding: "FILES", default: true },
            uploads: { name: "tracker-uploads", binding: "UPLOADS" }
          }
        }
      });
      const mem = createMemoryProvider();
      const env: Record<string, unknown> = { UPLOADS: mem };

      await app.storage.use("uploads").put(env, "avatar.png", "data");
      const body = await app.storage.use("uploads").get(env, "avatar.png");

      expect(body).not.toBeNull();
    });
  });

  // ───────── missing binding ─────────────────────────────────────────────────

  describe("missing binding", () => {
    it("throws the [worker] error when the binding is absent from env", async () => {
      const app = createTestApp();
      const emptyEnv: Record<string, unknown> = {}; // no FILES key

      await expect(app.storage.get(emptyEnv, "k")).rejects.toThrow("[worker]");
    });
  });

  // ───────── deployManifest ──────────────────────────────────────────────────

  describe("deployManifest", () => {
    it("returns one r2 descriptor per configured instance, reflecting pluginConfigs", () => {
      const app = createTestApp("./public");

      const manifest = app.storage.deployManifest();

      expect(manifest).toEqual([
        { kind: "r2", name: "tracker-files", binding: "FILES", upload: "./public" }
      ]);
    });

    it("omits `upload` when the instance does not declare it", () => {
      const app = createTestApp();

      const manifest = app.storage.deployManifest();

      expect(manifest).toEqual([{ kind: "r2", name: "tracker-files", binding: "FILES" }]);
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

      expectTypeOf(app.storage).toExtend<StorageApi>();
    });

    it("app.storage.get is env-first: (env, key) => Promise<R2ObjectBody | null>", () => {
      const app = createTestApp();

      expectTypeOf(app.storage.get).toExtend<
        (env: Record<string, unknown>, key: string) => Promise<R2ObjectBody | null>
      >();
    });

    it("app.storage.deployManifest returns an array of r2 descriptors", () => {
      const app = createTestApp();

      expectTypeOf(app.storage.deployManifest).toExtend<
        () => Array<{ kind: "r2"; name: string; binding: string; upload?: string }>
      >();
    });

    it("storagePlugin.name is the literal type 'storage'", () => {
      expectTypeOf(storagePlugin.name).toEqualTypeOf<"storage">();
    });
  });
});
