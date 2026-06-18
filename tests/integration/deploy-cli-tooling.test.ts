/**
 * @file ROOT integration tests for `@moku-labs/worker` — the NODE-ONLY deploy +
 * cli build tooling exercised end-to-end through the shipped framework (build Step 5.8).
 *
 * deploy and cli are build-time tooling that shell out to `wrangler` (node:child_process)
 * and the filesystem (node:fs). Under vitest neither subprocess nor fs may run, so the four
 * node-only seams are `vi.mock`ed at module scope (hoisted): the wrangler runner, the
 * wrangler-config writer/scaffolder, the provider dispatch, and the R2 upload/provision.
 * Every assertion is made against those mocks (call args/counts) or against the GLOBAL deploy
 * events (deploy:phase / provision:resource / deploy:complete) captured by an inline recorder
 * plugin — so NO real wrangler invocation or fs access occurs.
 *
 * App construction uses the REAL exported framework: `createApp` (which pre-wires the
 * defaults — core log/env/stage + bindings + server) plus the node-only `./cli` entry
 * (deployPlugin + cliPlugin). The five resource plugins are registered before deploy
 * (deploy depends on all five), and cli is registered after deploy (cli depends on deploy).
 */
import { describe, expect, it, vi } from "vitest";

import type { WorkerEvents } from "../../src/config";

// ─────────────────────────────────────────────────────────────────────────────
// Module stubs — hoisted by vitest so the deploy api sees the mocked node seams.
// Paths are re-rooted from tests/integration/ → ../../src/plugins/deploy/* .
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/plugins/deploy/runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("https://deploy-test.workers.dev")
}));

vi.mock("../../src/plugins/deploy/wrangler-config", () => ({
  writeWranglerConfig: vi.fn().mockResolvedValue(undefined),
  scaffoldWranglerAndCi: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../src/plugins/deploy/providers", () => ({
  provisionResource: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../src/plugins/deploy/providers/r2", () => ({
  uploadDirToR2: vi.fn().mockResolvedValue(2),
  provisionR2: vi.fn().mockResolvedValue(undefined)
}));

// Imported AFTER the vi.mock calls above (which are hoisted) so these resolve to the mocks.
import { beforeEach } from "vitest";
import { cliPlugin, deployPlugin } from "../../src/cli";
import {
  createApp,
  createPlugin,
  d1Plugin,
  durableObjectsPlugin,
  kvPlugin,
  queuesPlugin,
  storagePlugin
} from "../../src/index";
import { provisionResource } from "../../src/plugins/deploy/providers";
import { runWrangler } from "../../src/plugins/deploy/runner";
import { writeWranglerConfig } from "../../src/plugins/deploy/wrangler-config";

// Clear mocks between tests so call counts/args don't bleed across assertions.
beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape of a written wrangler manifest (the second arg to writeWranglerConfig).
// Mirrors ExternalManifest's observable surface without importing the type.
// ─────────────────────────────────────────────────────────────────────────────

type WrittenManifest = {
  name: string;
  compatibilityDate: string;
  resources: Array<{ kind: string; [key: string]: unknown }>;
};

/** Typed view over the mocked writeWranglerConfig so call args read cleanly. */
const writeWranglerConfigMock = writeWranglerConfig as unknown as ReturnType<typeof vi.fn>;

/**
 * Read the (configFile, manifest) pair passed to the first writeWranglerConfig call.
 *
 * @returns The configFile string and the written manifest object.
 */
const firstWranglerConfigCall = (): { configFile: string; manifest: WrittenManifest } => {
  const [configFile, manifest] = writeWranglerConfigMock.mock.calls[0] as [string, WrittenManifest];
  return { configFile, manifest };
};

// ─────────────────────────────────────────────────────────────────────────────
// Inline recorder plugin — captures the GLOBAL deploy events deploy emits.
// Global events need NO `depends`; hooks fire-and-forget into a shared array.
// ─────────────────────────────────────────────────────────────────────────────

type Recorded =
  | { event: "deploy:phase"; payload: WorkerEvents["deploy:phase"] }
  | { event: "provision:resource"; payload: WorkerEvents["provision:resource"] }
  | { event: "deploy:complete"; payload: WorkerEvents["deploy:complete"] };

const recorded: Recorded[] = [];

