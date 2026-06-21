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
        resources: [{ kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const kvs = config.kv_namespaces as Array<{ binding: string }>;
      expect(kvs).toContainEqual(expect.objectContaining({ binding: "SESSIONS" }));
    });

    it("writes r2_buckets for r2 resources (bucket_name from resource name)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "r2", name: "tracker-assets", binding: "ASSETS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const r2s = config.r2_buckets as Array<{ binding: string; bucket_name: string }>;
      expect(r2s).toContainEqual({ binding: "ASSETS", bucket_name: "tracker-assets" });
    });

    it("writes d1_databases for d1 resources (database_name from resource name)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "d1", name: "tracker-db", binding: "DB", migrations: "./migrations" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const dbs = config.d1_databases as Array<{
        binding: string;
        database_name: string;
        migrations_dir?: string;
      }>;
      expect(dbs).toContainEqual(
        expect.objectContaining({
          binding: "DB",
          database_name: "tracker-db",
          migrations_dir: "./migrations"
        })
      );
    });

    it("writes queues producers for queue resources (queue = resource name)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "queue", name: "orders", binding: "ORDERS" },
          { kind: "queue", name: "refunds", binding: "REFUNDS" }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const queues = config.queues as { producers?: Array<{ queue: string; binding: string }> };
      expect(queues?.producers).toHaveLength(2);
      expect(queues?.producers).toContainEqual({ queue: "orders", binding: "ORDERS" });
    });

    it("registers a `consumers` entry for queues flagged consumer: true (and not for others)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "queue", name: "tracker-activity", binding: "ACTIVITY_QUEUE", consumer: true },
          { kind: "queue", name: "outbound", binding: "OUTBOUND" }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const queues = config.queues as {
        producers?: Array<{ queue: string }>;
        consumers?: Array<{ queue: string }>;
      };
      // Every queue is a producer; only the onMessage-backed one is also a consumer.
      expect(queues?.producers).toHaveLength(2);
      expect(queues?.consumers).toEqual([{ queue: "tracker-activity" }]);
    });

    it("omits `consumers` when no queue is flagged as a consumer", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "queue", name: "orders", binding: "ORDERS" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const queues = config.queues as { consumers?: unknown };
      expect(queues?.consumers).toBeUndefined();
    });

    it("writes max_batch_timeout on the consumer when maxBatchTimeout is set", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [
          {
            kind: "queue",
            name: "tracker-activity",
            binding: "ACTIVITY_QUEUE",
            consumer: true,
            maxBatchTimeout: 1
          }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const queues = config.queues as {
        consumers?: Array<{ queue: string; max_batch_timeout?: number }>;
      };
      expect(queues?.consumers).toEqual([{ queue: "tracker-activity", max_batch_timeout: 1 }]);
    });

    it("writes durable_objects for do resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "do", binding: "COUNTER", className: "Counter" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const doConfig = config.durable_objects as {
        bindings: Array<{ name: string; class_name: string }>;
      };
      expect(doConfig.bindings).toContainEqual(
        expect.objectContaining({ name: "COUNTER", class_name: "Counter" })
      );
    });

    it("auto-derives a v1 migration registering every DO class as SQLite-backed", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "do", binding: "BOARD", className: "Board" },
          { kind: "do", binding: "ROOM", className: "Room" }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      expect(readConfig().migrations).toEqual([
        { tag: "v1", new_sqlite_classes: ["Board", "Room"] }
      ]);
    });

    it("does NOT write migrations when there are no DO resources", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", name: "tracker-cache", binding: "CACHE" }]
      };

      await writeWranglerConfig(configPath(), manifest);

      expect(readConfig().migrations).toBeUndefined();
    });

    it("writes all resource types when manifest has multiple kinds", async () => {
      const manifest: ExternalManifest = {
        name: "full-worker",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "kv", name: "tracker-cache", binding: "CACHE" },
          { kind: "r2", name: "tracker-files", binding: "FILES" },
          { kind: "d1", name: "tracker-db", binding: "DB" },
          { kind: "queue", name: "tracker-jobs", binding: "JOBS" },
          { kind: "do", binding: "COUNTER", className: "Counter" }
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

  describe("wrangler passthrough (main / compatibility_flags / assets)", () => {
    const manifest: ExternalManifest = {
      name: "w",
      compatibilityDate: "2026-06-17",
      resources: [{ kind: "do", binding: "BOARD", className: "Board" }]
    };

    it("merges the passthrough keys the manifest cannot derive (main / flags / assets)", async () => {
      await writeWranglerConfig(
        configPath(),
        manifest,
        {},
        {
          main: "src/cloudflare/worker.ts",
          compatibility_flags: ["nodejs_compat"],
          assets: { directory: "dist/client", binding: "ASSETS" }
        }
      );

      const config = readConfig();
      expect(config.main).toBe("src/cloudflare/worker.ts");
      expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
      expect(config.assets).toEqual({ directory: "dist/client", binding: "ASSETS" });
      // managed keys still present alongside the passthrough
      expect(config.durable_objects).toBeDefined();
      expect(config.migrations).toBeDefined();
    });

    it("lets deploy-managed resource keys win over a conflicting passthrough", async () => {
      await writeWranglerConfig(
        configPath(),
        manifest,
        {},
        {
          name: "hijacked",
          durable_objects: { bindings: [] }
        }
      );

      const config = readConfig();
      expect(config.name).toBe("w"); // manifest name wins
      const doConfig = config.durable_objects as { bindings: unknown[] };
      expect(doConfig.bindings).toHaveLength(1); // generated DO binding wins
    });

    it("does not clobber a migrations list already supplied via the passthrough", async () => {
      const custom = [{ tag: "v1", new_classes: ["Board"] }]; // e.g. non-SQLite DO
      await writeWranglerConfig(configPath(), manifest, {}, { migrations: custom });

      expect(readConfig().migrations).toEqual(custom);
    });
  });

  describe("writes captured resource ids", () => {
    it("writes the captured kv namespace id when provided", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }]
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
        resources: [{ kind: "d1", name: "tracker-db", binding: "DB" }]
      };

      await writeWranglerConfig(configPath(), manifest, { DB: "uuid-1234" });

      const config = readConfig();
      const dbs = config.d1_databases as Array<{ binding: string; database_id: string }>;
      expect(dbs).toContainEqual(
        expect.objectContaining({ binding: "DB", database_id: "uuid-1234" })
      );
    });

    it("omits the id when none is captured so local dev validates (wrangler rejects an empty id)", async () => {
      const manifest: ExternalManifest = {
        name: "w",
        compatibilityDate: "2026-06-17",
        resources: [
          { kind: "kv", name: "tracker-sessions", binding: "SESSIONS" },
          { kind: "d1", name: "tracker-db", binding: "DB" }
        ]
      };

      await writeWranglerConfig(configPath(), manifest);

      const config = readConfig();
      const kvs = config.kv_namespaces as Array<{ binding: string; id?: string }>;
      expect(kvs[0]).toEqual({ binding: "SESSIONS" });
      expect(kvs[0]?.id).toBeUndefined();
      const d1s = config.d1_databases as Array<{ binding: string; database_id?: string }>;
      expect(d1s[0]?.database_id).toBeUndefined();
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
        resources: [{ kind: "kv", name: "tracker-cache", binding: "CACHE" }]
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
        resources: [{ kind: "kv", name: "tracker-kv", binding: "KV" }]
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
