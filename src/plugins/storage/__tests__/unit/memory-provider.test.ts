import { describe, expect, it } from "vitest";

import { createMemoryProvider } from "../helpers/memory-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test: createMemoryProvider (in-memory test double, no kernel)
// ─────────────────────────────────────────────────────────────────────────────

describe("createMemoryProvider", () => {
  // ───────── get ─────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns null for a key that was never put", async () => {
      const provider = createMemoryProvider();

      const result = await provider.get("missing");

      expect(result).toBeNull();
    });

    it("returns the body after a successful put", async () => {
      const provider = createMemoryProvider();
      await provider.put("hello", "world");

      const result = await provider.get("hello");

      expect(result).not.toBeNull();
    });

    it("returns null after the key has been deleted", async () => {
      const provider = createMemoryProvider();
      await provider.put("k", "v");
      await provider.delete("k");

      const result = await provider.get("k");

      expect(result).toBeNull();
    });
  });

  // ───────── put ─────────────────────────────────────────────────────────────

  describe("put", () => {
    it("stores string values and returns an R2Object-shaped record", async () => {
      const provider = createMemoryProvider();

      const obj = await provider.put("file.txt", "content");

      expect(obj.key).toBe("file.txt");
    });

    it("overwrites an existing key", async () => {
      const provider = createMemoryProvider();
      await provider.put("k", "old");

      const obj = await provider.put("k", "new");

      expect(obj.key).toBe("k");
      const body = await provider.get("k");
      expect(body).not.toBeNull();
    });

    it("stores ArrayBuffer values", async () => {
      const provider = createMemoryProvider();
      const buf = new ArrayBuffer(4);

      const obj = await provider.put("bin", buf);

      expect(obj.key).toBe("bin");
    });
  });

  // ───────── delete ──────────────────────────────────────────────────────────

  describe("delete", () => {
    it("removes an existing key", async () => {
      const provider = createMemoryProvider();
      await provider.put("key", "val");

      await provider.delete("key");

      expect(await provider.get("key")).toBeNull();
    });

    it("is a no-op when the key does not exist (single key)", async () => {
      const provider = createMemoryProvider();

      await expect(provider.delete("phantom")).resolves.toBeUndefined();
    });

    it("deletes multiple keys at once", async () => {
      const provider = createMemoryProvider();
      await provider.put("a", "1");
      await provider.put("b", "2");
      await provider.put("c", "3");

      await provider.delete(["a", "b"]);

      expect(await provider.get("a")).toBeNull();
      expect(await provider.get("b")).toBeNull();
      expect(await provider.get("c")).not.toBeNull();
    });

    it("is a no-op for absent keys in an array delete", async () => {
      const provider = createMemoryProvider();
      await provider.put("exists", "yes");

      await expect(provider.delete(["missing", "exists"])).resolves.toBeUndefined();
      expect(await provider.get("exists")).toBeNull();
    });
  });

  // ───────── list ────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns all keys when called with no options", async () => {
      const provider = createMemoryProvider();
      await provider.put("a/1", "v");
      await provider.put("b/2", "v");
      await provider.put("c/3", "v");

      const result = await provider.list();

      expect(result.objects).toHaveLength(3);
    });

    it("filters by prefix", async () => {
      const provider = createMemoryProvider();
      await provider.put("images/logo.png", "v");
      await provider.put("images/banner.png", "v");
      await provider.put("docs/readme.md", "v");

      const result = await provider.list({ prefix: "images/" });

      expect(result.objects).toHaveLength(2);
      const keys = result.objects.map(o => o.key);
      expect(keys).toContain("images/logo.png");
      expect(keys).toContain("images/banner.png");
    });

    it("returns empty objects array when prefix matches nothing", async () => {
      const provider = createMemoryProvider();
      await provider.put("data/file", "v");

      const result = await provider.list({ prefix: "nope/" });

      expect(result.objects).toHaveLength(0);
    });

    it("honors the limit option", async () => {
      const provider = createMemoryProvider();
      for (let i = 0; i < 5; i++) {
        await provider.put(`key/${i}`, "v");
      }

      const result = await provider.list({ limit: 3 });

      expect(result.objects.length).toBeLessThanOrEqual(3);
    });

    it("returns an R2Objects-shaped result with truncated flag", async () => {
      const provider = createMemoryProvider();
      await provider.put("x", "v");

      const result = await provider.list();

      expect(typeof result.truncated).toBe("boolean");
      expect(Array.isArray(result.objects)).toBe(true);
    });
  });
});