/**
 * Recorder plugin: subscribes to the three global deploy events and pushes each
 * payload into the module-level `recorded` array (reset in beforeEach).
 */
const recorderPlugin = createPlugin("deployRecorder", {
  config: {},

  hooks: () => ({
    "deploy:phase"(payload: WorkerEvents["deploy:phase"]): void {
      recorded.push({ event: "deploy:phase", payload });
    },
    "provision:resource"(payload: WorkerEvents["provision:resource"]): void {
      recorded.push({ event: "provision:resource", payload });
    },
    "deploy:complete"(payload: WorkerEvents["deploy:complete"]): void {
      recorded.push({ event: "deploy:complete", payload });
    }
  })
});

// Reset the recorder buffer alongside the mocks.
beforeEach(() => {
  recorded.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// App harness — REAL exported createApp (defaults pre-wired) + node-only ./cli.
// Resource plugins precede deploy (its five deps); cli follows deploy (its dep).
// The log plugin's in-memory trace sink is always installed, so app.log.trace()
// captures the cli hook lines without configuring the (core) log plugin here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the deploy/cli app: five resource plugins → deploy → cli, plus the inline
 * recorder. bindings/server/log/env/stage are pre-wired by the exported createApp,
 * so they are intentionally NOT listed here.
 *
 * @returns The composed app exposing app.deploy and app.cli.
 */
const createToolingApp = () =>
  createApp({
    plugins: [
      storagePlugin,
      kvPlugin,
      d1Plugin,
      queuesPlugin,
      durableObjectsPlugin,
      deployPlugin,
      cliPlugin,
      recorderPlugin
    ],
    config: { stage: "test", name: "deploy-test", compatibilityDate: "2026-01-01" },
    pluginConfigs: {
      storage: { bucket: "ASSETS", upload: "./public" },
      kv: { binding: "KV" },
      d1: { binding: "DB", migrations: "./migrations" },
      queues: { producers: ["JOBS"], onMessage: async () => undefined },
      durableObjects: { bindings: { counter: "COUNTER" } },
      cli: { port: 8787 },
      deploy: { configFile: "wrangler.jsonc", ci: false }
    }
  });

/** Flush the framework's async event dispatch so recorder hooks have run. */
const flushEvents = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("deploy + cli tooling (root integration)", () => {
  // ─── 1. Manifest aggregation → wrangler config written ─────────────────────

  describe("app.deploy.run() aggregates all five resource manifests", () => {
    it("writes a wrangler config whose manifest reflects all five resource kinds", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });

      expect(writeWranglerConfigMock).toHaveBeenCalledTimes(1);

      const { configFile, manifest } = firstWranglerConfigCall();
      expect(configFile).toBe("wrangler.jsonc");
      expect(manifest.name).toBe("deploy-test");
      expect(manifest.compatibilityDate).toBe("2026-01-01");

      const kinds = manifest.resources.map(resource => resource.kind);
      expect(kinds).toContain("r2");
      expect(kinds).toContain("kv");
      expect(kinds).toContain("d1");
      expect(kinds).toContain("queue");
      expect(kinds).toContain("do");
      expect(manifest.resources).toHaveLength(5);
    });

    it("the written manifest carries each resource's configured binding/identity", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });

      const { manifest } = firstWranglerConfigCall();
      const byKind = Object.fromEntries(manifest.resources.map(r => [r.kind, r]));

      expect(byKind.kv?.binding).toBe("KV");
      expect(byKind.d1?.binding).toBe("DB");
      expect(byKind.r2?.bucket).toBe("ASSETS");
      expect(byKind.queue?.producers).toEqual(["JOBS"]);
      expect(byKind.do?.bindings).toEqual({ counter: "COUNTER" });
    });
  });

  // ─── 2. deploy:phase ordering ──────────────────────────────────────────────

  describe("deploy:phase ordering", () => {
    it("emits phases in pipeline order: detect → provision → wrangler-config → upload → deploy", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });
      await flushEvents();

      const phases = recorded
        .filter((entry): entry is Extract<Recorded, { event: "deploy:phase" }> => {
          return entry.event === "deploy:phase";
        })
        .map(entry => entry.payload.phase);

      expect(phases).toEqual(["detect", "provision", "wrangler-config", "upload", "deploy"]);
    });

    it("the upload phase carries a file-count detail from the mocked R2 upload", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });
      await flushEvents();

      const upload = recorded.find(
        (entry): entry is Extract<Recorded, { event: "deploy:phase" }> =>
          entry.event === "deploy:phase" && entry.payload.phase === "upload"
      );

      // uploadDirToR2 is mocked to resolve 2 → detail "2 files".
      expect(upload?.payload.detail).toBe("2 files");
    });
  });

  // ─── 3. provision:resource per resource ────────────────────────────────────

  describe("provision:resource per provisioned resource", () => {
    it("calls provisionResource once per manifest resource (five total)", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });

      expect(provisionResource).toHaveBeenCalledTimes(5);
    });

    it("records provision:resource for every resource with the correct kind + name", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });
      await flushEvents();

      const provisions = recorded
        .filter((entry): entry is Extract<Recorded, { event: "provision:resource" }> => {
          return entry.event === "provision:resource";
        })
        .map(entry => entry.payload);

      expect(provisions).toHaveLength(5);

      const byKind = Object.fromEntries(provisions.map(payload => [payload.kind, payload.name]));
      expect(byKind.kv).toBe("KV");
      expect(byKind.d1).toBe("DB");
      expect(byKind.r2).toBe("ASSETS");
      expect(byKind.queue).toBe("JOBS");
      expect(byKind.do).toBe("COUNTER");
    });
  });

  // ─── 4. deploy:complete url ─────────────────────────────────────────────────

  describe("deploy:complete url", () => {
    it("records deploy:complete with the url resolved by the mocked runWrangler", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });
      await flushEvents();

      const complete = recorded.find(
        (entry): entry is Extract<Recorded, { event: "deploy:complete" }> =>
          entry.event === "deploy:complete"
      );

      expect(complete).toBeDefined();
      expect(complete?.payload.url).toBe("https://deploy-test.workers.dev");
    });

    it("runs `wrangler deploy --config wrangler.jsonc` at the end of the pipeline", async () => {
      const app = createToolingApp();

      await app.deploy.run({ yes: true });

      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ─── 5. cli delegates to deploy ─────────────────────────────────────────────

  describe("app.cli delegates to the deploy plugin", () => {
    it("app.cli.deploy() drives deploy.run — provisions, writes config, runs wrangler deploy", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ yes: true });

      // Same node seams the deploy path hits — proves cli forwarded to deploy.run.
      expect(provisionResource).toHaveBeenCalledTimes(5);
      expect(writeWranglerConfigMock).toHaveBeenCalledTimes(1);
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("app.cli.deploy() surfaces the same global deploy events the recorder captures", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ yes: true });
      await flushEvents();

      const events = recorded.map(entry => entry.event);
      expect(events).toContain("deploy:phase");
      expect(events).toContain("provision:resource");
      expect(events).toContain("deploy:complete");

      const complete = recorded.find(
        (entry): entry is Extract<Recorded, { event: "deploy:complete" }> =>
          entry.event === "deploy:complete"
      );
      expect(complete?.payload.url).toBe("https://deploy-test.workers.dev");
    });

    it("cli's deploy hooks format deploy events into the log trace (> detect, done -> <url>)", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ yes: true });
      await flushEvents();

      // cli registers hook formatters that write one line per event via ctx.log.
      // The in-memory trace sink is always installed, so the formatted lines appear there.
      const events = app.log.trace().map(entry => entry.event);

      expect(events).toContain("> detect");
      expect(events).toContain("> provision");
      expect(events).toContain("  + kv KV");
      expect(events).toContain("done -> https://deploy-test.workers.dev");
    });

    it("app.cli.dev() delegates to deploy.dev → wrangler dev on the configured port", async () => {
      const app = createToolingApp();

      await expect(app.cli.dev()).resolves.toBeUndefined();

      expect(runWrangler).toHaveBeenCalledWith(
        expect.arrayContaining(["dev", "--port", "8787", "--config", "wrangler.jsonc"])
      );
    });

    it("app.cli.dev({ port }) forwards an explicit port through to wrangler dev", async () => {
      const app = createToolingApp();

      await expect(app.cli.dev({ port: 3000 })).resolves.toBeUndefined();

      expect(runWrangler).toHaveBeenCalledWith(
        expect.arrayContaining(["dev", "--port", "3000", "--config", "wrangler.jsonc"])
      );
    });
  });
});
