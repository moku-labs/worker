/**
 * Unit tests for writeWranglerConfig and scaffoldWranglerAndCi.
 * Uses a real temp directory for filesystem operations.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExternalManifest } from "../../types";
import { scaffoldWranglerAndCi, writeWranglerConfig } from "../../wrangler-config";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  tmpDir = path.join(tmpdir(), `moku-deploy-test-${Date.now()}-${counter}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const configPath = () => path.join(tmpDir, "wrangler.jsonc");

const readConfig = (): Record<string, unknown> => {
  const content = readFileSync(configPath(), "utf8");
  // Strip JSONC comments before parsing
  const stripped = content.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  return JSON.parse(stripped) as Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// writeWranglerConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("writeWranglerConfig", () => {
  describe("creates config from scratch", () => {
    it("writes a file at the given path", async () => {
      const manifest: ExternalManifest = {
        name: "test-worker",
        compatibilityDate: "2026-06-17",
        resources: []
      };

      await writeWranglerConfig(configPath(), manifest);

      expect(existsSync(configPath())).toBe(true);
    });

    it("includes name and compatibility_date from manifest", async () => {
      const manifest: ExternalManifest = {
        name: "my-worker",
        compatibilityDate: "2026-06-17",
        resources: []
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      expect(config.name).toBe("my-worker");
      expect(config.compatibility_date).toBe("2026-06-17");
    });

    it("writes kv_namespaces for kv resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", binding: "SESSIONS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const kvs = config.kv_namespaces as Array<{ binding: string }>;
      expect(kvs).toContainEqual(expect.objectContaining({ binding: "SESSIONS" }));
    });

    it("writes r2_buckets for r2 resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "r2", bucket: "ASSETS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const r2s = config.r2_buckets as Array<{ binding: string; bucket_name: string }>;
      expect(r2s).toContainEqual(expect.objectContaining({ binding: "ASSETS" }));
    });

    it("writes d1_databases for d1 resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "d1", binding: "DB", migrations: "./migrations" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const dbs = config.d1_databases as Array<{ binding: string }>;
      expect(dbs).toContainEqual(expect.objectContaining({ binding: "DB" }));
    });

    it("writes queues for queue resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "queue", producers: ["orders", "refunds"] }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const queues = config.queues as { producers?: Array<{ queue: string; binding: string }> };
      expect(queues?.producers).toHaveLength(2);
    });

    it("writes durable_objects for do resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "do", bindings: { counter: "COUNTER" } }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const doConfig = config.durable_objects as {
        bindings: Array<{ name: string; class_name: string }>;
      };
      expect(doConfig.bindings).toContainEqual(
        expect.objectContaining({ name: "COUNTER", class_name: "counter" })
      );
    });

    it("writes all resource types when manifest has multiple kinds", async () => {
      const manifest: ExternalManifest = {
        name: "full-worker",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "kv", binding: "CACHE" },
          { kind: "r2", bucket: "FILES" },
          { kind: "d1", binding: "DB" },
          { kind: "queue", producers: ["jobs"] },
          { kind: "do", bindings: { counter: "COUNTER" } }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      expect(config.kv_namespaces).toBeDefined();
      expect(config.r2_buckets).toBeDefined();
      expect(config.d1_databases).toBeDefined();
      expect(config.queues).toBeDefined();
      expect(config.durable_objects).toBeDefined();
    });
  });

  describe("writes captured resource ids", () => {
    it("writes the captured kv namespace id when provided", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", binding: "SESSIONS" }]
      };

      await writeWranglerConfig(configPath(), manifest, { SESSIONS: "ns-abc123" });

      const config = readConfig();
      const kvs = config.kv_namespaces as Array<{ binding: string; id: string }>;
      expect(kvs).toContainEqual({ binding: "SESSIONS", id: "ns-abc123" });
    });

    it("writes the captured d1 database_id when provided", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "d1", binding: "DB" }]
      };

      await writeWranglerConfig(configPath(), manifest, { DB: "uuid-1234" });

      const config = readConfig();
      const dbs = config.d1_databases as Array<{ binding: string; database_id: string }>;
      expect(dbs).toContainEqual(
        expect.objectContaining({ binding: "DB", database_id: "uuid-1234" })
      );
    });

    it("writes an empty id when none is captured (e.g. the universal path)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", binding: "SESSIONS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const kvs = config.kv_namespaces as Array<{ binding: string; id: string }>;
      expect(kvs[0]?.id).toBe("");
    });
  });

  describe("merges non-destructively with existing config", () => {
    it("preserves existing top-level keys not managed by this plugin", async () => {
      // Write a pre-existing config with custom fields
      const existing = {
        name: "old-worker",
        compatibility_date: "2025-01-01",
        main: "src/worker.ts",
        custom_field: "keep-me"
      };
      await writeFile(configPath(), JSON.stringify(existing, undefined, 2));

      const manifest: ExternalManifest = {
        name: "new-worker",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", binding: "CACHE" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      expect(config.custom_field).toBe("keep-me");
      expect(config.main).toBe("src/worker.ts");
    });

    it("updates name and compatibility_date from manifest", async () => {
      const existing = { name: "old", compatibility_date: "2025-01-01" };
      await writeFile(configPath(), JSON.stringify(existing));

      const manifest: ExternalManifest = {
        name: "new",
        compatibilityDate: "2026-06-17",
        resources: []
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      expect(config.name).toBe("new");
      expect(config.compatibility_date).toBe("2026-06-17");
    });
  });

  describe("produces valid output", () => {
    it("output is valid JSON (stripping JSONC comments)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", binding: "KV" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      expect(() => readConfig()).not.toThrow();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scaffoldWranglerAndCi
// ─────────────────────────────────────────────────────────────────────────────

describe("scaffoldWranglerAndCi", () => {
  it("creates the config file when it does not exist", async () => {
    await scaffoldWranglerAndCi(configPath(), false);

    expect(existsSync(configPath())).toBe(true);
  });

  it("leaves the config file untouched when it already exists", async () => {
    const original = JSON.stringify({ name: "original", compatibility_date: "2025-01-01" });
    await writeFile(configPath(), original);

    await scaffoldWranglerAndCi(configPath(), false);

    const content = readFileSync(configPath(), "utf8");
    expect(content).toBe(original);
  });

  it("resolves without throwing when ci=false", async () => {
    await expect(scaffoldWranglerAndCi(configPath(), false)).resolves.toBeUndefined();
  });

  it("resolves without throwing when ci=true", async () => {
    await expect(scaffoldWranglerAndCi(configPath(), true)).resolves.toBeUndefined();
  });
});
