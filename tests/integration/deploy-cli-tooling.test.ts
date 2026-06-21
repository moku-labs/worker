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
 * defaults — core log/env/stage + bindings + server) plus the node-only deploy tooling
 * (deployPlugin + cliPlugin) from the package root. The five resource plugins are registered before deploy
 * (deploy depends on all five), and cli is registered after deploy (cli depends on deploy).
 */
import { describe, expect, it, vi } from "vitest";

import type { WorkerEvents } from "../../src/config";

// ─────────────────────────────────────────────────────────────────────────────
// Module stubs — hoisted by vitest so the deploy api sees the mocked node seams.
// Paths are re-rooted from tests/integration/ → ../../src/plugins/deploy/* .
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/plugins/deploy/runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("https://deploy-test.workers.dev"),
  runWranglerInherit: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../src/plugins/deploy/wrangler-config", async importActual => ({
  // Stub only the two side-effecting (node:fs) writers; keep the PURE `wranglerExtra`
  // (the typed entry/nodeCompat/assets/wrangler → extra-keys mapper) the real run() now calls.
  ...(await importActual<typeof import("../../src/plugins/deploy/wrangler-config")>()),
  writeWranglerConfig: vi.fn().mockResolvedValue(undefined),
  scaffoldWranglerAndCi: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../src/plugins/deploy/providers", () => ({
  provisionResource: vi.fn().mockResolvedValue({})
}));

vi.mock("../../src/plugins/deploy/providers/r2", () => ({
  uploadDirToR2: vi.fn().mockResolvedValue(2),
  provisionR2: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../src/plugins/deploy/infra/plan", () => ({
  // Bypass the Cloudflare REST preflight: treat every manifest resource as missing.
  planInfra: vi.fn(async (_ctx: unknown, manifest: { resources: unknown[] }) => ({
    account: "test-account",
    accountId: "acct-test",
    exists: [],
    missing: manifest.resources,
    ships: []
  }))
}));

vi.mock("../../src/plugins/deploy/auth/verify", () => ({
  verifyAuth: vi
    .fn()
    .mockResolvedValue({ ok: true, account: "test", accountId: "acct-test", scopes: [] })
}));

vi.mock("../../src/plugins/deploy/dev/runner", () => ({
  // Stub the long-lived dev watch loop + its deps so the integration test never blocks.
  runDev: vi.fn().mockResolvedValue(undefined),
  realDevDeps: vi.fn(() => ({}))
}));

// Imported AFTER the vi.mock calls above (which are hoisted) so these resolve to the mocks.
import { afterAll, beforeAll, beforeEach } from "vitest";
import {
  cliPlugin,
  createApp,
  createPlugin,
  d1Plugin,
  deployPlugin,
  durableObjectsPlugin,
  kvPlugin,
  queuesPlugin,
  storagePlugin
} from "../../src/index";
import { runDev } from "../../src/plugins/deploy/dev/runner";
import { provisionResource } from "../../src/plugins/deploy/providers";
import { runWrangler } from "../../src/plugins/deploy/runner";
import { writeWranglerConfig } from "../../src/plugins/deploy/wrangler-config";

// Clear mocks between tests so call counts/args don't bleed across assertions.
beforeEach(() => {
  vi.clearAllMocks();
});

