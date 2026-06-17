import { describe, expect, it, vi } from "vitest";

import { resolveR2Provider } from "../../providers/r2";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test: resolveR2Provider (delegates to a stub R2Bucket via fake bindings)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal structural fake for R2Bucket — records calls, returns shaped responses. */
const makeStubBucket = () => ({
  get: vi.fn((_key: string) =>
    Promise.resolve({
      key: _key,
      body: new ReadableStream(),
      bodyUsed: false,
      arrayBuffer: vi.fn(),
      blob: vi.fn(),
      json: vi.fn(),
      text: vi.fn()
    })
  ),
  put: vi.fn((_key: string) =>
    Promise.resolve({
      key: _key,
      version: "v1",
      size: 0,
      etag: "abc",
      httpEtag: '"abc"',
      checksums: {},
      uploaded: new Date(),
      httpMetadata: {},
      customMetadata: {},
      writeHttpMetadata: vi.fn()
    })
  ),
  delete: vi.fn(() => Promise.resolve()),
  list: vi.fn(() =>
    Promise.resolve({
      objects: [],
      truncated: false,
      cursor: undefined,
      delimitedPrefixes: []
    })
  )
});

type FakeBucket = ReturnType<typeof makeStubBucket>;

/** Structural type matching the BindingsResolver shape used by r2.ts provider. */
type BindingsResolver = {
  require<T>(env: Record<string, unknown>, name: string): T;
};

/** Fake bindings API whose require<T>() returns the given stub bucket. */
const makeBindings = (bucket: FakeBucket) =>
  // vi.fn with a generic call signature produces Mock<(<T>...)> whose inferred
  // return type does not satisfy require<T>():T structurally. Cast the whole
  // object — the mock returns the bucket which is the correct test double.
  ({
    require: vi.fn((_env: Record<string, unknown>, _name: string) => bucket),
    has: vi.fn(() => true)
  }) as unknown as BindingsResolver;

const fakeEnv: Record<string, unknown> = { ASSETS: {} };

describe("resolveR2Provider", () => {
  // ───────── get ─────────────────────────────────────────────────────────────

  describe("get", () => {
    it("delegates get(key) to the resolved R2Bucket", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      await provider.get("my-key");

      expect(bucket.get).toHaveBeenCalledWith("my-key");
    });

    it("resolves the bucket via bindings.require with env and bucket name", async () => {
      const bucket = makeStubBucket();
      const bindings = makeBindings(bucket);
      const provider = resolveR2Provider(bindings, fakeEnv, "ASSETS");

      await provider.get("k");

      expect(bindings.require).toHaveBeenCalledWith(fakeEnv, "ASSETS");
    });
  });

  // ───────── put ─────────────────────────────────────────────────────────────

  describe("put", () => {
    it("delegates put(key, value) to the resolved R2Bucket", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      await provider.put("image.png", "data");

      expect(bucket.put).toHaveBeenCalledWith("image.png", "data");
    });

    it("returns the R2Object from the bucket", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      const result = await provider.put("x", "y");

      expect(result.key).toBe("x");
    });
  });

  // ───────── delete ──────────────────────────────────────────────────────────

  describe("delete", () => {
    it("delegates delete(key) to the resolved R2Bucket", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      await provider.delete("gone");

      expect(bucket.delete).toHaveBeenCalledWith("gone");
    });

    it("delegates delete(string[]) to the resolved R2Bucket", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      await provider.delete(["a", "b"]);

      expect(bucket.delete).toHaveBeenCalledWith(["a", "b"]);
    });
  });

  // ───────── list ────────────────────────────────────────────────────────────

  describe("list", () => {
    it("delegates list() to the resolved R2Bucket with no opts", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");

      await provider.list();

      expect(bucket.list).toHaveBeenCalledWith(undefined);
    });

    it("delegates list(opts) to the resolved R2Bucket with opts", async () => {
      const bucket = makeStubBucket();
      const provider = resolveR2Provider(makeBindings(bucket), fakeEnv, "ASSETS");
      const opts: R2ListOptions = { prefix: "img/" };

      await provider.list(opts);

      expect(bucket.list).toHaveBeenCalledWith(opts);
    });
  });

  // ───────── missing binding ─────────────────────────────────────────────────

  describe("missing binding", () => {
    it("throws the [moku-worker] error when the binding is absent", async () => {
      const bindings = {
        require: vi.fn((_env: Record<string, unknown>, name: string) => {
          throw new Error(
            `[moku-worker] binding "${name}" is not bound.\n  Declare it in wrangler config and pass it in via the request env.`
          );
        }),
        has: vi.fn(() => false)
      } as unknown as BindingsResolver;
      const provider = resolveR2Provider(bindings, {}, "MISSING");

      await expect(provider.get("k")).rejects.toThrow("[moku-worker]");
    });
  });
});