// The deploy TUI is always branded; silence its console output for the whole file (the
// branded log sink writes to stdout/stderr, while assertions read the in-memory trace).
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
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
      storage: { assets: { name: "assets", binding: "ASSETS", upload: "./public" } },
      kv: { cache: { name: "kv", binding: "KV" } },
      d1: { main: { name: "db", binding: "DB", migrations: "./migrations" } },
      queues: { jobs: { name: "jobs", binding: "JOBS", onMessage: async () => undefined } },
      durableObjects: { counter: { binding: "COUNTER", className: "Counter" } },
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

      await app.deploy.run({ ci: true });

      expect(writeWranglerConfigMock).toHaveBeenCalledTimes(1);

      const { configFile, manifest } = firstWranglerConfigCall();
      expect(configFile).toBe("wrangler.jsonc");
      // The worker name is stage-qualified too: stage "test" → base + `-test`.
      expect(manifest.name).toBe("deploy-test-test");
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

      await app.deploy.run({ ci: true });

      const { manifest } = firstWranglerConfigCall();
      const byKind = Object.fromEntries(manifest.resources.map(r => [r.kind, r]));

      // Each entry is now a per-instance descriptor `{ kind, name, binding, … }` (DO carries no
      // provisioned name — it ships with the Worker — so it declares `binding` + `className`).
      // Names are stage-qualified: stage "test" suffixes every base name with `-test`.
      expect(byKind.kv?.binding).toBe("KV");
      expect(byKind.kv?.name).toBe("kv-test");
      expect(byKind.d1?.binding).toBe("DB");
      expect(byKind.d1?.name).toBe("db-test");
      expect(byKind.r2?.binding).toBe("ASSETS");
      expect(byKind.r2?.name).toBe("assets-test");
      expect(byKind.queue?.binding).toBe("JOBS");
      expect(byKind.queue?.name).toBe("jobs-test");
      expect(byKind.do?.binding).toBe("COUNTER");
      expect(byKind.do?.className).toBe("Counter");
    });
  });

  // ─── 2. deploy:phase ordering ──────────────────────────────────────────────

  describe("deploy:phase ordering", () => {
    it("emits phases in pipeline order: detect → provision → wrangler-config → migrate → upload → deploy", async () => {
      const app = createToolingApp();

      await app.deploy.run({ ci: true });
      await flushEvents();

      const phases = recorded
        .filter((entry): entry is Extract<Recorded, { event: "deploy:phase" }> => {
          return entry.event === "deploy:phase";
        })
        .map(entry => entry.payload.phase);

      expect(phases).toEqual([
        "auth",
        "detect",
        "provision",
        "wrangler-config",
        "upload",
        "deploy"
      ]);
    });

    it("the upload phase carries a file-count detail from the mocked R2 upload", async () => {
      const app = createToolingApp();

      await app.deploy.run({ ci: true });
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

      await app.deploy.run({ ci: true });

      expect(provisionResource).toHaveBeenCalledTimes(5);
    });

    it("records provision:resource for every resource with the correct kind + name", async () => {
      const app = createToolingApp();

      await app.deploy.run({ ci: true });
      await flushEvents();

      const provisions = recorded
        .filter((entry): entry is Extract<Recorded, { event: "provision:resource" }> => {
          return entry.event === "provision:resource";
        })
        .map(entry => entry.payload);

      expect(provisions).toHaveLength(5);

      // provision:resource carries `resourceName(resource)`: the stage-qualified Cloudflare name for
      // the provisioned kinds (kv/d1/r2/queue → base + `-test`), or the exported className for a DO.
      const byKind = Object.fromEntries(provisions.map(payload => [payload.kind, payload.name]));
      expect(byKind.kv).toBe("kv-test");
      expect(byKind.d1).toBe("db-test");
      expect(byKind.r2).toBe("assets-test");
      expect(byKind.queue).toBe("jobs-test");
      expect(byKind.do).toBe("Counter");
    });
  });

  // ─── 4. deploy:complete url ─────────────────────────────────────────────────

  describe("deploy:complete url", () => {
    it("records deploy:complete with the url resolved by the mocked runWrangler", async () => {
      const app = createToolingApp();

      await app.deploy.run({ ci: true });
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

      await app.deploy.run({ ci: true });

      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ─── 5. cli delegates to deploy ─────────────────────────────────────────────

  describe("app.cli delegates to the deploy plugin", () => {
    it("app.cli.deploy() drives deploy.run — provisions, writes config, runs wrangler deploy", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ ci: true });

      // Same node seams the deploy path hits — proves cli forwarded to deploy.run.
      expect(provisionResource).toHaveBeenCalledTimes(5);
      expect(writeWranglerConfigMock).toHaveBeenCalledTimes(1);
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("app.cli.deploy() surfaces the same global deploy events the recorder captures", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ ci: true });
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

    it("cli's deploy hooks format deploy phases into the log trace (detect, provision, deploy)", async () => {
      const app = createToolingApp();

      await app.cli.deploy({ ci: true });
      await flushEvents();

      // cli registers hook formatters that write one line per deploy:phase event via ctx.log. The
      // in-memory trace sink is always installed, so the formatted phase lines appear there. (The infra
      // plan + per-resource result + the deploy summary — including the URL — are branded PANELS
      // rendered by the deploy plugin, not ctx.log lines, so they are not in the trace.)
      const events = app.log.trace().map(entry => entry.event);

      expect(events).toContain("detect");
      expect(events).toContain("provision");
      expect(events).toContain("deploy");
    });

    it("app.cli.dev() delegates to deploy.dev → the dev orchestrator (runDev)", async () => {
      const app = createToolingApp();

      await expect(app.cli.dev()).resolves.toBeUndefined();

      expect(runDev).toHaveBeenCalled();
    });

    it("app.cli.dev({ port }) forwards an explicit port through to runDev", async () => {
      const app = createToolingApp();

      await expect(app.cli.dev({ port: 3000 })).resolves.toBeUndefined();

      expect(runDev).toHaveBeenCalledWith(expect.anything(), { port: 3000 }, expect.anything());
    });
  });
});
