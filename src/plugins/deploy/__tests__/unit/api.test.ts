/**
 * Unit tests for createDeployApi — mock ctx, no kernel, wrangler runner stubbed.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { d1Plugin } from "../../../d1";
import { durableObjectsPlugin } from "../../../durable-objects";
import { kvPlugin } from "../../../kv";
import { queuesPlugin } from "../../../queues";
import { storagePlugin } from "../../../storage";
import { turnPlugin } from "../../../turn";
import { createDeployApi } from "../../api";
import type {
  Api,
  Ctx,
  DeployReport,
  ExternalManifest,
  ResourceManifest,
  SeedConfig,
  WebBuild
} from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Vitest module stubs — must be at top level (hoisted by vitest)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../runner", () => ({
  // Branch on the wrangler verb so the post-deploy migrate/seed steps get realistic, parseable
  // output (the panels read counts/names from it) while `deploy` still yields the URL. The deploy
  // retry/abort tests' `*ValueOnce` overrides still win for their queued call, then fall back here.
  runWrangler: vi.fn((args: string[]) => {
    if (args[0] === "deploy") return Promise.resolve("https://test.workers.dev");
    if (args[1] === "migrations") {
      return Promise.resolve("Applying 0001_init.sql\n0002_boards.sql\n✅ 2 migrations applied");
    }
    if (args[1] === "execute") return Promise.resolve("🚣 5 commands executed\n12 rows written");
    return Promise.resolve("");
  }),
  runWranglerInherit: vi.fn().mockResolvedValue(undefined)
}));

// Only the fs-bound writers are stubbed; wranglerExtra (pure) runs for real so the `extra` arg
// threaded into writeWranglerConfig is the genuinely-derived passthrough.
vi.mock("../../wrangler-config", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    writeWranglerConfig: vi.fn().mockResolvedValue(undefined),
    scaffoldWranglerAndCi: vi.fn().mockResolvedValue(undefined)
  };
});

vi.mock("../../providers", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual, // ProvisionDeps is a type; provisionResource/destroyResource are the stubs below
    // Turn resources yield the once-returned credentials for the post-deploy bind (like the real
    // provisioner); every other kind provisions to an empty outcome.
    provisionResource: vi.fn(async (resource: ResourceManifest) =>
      resource.kind === "turn"
        ? {
            id: "turn-uid-1",
            secrets: { TURN_KEY_ID: "turn-uid-1", TURN_KEY_API_TOKEN: "turn-secret-1" }
          }
        : {}
    ),
    destroyResource: vi.fn().mockResolvedValue(undefined)
  };
});

// The REST level is exercised in providers/turn.test.ts; here the bind is stubbed so the pipeline
// tests assert the WIRING (when it runs, what it receives, how its outcome lands in the report).
// turnInstruction stays real (pure) so degraded messages carry the actual instruction line.
vi.mock("../../providers/turn", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    bindTurnSecrets: vi.fn().mockResolvedValue(undefined)
  };
});

vi.mock("../../providers/r2", () => ({
  uploadDirToR2: vi.fn().mockResolvedValue(3),
  provisionR2: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../providers/worker", () => ({
  deleteWorker: vi.fn().mockResolvedValue(undefined)
}));

// workerExists (network-bound) is mocked; the rest of infra/cloudflare is unused here (planInfra,
// which wraps the real client, is itself mocked above).
vi.mock("../../infra/cloudflare", () => ({
  workerExists: vi.fn().mockResolvedValue(true)
}));

// The inline typed prompt — default resolves "" (a non-match); destroy tests set it per case.
vi.mock("../../prompt", () => ({
  promptLine: vi.fn().mockResolvedValue("")
}));

vi.mock("../../infra/plan", () => ({
  // Default: nothing exists yet → every manifest resource is "missing" (gets created).
  planInfra: vi.fn(async (_ctx: unknown, manifest: { resources: unknown[] }) => ({
    account: "test-account",
    accountId: "acct-test",
    exists: [],
    missing: manifest.resources,
    ships: []
  }))
}));

vi.mock("../../auth/verify", () => ({
  // Network-bound; mocked. requiredToken/tokenInstructions are pure and run for real.
  verifyAuth: vi
    .fn()
    .mockResolvedValue({ ok: true, account: "Play Co", accountId: "acc-1", scopes: [] })
}));

// .env.local scaffolder is fs-bound; mocked. envLocalScaffold (pure) runs for real.
vi.mock("../../auth/env-file", () => ({
  ensureEnvLocal: vi.fn().mockResolvedValue({ created: true, path: "/cwd/.env.local" })
}));

// dev() delegates to runDev; mock it so the long-lived watch loop never runs in unit tests. Keep the
// real d1MigrationBindings (run()'s remote-migrate step uses it) so it reflects the mock ctx's d1.
vi.mock("../../dev/runner", async importOriginal => {
  const actual = await importOriginal<typeof import("../../dev/runner")>();
  return {
    ...actual,
    runDev: vi.fn().mockResolvedValue(undefined),
    realDevDeps: vi.fn(() => ({}))
  };
});

// TTY defaults to interactive so the guided path is exercisable; overridden per test.
vi.mock("../../tty", () => ({ stdoutIsTty: vi.fn(() => true) }));

// A capturing brand-console stub factory — every render method is a spy so the guided-recovery
// output (error / hint / `auth setup` instructions) is assertable. Hoisted via vi.hoisted so the
// vi.mock factory below can reference it without tripping vitest's TDZ for top-level consts.
const { makeUi } = vi.hoisted(() => ({
  makeUi: () => ({
    line: vi.fn(),
    lockup: vi.fn(),
    heading: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    check: vi.fn(),
    railLine: vi.fn(() => ""),
    box: vi.fn(),
    // Identity palette so the branded renderer (renderAuthSetup) can colorize without throwing.
    palette: {
      enabled: false,
      paint: (_code: unknown, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
      green: (text: string) => text,
      yellow: (text: string) => text,
      red: (text: string) => text,
      cyan: (text: string) => text,
      pink: (text: string) => text
    } as never,
    color: false,
    width: 66
  })
}));

// Branded prompts mocked — confirm defaults to "yes"; overridden per guided test. The branded
// console is stubbed too so the guided-recovery render path is asserted on spies instead of
// writing real lines to the test runner's stdout.
vi.mock("@moku-labs/common/cli", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createBrandPrompts: vi.fn(() => ({
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn()
    })),
    createBrandConsole: vi.fn(() => makeUi())
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Imports after mocking
// ─────────────────────────────────────────────────────────────────────────────

import { createBrandConsole, createBrandPrompts } from "@moku-labs/common/cli";
import { beforeEach } from "vitest";
import { ensureEnvLocal } from "../../auth/env-file";
import { verifyAuth } from "../../auth/verify";
import { runDev } from "../../dev/runner";
import { workerExists } from "../../infra/cloudflare";
import { planInfra } from "../../infra/plan";
import { promptLine } from "../../prompt";
import { destroyResource, provisionResource } from "../../providers";
import { uploadDirToR2 } from "../../providers/r2";
import { bindTurnSecrets } from "../../providers/turn";
import { deleteWorker } from "../../providers/worker";
import { runWrangler, runWranglerInherit } from "../../runner";
import { stdoutIsTty } from "../../tty";
import { scaffoldWranglerAndCi, writeWranglerConfig } from "../../wrangler-config";

// Clear mocks between tests so call counts don't bleed across assertions.
beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock context factory
// ─────────────────────────────────────────────────────────────────────────────

const makeStorageApi = (uploadDir = "./public") => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  deployManifest: vi
    .fn()
    .mockReturnValue([
      { kind: "r2" as const, name: "assets", binding: "ASSETS", upload: uploadDir }
    ])
});

const makeKvApi = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  deployManifest: vi.fn().mockReturnValue([{ kind: "kv" as const, name: "cache", binding: "KV" }])
});

const makeD1Api = () => ({
  query: vi.fn(),
  first: vi.fn(),
  run: vi.fn(),
  batch: vi.fn(),
  prepare: vi.fn(),
  deployManifest: vi
    .fn()
    .mockReturnValue([
      { kind: "d1" as const, name: "db", binding: "DB", migrations: "./migrations" }
    ])
});

const makeQueuesApi = () => ({
  send: vi.fn(),
  sendBatch: vi.fn(),
  consume: vi.fn(),
  deployManifest: vi
    .fn()
    .mockReturnValue([{ kind: "queue" as const, name: "orders", binding: "ORDERS" }])
});

const makeDoApi = () => ({
  get: vi.fn(),
  deployManifest: vi
    .fn()
    .mockReturnValue([{ kind: "do" as const, binding: "COUNTER", className: "Counter" }])
});

// Default: NO turn instance declared (the plugin's own empty-map default) — the turn phase stays
// "skipped" in the general pipeline tests; the turn-specific describe overrides the manifest.
const makeTurnApi = (manifest: ResourceManifest[] = []) => ({
  deployManifest: vi.fn().mockReturnValue(manifest)
});

type PluginArg =
  | typeof storagePlugin
  | typeof kvPlugin
  | typeof d1Plugin
  | typeof queuesPlugin
  | typeof durableObjectsPlugin
  | typeof turnPlugin;

const createMockCtx = (overrides?: {
  has?: (name: string) => boolean;
  global?: {
    name: string;
    compatibilityDate: string;
    stage: "production" | "development" | "test";
  };
  configFile?: string;
  ci?: boolean;
  storageUploadDir?: string;
  seed?: SeedConfig;
  turnManifest?: ResourceManifest[];
}): Ctx => {
  const storageApi = makeStorageApi(overrides?.storageUploadDir);
  const kvApi = makeKvApi();
  const d1Api = makeD1Api();
  const queuesApi = makeQueuesApi();
  const doApi = makeDoApi();
  const turnApi = makeTurnApi(overrides?.turnManifest);

  const requireFn = (plugin: PluginArg) => {
    if (plugin === storagePlugin) return storageApi;
    if (plugin === kvPlugin) return kvApi;
    if (plugin === d1Plugin) return d1Api;
    if (plugin === queuesPlugin) return queuesApi;
    if (plugin === durableObjectsPlugin) return doApi;
    if (plugin === turnPlugin) return turnApi;
    throw new Error(`Unexpected plugin: ${String(plugin)}`);
  };

  return {
    config: {
      configFile: overrides?.configFile ?? "wrangler.jsonc",
      ci: overrides?.ci ?? false,
      watch: ["src/**/*"],
      buildCommand: "",
      migrateLocal: true,
      debounceMs: 120,
      ...(overrides?.seed === undefined ? {} : { seed: overrides.seed })
    },
    state: {} as Record<string, never>,
    emit: vi.fn(),
    global: overrides?.global ?? {
      name: "test-worker",
      compatibilityDate: "2026-06-17",
      stage: "test"
    },
    env: {
      // Mirrors a real post-auth run: the token is present in the env (verifyAuth required it).
      get: (key: string) => (key === "CLOUDFLARE_API_TOKEN" ? "test-token" : undefined),
      require: () => "test-token",
      has: () => true,
      getPublic: () => ({}),
      getPublicMap: () => new Map<string, string>()
    },
    require: requireFn as Ctx["require"],
    has: overrides?.has ?? ((_name: string) => true)
  };
};

/** Cast a capturing UI stub to the BrandConsole shape for createBrandConsole.mockReturnValueOnce. */
const asConsole = (ui: ReturnType<typeof makeUi>): ReturnType<typeof createBrandConsole> =>
  ui as unknown as ReturnType<typeof createBrandConsole>;

/** Stub the next createBrandPrompts() with a controlled confirm (the guided-recovery prompt). */
const stubPrompts = (confirm: (question: string) => Promise<boolean>): void => {
  vi.mocked(createBrandPrompts).mockReturnValueOnce({
    confirm,
    select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createDeployApi", () => {
  // ───────── run — manifest assembly ─────────────────────────────────────────

  describe("run — manifest assembly", () => {
    it("assembles manifest from each plugin's deployManifest() when has() returns true", async () => {
      // production stage → resource names stay bare (no `-stage` suffix).
      const ctx = createMockCtx({
        global: { name: "test-worker", compatibilityDate: "2026-06-17", stage: "production" }
      });
      const api = createDeployApi(ctx);

      await api.run();

      expect(writeWranglerConfig).toHaveBeenCalled();
      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      expect(manifest.resources).toContainEqual({ kind: "kv", name: "cache", binding: "KV" });
      expect(manifest.resources).toContainEqual(
        expect.objectContaining({ kind: "r2", name: "assets", binding: "ASSETS" })
      );
      expect(manifest.resources).toContainEqual({
        kind: "d1",
        name: "db",
        binding: "DB",
        migrations: "./migrations"
      });
      expect(manifest.resources).toContainEqual({
        kind: "queue",
        name: "orders",
        binding: "ORDERS"
      });
      expect(manifest.resources).toContainEqual({
        kind: "do",
        binding: "COUNTER",
        className: "Counter"
      });
    });

    it("uses ctx.global.name and ctx.global.compatibilityDate in the assembled manifest", async () => {
      const ctx = createMockCtx({
        global: { name: "my-worker", compatibilityDate: "2026-01-01", stage: "production" }
      });
      const api = createDeployApi(ctx);

      await api.run();

      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      expect(manifest.name).toBe("my-worker");
      expect(manifest.compatibilityDate).toBe("2026-01-01");
    });

    it("skips a resource plugin when has() returns false", async () => {
      const ctx = createMockCtx({ has: name => name !== "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      const kinds = manifest.resources.map(resource => resource.kind);
      expect(kinds).not.toContain("kv");
      expect(kinds).toContain("r2");
    });

    it("uses the caller-supplied manifest verbatim when opts.manifest is provided", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);
      const callerManifest: ExternalManifest = {
        name: "legacy-worker",
        compatibilityDate: "2026-06-17",
        resources: [{ kind: "kv", name: "legacy-cache", binding: "CACHE" }]
      };

      await api.run({ manifest: callerManifest });

      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      expect(manifest.name).toBe("legacy-worker");
      expect(manifest.resources).toEqual([{ kind: "kv", name: "legacy-cache", binding: "CACHE" }]);
    });

    it("does NOT call deployManifest() when opts.manifest is provided (universal path)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);
      const callerManifest: ExternalManifest = {
        name: "x",
        compatibilityDate: "2026-01-01",
        resources: []
      };

      await api.run({ manifest: callerManifest });

      const storageApi = ctx.require(storagePlugin);
      const kvApi = ctx.require(kvPlugin);
      expect(storageApi.deployManifest).not.toHaveBeenCalled();
      expect(kvApi.deployManifest).not.toHaveBeenCalled();
    });
  });

  // ───────── run — emit sequence ─────────────────────────────────────────────

  describe("run — emit sequence", () => {
    it("emits deploy:phase for each pipeline stage in order (no resources)", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >;
      const phases = emitCalls
        .filter(([event]) => event === "deploy:phase")
        .map(([, payload]) => (payload as { phase: string }).phase);

      expect(phases).toEqual(["auth", "detect", "provision", "wrangler-config", "deploy"]);
    });

    it("emits deploy:phase in full order detect → provision → wrangler-config → migrate → upload → deploy", async () => {
      const ctx = createMockCtx(); // all resources present (d1 has migrations); storage has an upload dir
      const api = createDeployApi(ctx);

      await api.run();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >;
      const phases = emitCalls
        .filter(([event]) => event === "deploy:phase")
        .map(([, payload]) => (payload as { phase: string }).phase);

      expect(phases).toEqual([
        "auth",
        "detect",
        "provision",
        "wrangler-config",
        "upload",
        "deploy"
      ]);
    });

    it("emits deploy:phase upload with detail when r2 has an upload dir", async () => {
      const ctx = createMockCtx({ has: name => name === "storage" });
      const api = createDeployApi(ctx);

      await api.run();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, { phase?: string; detail?: string }]
      >;
      const uploadEmit = emitCalls.find(
        ([event, payload]) => event === "deploy:phase" && payload.phase === "upload"
      );
      expect(uploadEmit).toBeDefined();
      expect(uploadEmit?.[1].detail).toBe("3 files");
    });

    it("does NOT emit upload phase when there is no r2 resource", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >;
      const uploadEmit = emitCalls.find(
        ([event, payload]) =>
          event === "deploy:phase" && (payload as { phase: string }).phase === "upload"
      );
      expect(uploadEmit).toBeUndefined();
    });

    it("does NOT emit upload phase when r2 resource has no upload dir", async () => {
      const ctx = createMockCtx({ has: name => name === "storage", storageUploadDir: "" });
      // Override the storage api so it returns no upload
      const storageApiNoUpload = {
        ...makeStorageApi(),
        deployManifest: vi.fn().mockReturnValue({ kind: "r2" as const, bucket: "ASSETS" })
      };
      const ctxNoUpload: Ctx = {
        ...ctx,
        require: ((plugin: PluginArg) => {
          if (plugin === storagePlugin) return storageApiNoUpload;
          return ctx.require(plugin as Parameters<typeof ctx.require>[0]);
        }) as Ctx["require"]
      };
      const api = createDeployApi(ctxNoUpload);

      await api.run();

      const emitCalls = (ctxNoUpload.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >;
      const uploadEmit = emitCalls.find(
        ([event, payload]) =>
          event === "deploy:phase" && (payload as { phase: string }).phase === "upload"
      );
      expect(uploadEmit).toBeUndefined();
    });

    it("emits provision:resource for each resource", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, unknown]
      >;
      const provisionEmits = emitCalls.filter(([event]) => event === "provision:resource");
      expect(provisionEmits.length).toBe(5);
    });

    it("emits provision:resource with correct kind and stage-suffixed name for kv", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      // Default mock stage is "test", so the kv resource name "cache" is suffixed → "cache-test".
      expect(ctx.emit).toHaveBeenCalledWith("provision:resource", {
        kind: "kv",
        name: "cache-test"
      });
    });

    it("emits deploy:complete with url after wrangler deploy", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(ctx.emit).toHaveBeenCalledWith("deploy:complete", { url: "https://test.workers.dev" });
    });

    it("calls provisionResource for each resource in the manifest", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      // Default mock stage is "test" → the kv resource name is stage-suffixed before provisioning.
      expect(provisionResource).toHaveBeenCalledWith(
        { kind: "kv", name: "cache-test", binding: "KV" },
        false,
        expect.anything() // the REST deps bundle every provider receives (turn consumes it)
      );
    });

    it("calls writeWranglerConfig with the configFile from ctx.config", async () => {
      const ctx = createMockCtx({ configFile: "my-wrangler.jsonc", has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(writeWranglerConfig).toHaveBeenCalledWith(
        "my-wrangler.jsonc",
        expect.any(Object),
        expect.any(Object),
        {} // wranglerExtra(ctx.config) — no entry/nodeCompat/assets/wrangler set → empty extra
      );
    });

    it("passes ctx.config.wrangler through to writeWranglerConfig (the passthrough)", async () => {
      const base = createMockCtx({ has: () => false });
      const wrangler = { main: "src/cloudflare/worker.ts", compatibility_flags: ["nodejs_compat"] };
      const ctx: Ctx = { ...base, config: { ...base.config, wrangler } };
      const api = createDeployApi(ctx);

      await api.run();

      const calls = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, ExternalManifest, Record<string, string>, Record<string, unknown>]
      >;
      expect(calls.at(-1)?.[3]).toEqual(wrangler);
    });

    it("threads the captured provision id into writeWranglerConfig", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      vi.mocked(provisionResource).mockResolvedValueOnce({ id: "ns-abc123" });
      const api = createDeployApi(ctx);

      await api.run();

      const calls = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, ExternalManifest, Record<string, string>]
      >;
      expect(calls.at(-1)?.[2]).toEqual({ KV: "ns-abc123" });
    });

    it("calls runWrangler with deploy and configFile args", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ───────── run — webBuild (web composed in from the app-side script) ─────────

  describe("run — webBuild", () => {
    it("builds the web first when opts.webBuild is provided (build·web right after auth)", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);
      const webBuild = vi.fn<WebBuild>().mockResolvedValue({ files: 6 });

      await api.run({ webBuild });

      expect(webBuild).toHaveBeenCalledOnce();

      const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, { phase?: string; detail?: string }]
      >;
      const phases = emitCalls
        .filter(([event]) => event === "deploy:phase")
        .map(([, payload]) => payload.phase);
      expect(phases).toEqual(["auth", "build", "detect", "provision", "wrangler-config", "deploy"]);

      const buildEmit = emitCalls.find(
        ([event, payload]) => event === "deploy:phase" && payload.phase === "build"
      );
      expect(buildEmit?.[1].detail).toBe("web");
    });

    it("falls back to ctx.config.webBuild when opts.webBuild is absent", async () => {
      const base = createMockCtx({ has: () => false });
      const configWebBuild = vi.fn<WebBuild>().mockResolvedValue(undefined);
      const ctx: Ctx = { ...base, config: { ...base.config, webBuild: configWebBuild } };
      const api = createDeployApi(ctx);

      await api.run();

      expect(configWebBuild).toHaveBeenCalledOnce();
    });
  });

  // ───────── infra preflight (check-before-create) ────────────────────────────

  describe("infra preflight", () => {
    it("skips a resource that already exists and reuses its captured id", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct",
        exists: [{ resource: { kind: "kv", name: "cache", binding: "KV" }, id: "ns-existing" }],
        missing: [],
        ships: []
      });
      const api = createDeployApi(ctx);

      await api.run();

      expect(provisionResource).not.toHaveBeenCalled();
      // The skip event carries the resource name (resourceName), keyed by the plan's verbatim entry.
      expect(ctx.emit).toHaveBeenCalledWith("provision:skip", { kind: "kv", name: "cache" });
      const calls = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as Array<
        [string, ExternalManifest, Record<string, string>]
      >;
      expect(calls.at(-1)?.[2]).toEqual({ KV: "ns-existing" });
    });

    it("checkInfra returns the plan from planInfra without writing config", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      const plan = await api.checkInfra();

      expect(plan).toMatchObject({ exists: [], missing: [] });
      expect(writeWranglerConfig).not.toHaveBeenCalled();
    });

    it("provisionInfra creates the missing resources and returns the result", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      const result = await api.provisionInfra({
        account: "acct",
        accountId: "acct",
        exists: [],
        missing: [{ kind: "kv", name: "cache", binding: "KV" }],
        ships: []
      });

      expect(provisionResource).toHaveBeenCalledWith(
        { kind: "kv", name: "cache", binding: "KV" },
        false,
        expect.anything() // the REST deps bundle every provider receives (turn consumes it)
      );
      expect(result.created).toEqual([{ resource: { kind: "kv", name: "cache", binding: "KV" } }]);
    });

    it("provisionInfra bundles DOs (ships) — never creates them, but still emits provision:skip", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);
      const doResource = { kind: "do" as const, binding: "BOARD", className: "BoardChannel" };

      const result = await api.provisionInfra({
        account: "acct",
        accountId: "acct",
        exists: [],
        missing: [],
        ships: [doResource]
      });

      // A DO is created by `wrangler deploy`, never at the provision step.
      expect(provisionResource).not.toHaveBeenCalled();
      expect(result.created).toEqual([]);
      expect(result.bundled).toEqual([doResource]);
      // Still announced as skipped so a consumer hooking provision:skip sees it.
      expect(ctx.emit).toHaveBeenCalledWith("provision:skip", { kind: "do", name: "BoardChannel" });
    });
  });

  // ───────── auth (verify + token derivation) ─────────────────────────────────

  describe("auth", () => {
    it("verifyAuth delegates to the auth/verify module with ctx", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const status = await api.verifyAuth();

      expect(verifyAuth).toHaveBeenCalledWith(ctx);
      expect(status).toMatchObject({ ok: true, account: "Play Co" });
    });

    it("requiredToken derives the permission set from the manifest (D1 + Queues to add)", () => {
      const ctx = createMockCtx(); // all five resources present
      const api = createDeployApi(ctx);

      const groups = api.requiredToken().toAdd.map(permission => permission.group);

      expect(groups).toContain("Account · D1");
      expect(groups).toContain("Account · Queues");
    });

    it("tokenInstructions returns rendered guidance", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expect(api.tokenInstructions()).toContain("Cloudflare API token");
    });
  });

  // ───────── wrangler passthrough ─────────────────────────────────────────────

  describe("wrangler", () => {
    it("delegates to runWranglerInherit (streaming passthrough)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.wrangler(["kv", "namespace", "list"]);

      expect(runWranglerInherit).toHaveBeenCalledWith(["kv", "namespace", "list"]);
    });
  });

  // ───────── guided prompts ───────────────────────────────────────────────────

  describe("guided prompts", () => {
    it("verifies the token before deploying (auth fail-fast)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(verifyAuth).toHaveBeenCalledWith(ctx);
    });

    it("prompts (guided) by default on a TTY and deploys when confirmed", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(createBrandPrompts).toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("aborts at the infra gate when declined (no provision, no deploy)", async () => {
      const ctx = createMockCtx();
      vi.mocked(createBrandPrompts).mockReturnValueOnce({
        confirm: vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(false),
        select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
      });
      const api = createDeployApi(ctx);

      await api.run();

      expect(provisionResource).not.toHaveBeenCalled();
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
    });

    it("aborts at the deploy gate when declined after provisioning", async () => {
      const ctx = createMockCtx();
      vi.mocked(createBrandPrompts).mockReturnValueOnce({
        confirm: vi
          .fn<(question: string) => Promise<boolean>>()
          .mockResolvedValueOnce(true)
          .mockResolvedValue(false),
        select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
      });
      const api = createDeployApi(ctx);

      await api.run();

      expect(provisionResource).toHaveBeenCalled(); // infra confirmed → provisioned
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("does NOT prompt when opts.ci is true (automated path)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run({ ci: true });

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("does NOT prompt when ctx.config.ci is the standing default", async () => {
      const ctx = createMockCtx({ ci: true });
      const api = createDeployApi(ctx);

      await api.run();

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("opts.ci=true overrides a non-ci config default", async () => {
      const ctx = createMockCtx({ ci: false });
      const api = createDeployApi(ctx);

      await api.run({ ci: true });

      expect(createBrandPrompts).not.toHaveBeenCalled();
    });

    it("does NOT prompt when stdout is not a TTY (even when not ci)", async () => {
      vi.mocked(stdoutIsTty).mockReturnValueOnce(false);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ───────── guided recovery — auth (ask + guide the user through `auth setup`) ─

  describe("guided recovery — auth", () => {
    it("shows the token-creation panel + scaffolds .env.local when the token is missing (TTY)", async () => {
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      vi.mocked(verifyAuth).mockRejectedValueOnce(
        new Error("[worker] CLOUDFLARE_API_TOKEN is not set. Run `auth setup` ...")
      );
      const confirm = vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(true);
      stubPrompts(confirm);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(confirm).toHaveBeenCalledWith("Set up Cloudflare credentials now? (guided)");
      // The instruction MUST be shown: the branded "which token / which permissions" panel.
      expect(ui.heading).toHaveBeenCalledWith("Cloudflare API token");
      expect(ui.box).toHaveBeenCalled();
      expect(ensureEnvLocal).toHaveBeenCalledWith(
        process.cwd(),
        expect.stringContaining("CLOUDFLARE_API_TOKEN=")
      );
      expect(ui.info).toHaveBeenCalledWith(
        "Created /cwd/.env.local — paste your token + account id there, then run `deploy` again."
      );
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
      // The aborted deploy reports cleanly and never reaches a remote-DB step.
      expect(report.status).toBe("aborted");
      expect(report.migration).toBe("skipped");
      expect(report.seed).toBe("skipped");
    });

    it("STILL shows the token panel when .env.local already exists (the instruction is never skipped)", async () => {
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      vi.mocked(ensureEnvLocal).mockResolvedValueOnce({ created: false, path: "/cwd/.env.local" });
      const confirm = vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(true);
      stubPrompts(confirm);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      // The user's regression: an existing (empty) .env.local must NOT swallow the instruction.
      expect(ui.heading).toHaveBeenCalledWith("Cloudflare API token");
      expect(ui.box).toHaveBeenCalled();
      expect(ui.info).toHaveBeenCalledWith(
        "/cwd/.env.local already exists — fill in CLOUDFLARE_API_TOKEN there, then run `deploy` again."
      );
    });

    it("does not scaffold an existing .env.local — tells the user to fill it in", async () => {
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      vi.mocked(ensureEnvLocal).mockResolvedValueOnce({ created: false, path: "/cwd/.env.local" });
      const confirm = vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(true);
      stubPrompts(confirm);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(ui.info).toHaveBeenCalledWith(
        "/cwd/.env.local already exists — fill in CLOUDFLARE_API_TOKEN there, then run `deploy` again."
      );
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
    });

    it("skips the guidance + scaffold but still points at .env.local when setup is declined", async () => {
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      const confirm = vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(false);
      stubPrompts(confirm);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(ui.heading).not.toHaveBeenCalled();
      expect(ensureEnvLocal).not.toHaveBeenCalled();
      expect(ui.info).toHaveBeenCalledWith(
        "Set CLOUDFLARE_API_TOKEN in .env.local, then run `deploy` again."
      );
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
      expect(provisionResource).not.toHaveBeenCalled();
    });

    it("fails fast (throws, no prompt) when auth fails in CI mode", async () => {
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await expect(api.run({ ci: true })).rejects.toThrow("token missing");
      expect(createBrandPrompts).not.toHaveBeenCalled();
    });

    it("fails fast when auth fails off a TTY (even when not ci)", async () => {
      vi.mocked(stdoutIsTty).mockReturnValueOnce(false);
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await expect(api.run()).rejects.toThrow("token missing");
      expect(createBrandPrompts).not.toHaveBeenCalled();
    });
  });

  // ───────── guided recovery — retryable steps (build / infra / upload / deploy) ─

  describe("guided recovery — retryable steps", () => {
    it("retries `wrangler deploy` when it fails and the user confirms, then completes", async () => {
      vi.mocked(runWrangler)
        .mockRejectedValueOnce(new Error("[worker] wrangler exited with code 1."))
        .mockResolvedValueOnce("https://retry.workers.dev");
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(runWrangler).toHaveBeenCalledTimes(2);
      expect(ctx.emit).toHaveBeenCalledWith("deploy:complete", {
        url: "https://retry.workers.dev"
      });
    });

    it("aborts (no deploy:complete) when the user declines a `wrangler deploy` retry", async () => {
      // Once — the call rejects exactly once (retry is declined), and a non-Once reject would
      // bleed past clearAllMocks (which clears calls, not implementations) into later tests.
      vi.mocked(runWrangler).mockRejectedValueOnce(
        new Error("[worker] wrangler exited with code 1.")
      );
      const confirm = vi
        .fn<(question: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true) // deploy-target gate
        .mockResolvedValue(false); // Retry? → no
      vi.mocked(createBrandPrompts).mockReturnValueOnce({
        confirm: confirm as unknown as (question: string) => Promise<boolean>,
        select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
      });
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(runWrangler).toHaveBeenCalledTimes(1);
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
      const completeEmit = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls.find(
        ([event]) => event === "deploy:complete"
      );
      expect(completeEmit).toBeUndefined();
    });

    it("fails fast (throws) when `wrangler deploy` fails in CI mode", async () => {
      vi.mocked(runWrangler).mockRejectedValueOnce(
        new Error("[worker] wrangler exited with code 1.")
      );
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await expect(api.run({ ci: true })).rejects.toThrow("wrangler exited");
    });

    it("re-plans and retries provisioning when the infra preflight fails, then deploys", async () => {
      vi.mocked(planInfra).mockRejectedValueOnce(new Error("[worker] Cloudflare listing failed"));
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(planInfra).toHaveBeenCalledTimes(2); // first attempt threw, retry re-planned
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("aborts (no deploy) when the user declines an R2 upload retry", async () => {
      vi.mocked(uploadDirToR2).mockRejectedValueOnce(new Error("[worker] R2 upload failed"));
      const confirm = vi
        .fn<(question: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true) // create-missing gate
        .mockResolvedValue(false); // Retry? → no
      stubPrompts(confirm);
      const ctx = createMockCtx({ has: name => name === "storage" });
      const api = createDeployApi(ctx);

      await api.run();

      expect(uploadDirToR2).toHaveBeenCalledTimes(1);
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("retries a failed web build when confirmed, then proceeds", async () => {
      const webBuild = vi
        .fn<WebBuild>()
        .mockRejectedValueOnce(new Error("build boom"))
        .mockResolvedValueOnce({ files: 3 });
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await api.run({ webBuild });

      expect(webBuild).toHaveBeenCalledTimes(2);
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ───────── guided provision — branded panels + per-resource failure handling ─

  describe("guided provision panels", () => {
    it("renders the infra plan panel and the provision result panel", async () => {
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      expect(ui.heading).toHaveBeenCalledWith("Infra plan");
      expect(ui.heading).toHaveBeenCalledWith("Provisioned");
      expect(ui.box).toHaveBeenCalledTimes(2); // plan panel + result panel
    });

    it("captures a resource failure (no throw) and aborts when the retry is declined", async () => {
      vi.mocked(provisionResource).mockRejectedValueOnce(
        new Error("[worker] wrangler exited with code 1.\n  ✘ [ERROR] bucket name invalid")
      );
      const confirm = vi
        .fn<(question: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true) // create-missing gate
        .mockResolvedValue(false); // Retry the failed resource(s)? → no
      stubPrompts(confirm);
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      expect(provisionResource).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith("Retry the failed resource(s)?");
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", { phase: "aborted" });
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("retries only the still-failed resource and proceeds once it succeeds", async () => {
      vi.mocked(provisionResource)
        .mockRejectedValueOnce(new Error("[worker] transient")) // first attempt fails
        .mockResolvedValue({}); // retry succeeds
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run(); // default confirm → yes to gate, yes to retry

      expect(provisionResource).toHaveBeenCalledTimes(2);
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("fails fast (throws) when a resource fails to provision in CI mode", async () => {
      vi.mocked(provisionResource).mockRejectedValueOnce(new Error("[worker] boom"));
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await expect(api.run({ ci: true })).rejects.toThrow("failed to provision");
    });
  });

  // ───────── dev ─────────────────────────────────────────────────────────────

  describe("dev", () => {
    it("delegates to runDev with ctx and no opts", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.dev();

      expect(runDev).toHaveBeenCalledWith(ctx, undefined, expect.anything());
    });

    it("forwards the port to runDev", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.dev({ port: 9000 });

      expect(runDev).toHaveBeenCalledWith(ctx, { port: 9000 }, expect.anything());
    });
  });

  // ───────── seed ────────────────────────────────────────────────────────────

  describe("seed", () => {
    it("generates the config, applies local migrations, then executes the SQL file (single d1)", async () => {
      const ctx = createMockCtx({ has: name => name === "d1" });
      const api = createDeployApi(ctx);

      await api.seed("db/seed.sql");

      // Config first (so the binding resolves), then migrate (DB declares migrations), then execute.
      expect(writeWranglerConfig).toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--local"]);
      expect(runWrangler).toHaveBeenCalledWith([
        "d1",
        "execute",
        "DB",
        "--local",
        "--file",
        "db/seed.sql"
      ]);
    });

    it("seeds the remote d1 (no local migrate) when opts.remote is set", async () => {
      const ctx = createMockCtx({ has: name => name === "d1" });
      const api = createDeployApi(ctx);

      await api.seed("db/seed.sql", { remote: true });

      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["migrations", "apply"]));
      expect(runWrangler).toHaveBeenCalledWith([
        "d1",
        "execute",
        "DB",
        "--remote",
        "--file",
        "db/seed.sql"
      ]);
    });

    it("throws when no d1 database is configured", async () => {
      const ctx = createMockCtx({ has: () => false });
      const api = createDeployApi(ctx);

      await expect(api.seed("db/seed.sql")).rejects.toThrow("no d1 database is configured");
    });

    it("throws (asking for a binding) when multiple d1 databases exist and none is given", async () => {
      const ctx = createMockCtx({ has: name => name === "d1" });
      (ctx.require(d1Plugin).deployManifest as ReturnType<typeof vi.fn>).mockReturnValue([
        { kind: "d1", name: "db", binding: "DB", migrations: "./migrations" },
        { kind: "d1", name: "analytics", binding: "ANALYTICS" }
      ]);
      const api = createDeployApi(ctx);

      await expect(api.seed("db/seed.sql")).rejects.toThrow("pass { binding }");
    });

    it("selects the d1 bound to opts.binding when multiple exist (no migrations → execute only)", async () => {
      const ctx = createMockCtx({ has: name => name === "d1" });
      (ctx.require(d1Plugin).deployManifest as ReturnType<typeof vi.fn>).mockReturnValue([
        { kind: "d1", name: "db", binding: "DB", migrations: "./migrations" },
        { kind: "d1", name: "analytics", binding: "ANALYTICS" }
      ]);
      const api = createDeployApi(ctx);

      await api.seed("db/analytics.sql", { binding: "ANALYTICS" });

      expect(runWrangler).toHaveBeenCalledWith([
        "d1",
        "execute",
        "ANALYTICS",
        "--local",
        "--file",
        "db/analytics.sql"
      ]);
      expect(runWrangler).not.toHaveBeenCalledWith(
        expect.arrayContaining(["migrations", "apply", "ANALYTICS"])
      );
    });

    it("throws when opts.binding matches no configured d1", async () => {
      const ctx = createMockCtx({ has: name => name === "d1" });
      const api = createDeployApi(ctx);

      await expect(api.seed("db/seed.sql", { binding: "NOPE" })).rejects.toThrow(
        'no d1 database is bound to "NOPE"'
      );
    });
  });

  // ───────── run — post-deploy (migration + seed gated on a live deploy) ───────

  // ───────── run — turn resources (manifest-driven, fail-open post-deploy) ────

  describe("run — turn resources (standard flow)", () => {
    const TURN_RESOURCE: ResourceManifest = {
      kind: "turn",
      name: "test-turn",
      keyIdBinding: "TURN_KEY_ID",
      apiTokenBinding: "TURN_KEY_API_TOKEN"
    };

    // An earlier guided-retry test replaces the module-mock implementation with a persistent
    // `.mockResolvedValue({})` (vi.clearAllMocks clears calls, NOT implementations) — re-pin the
    // turn-aware behavior here so these tests never depend on file order.
    beforeEach(() => {
      vi.mocked(provisionResource).mockImplementation(async (resource: ResourceManifest) =>
        resource.kind === "turn"
          ? {
              id: "turn-uid-1",
              secrets: { TURN_KEY_ID: "turn-uid-1", TURN_KEY_API_TOKEN: "turn-secret-1" }
            }
          : {}
      );
    });

    it("provisions a declared turn resource in the PROVISION phase like any other resource", async () => {
      const ctx = createMockCtx({ turnManifest: [TURN_RESOURCE] });
      const api = createDeployApi(ctx);

      const report = await api.run();

      // planInfra (mocked) puts every manifest resource into `missing` → the provision phase
      // creates the turn key alongside the rest, announced via provision:resource.
      const turnCall = vi
        .mocked(provisionResource)
        .mock.calls.find(([resource]) => resource.kind === "turn");
      expect(turnCall?.[0]).toMatchObject({ kind: "turn", name: "test-turn-test" }); // stage-suffixed
      expect(turnCall?.[2]).toMatchObject({ rest: { accountId: "acct-test" } }); // REST deps threaded
      expect(ctx.emit).toHaveBeenCalledWith("provision:resource", {
        kind: "turn",
        name: "test-turn-test"
      });
      expect(report.resources?.created).toBeGreaterThan(0);
    });

    it("binds the captured credentials right after wrangler deploy → turn: provisioned", async () => {
      const ctx = createMockCtx({ turnManifest: [TURN_RESOURCE] });
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(bindTurnSecrets).toHaveBeenCalledWith(
        "test-worker-test", // the stage-qualified script that just deployed
        { TURN_KEY_ID: "turn-uid-1", TURN_KEY_API_TOKEN: "turn-secret-1" },
        expect.objectContaining({ accountId: "acc-1", token: "test-token" })
      );
      expect(ctx.emit).toHaveBeenCalledWith("deploy:phase", {
        phase: "turn",
        detail: "bind secrets"
      });
      expect(report.turn).toBe("provisioned");
      expect(report.ok).toBe(true);
    });

    it("reports turn: skipped (no provisioning, no bind) when no turn resource is declared", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(bindTurnSecrets).not.toHaveBeenCalled();
      expect(report.turn).toBe("skipped");
    });

    it("a turn provision failure DEGRADES (warning + instruction) and never fails the deploy — even in CI", async () => {
      vi.mocked(provisionResource).mockImplementationOnce(async resource => {
        if (resource.kind === "turn") throw new Error("[worker] create turn_keys → HTTP 403");
        return {};
      });
      // Only the turn resource in the manifest so the once-mock hits it deterministically.
      const ctx = createMockCtx({ has: name => name === "turn", turnManifest: [TURN_RESOURCE] });
      const api = createDeployApi(ctx);

      const report = await api.run({ ci: true }); // CI: a FAILED resource would throw — degraded must not

      expect(report.status).toBe("deployed");
      expect(report.ok).toBe(true);
      expect(report.turn).toBe("degraded");
      expect(report.errors).toEqual([]);
      expect(bindTurnSecrets).not.toHaveBeenCalled();
    });

    it("a bind failure degrades too (the next run's preflight recreates) — deploy stays live", async () => {
      vi.mocked(bindTurnSecrets).mockRejectedValueOnce(
        new Error("[worker] bind secret TURN_KEY_ID → HTTP 500")
      );
      const ctx = createMockCtx({ turnManifest: [TURN_RESOURCE] });
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(report.turn).toBe("degraded");
      expect(report.status).toBe("deployed");
      expect(report.ok).toBe(true);
    });

    it("reports turn: exists when the preflight found the secrets bound (nothing created, no bind)", async () => {
      const ctx = createMockCtx({ turnManifest: [TURN_RESOURCE] });
      // Override the plan: the turn resource already exists (secrets bound — e.g. hand-bound).
      vi.mocked(planInfra).mockImplementationOnce(async (_ctx, manifest) => ({
        account: "test-account",
        accountId: "acct-test",
        exists: manifest.resources
          .filter(resource => resource.kind === "turn")
          .map(resource => ({ resource })),
        missing: manifest.resources.filter(resource => resource.kind !== "turn"),
        ships: []
      }));
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(report.turn).toBe("exists");
      expect(bindTurnSecrets).not.toHaveBeenCalled();
      expect(ctx.emit).toHaveBeenCalledWith("provision:skip", {
        kind: "turn",
        name: "test-turn-test"
      });
    });

    it("never provisions or binds on an aborted deploy (declined gate)", async () => {
      const ctx = createMockCtx({ turnManifest: [TURN_RESOURCE] });
      vi.mocked(createBrandPrompts).mockReturnValueOnce({
        confirm: vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(false),
        select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
      });
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(report.status).toBe("aborted");
      expect(report.turn).toBe("skipped");
      expect(bindTurnSecrets).not.toHaveBeenCalled();
    });
  });

  describe("run — post-deploy", () => {
    it("applies remote D1 migrations after a successful deploy when migration is set", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.run({ migration: true });

      expect(runWrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--remote"]);
      expect(report.migration).toBe("applied");
      expect(report.status).toBe("deployed");
      expect(report.ok).toBe(true);
    });

    it("loads the configured remote seed (execute + KV reset) after a successful deploy", async () => {
      const ctx = createMockCtx({
        seed: { file: "db/seed.sql", resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] }
      });
      const api = createDeployApi(ctx);

      const report = await api.run({ seed: true });

      expect(runWrangler).toHaveBeenCalledWith([
        "d1",
        "execute",
        "DB",
        "--remote",
        "--file",
        "db/seed.sql"
      ]);
      expect(runWrangler).toHaveBeenCalledWith([
        "kv",
        "key",
        "delete",
        "boards:index",
        "--binding",
        "BOARDS_KV",
        "--remote"
      ]);
      expect(report.seed).toBe("applied");
      expect(report.status).toBe("deployed");
    });

    it("skips both (no remote-DB commands) when neither flag is set", async () => {
      const ctx = createMockCtx({ seed: { file: "db/seed.sql" } });
      const api = createDeployApi(ctx);

      const report = await api.run();

      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["migrations"]));
      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["execute"]));
      expect(report.migration).toBe("skipped");
      expect(report.seed).toBe("skipped");
      expect(report.status).toBe("deployed");
    });

    it("NEVER runs migration/seed when the deploy aborts (the first-deploy --seed regression)", async () => {
      // Auth was never set up → the guided recovery scaffolds .env.local and aborts BEFORE the
      // deploy. The whole point of moving these steps inside run(): no remote-DB command may run.
      vi.mocked(verifyAuth).mockRejectedValueOnce(
        new Error("[worker] CLOUDFLARE_API_TOKEN is not set.")
      );
      stubPrompts(vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(true));
      const ctx = createMockCtx({
        seed: { file: "db/seed.sql", resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] }
      });
      const api = createDeployApi(ctx);

      const report = await api.run({ migration: true, seed: true });

      expect(report.status).toBe("aborted");
      expect(report.migration).toBe("skipped");
      expect(report.seed).toBe("skipped");
      expect(runWranglerInherit).not.toHaveBeenCalled();
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("reports a failed seed when seed is requested but none is configured", async () => {
      const ctx = createMockCtx(); // no ctx.config.seed
      const api = createDeployApi(ctx);

      const report = await api.run({ seed: true });

      expect(report.seed).toBe("failed");
      expect(report.status).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toContain("no seed is configured");
      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["execute"]));
    });

    it("skips the seed and reports failure when the remote migration fails", async () => {
      const ctx = createMockCtx({ seed: { file: "db/seed.sql" } });
      // runWrangler #1 is `deploy` (resolve it); #2 is the migration apply — make THAT one fail.
      vi.mocked(runWrangler)
        .mockResolvedValueOnce("https://test.workers.dev")
        .mockRejectedValueOnce(new Error("[worker] wrangler exited with code 1."));
      const api = createDeployApi(ctx);

      const report = await api.run({ migration: true, seed: true });

      expect(report.migration).toBe("failed");
      expect(report.seed).toBe("failed");
      expect(report.status).toBe("failed");
      // The seed execute must NOT run after a failed migration.
      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["execute"]));
    });
  });

  // ───────── destroy (teardown) ───────────────────────────────────────────────

  describe("destroy", () => {
    /** A plan with one existing kv (with id) — the common "something to delete" fixture. */
    const planWithKv = {
      account: "acct",
      accountId: "acct-1",
      exists: [{ resource: { kind: "kv" as const, name: "cache-dev", binding: "KV" }, id: "ns-1" }],
      missing: [],
      ships: []
    };

    it("refuses and destroys nothing off a TTY (interactive-only)", async () => {
      vi.mocked(stdoutIsTty).mockReturnValueOnce(false);
      const ui = makeUi();
      vi.mocked(createBrandConsole).mockReturnValueOnce(asConsole(ui));
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(report.status).toBe("aborted");
      expect(verifyAuth).not.toHaveBeenCalled();
      expect(planInfra).not.toHaveBeenCalled();
      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).not.toHaveBeenCalled();
      expect(ui.error).toHaveBeenCalledWith(expect.stringContaining("interactive-only"));
    });

    it("aborts (destroys nothing) when the token is invalid", async () => {
      vi.mocked(verifyAuth).mockRejectedValueOnce(new Error("[worker] token missing"));
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(report.status).toBe("aborted");
      expect(planInfra).not.toHaveBeenCalled();
      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).not.toHaveBeenCalled();
    });

    it("aborts at the confirm gate when declined — no typed prompt, nothing deleted", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce(planWithKv);
      vi.mocked(createBrandPrompts).mockReturnValueOnce({
        confirm: vi.fn<(question: string) => Promise<boolean>>().mockResolvedValue(false),
        select: vi.fn<(question: string, choices: readonly string[]) => Promise<number>>()
      });
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(report.status).toBe("aborted");
      expect(promptLine).not.toHaveBeenCalled();
      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).not.toHaveBeenCalled();
    });

    it("aborts when the typed stage name does not match — nothing deleted", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce(planWithKv);
      vi.mocked(promptLine).mockResolvedValueOnce("not-the-stage");
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      // confirm defaults to true (gate 1 passes), but the typed gate rejects.
      expect(report.status).toBe("aborted");
      expect(promptLine).toHaveBeenCalledWith(expect.stringContaining('"dev"'));
      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).not.toHaveBeenCalled();
    });

    it("destroys the worker first, then every resource, when the typed name matches", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct-1",
        exists: [
          { resource: { kind: "r2" as const, name: "files-dev", binding: "FILES" } },
          { resource: { kind: "kv" as const, name: "cache-dev", binding: "KV" }, id: "ns-1" }
        ],
        missing: [],
        ships: [{ kind: "do" as const, binding: "ROOM", className: "Room" }]
      });
      vi.mocked(promptLine).mockResolvedValueOnce("dev");
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      // Worker name is stage-qualified: "test-worker" + "dev" → "test-worker-dev".
      expect(deleteWorker).toHaveBeenCalledWith("test-worker-dev");
      expect(destroyResource).toHaveBeenCalledTimes(2);
      expect(report.status).toBe("destroyed");
      expect(report.ok).toBe(true);
      expect(report.stage).toBe("dev");

      // The Worker is deleted before any data store (so its DO storage goes first).
      const workerOrder = vi.mocked(deleteWorker).mock.invocationCallOrder[0] ?? 0;
      const firstResourceOrder = vi.mocked(destroyResource).mock.invocationCallOrder[0] ?? 0;
      expect(workerOrder).toBeLessThan(firstResourceOrder);
    });

    it("detaches the queue consumer before deleting the Worker (breaks the queue↔Worker cycle)", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct-1",
        exists: [{ resource: { kind: "queue" as const, name: "activity-dev", binding: "Q" } }],
        missing: [],
        ships: []
      });
      vi.mocked(promptLine).mockResolvedValueOnce("dev");
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      // The consumer is removed first (`queues consumer remove <queue> <worker>`)…
      expect(runWrangler).toHaveBeenCalledWith([
        "queues",
        "consumer",
        "remove",
        "activity-dev",
        "test-worker-dev"
      ]);
      // …before the Worker delete (which then clears the producer binding)…
      const detachOrder = vi.mocked(runWrangler).mock.invocationCallOrder[0] ?? 0;
      const workerOrder = vi.mocked(deleteWorker).mock.invocationCallOrder[0] ?? 0;
      expect(detachOrder).toBeLessThan(workerOrder);
      // …and the queue itself is still deleted afterwards.
      expect(destroyResource).toHaveBeenCalledTimes(1);
      expect(report.status).toBe("destroyed");
    });

    it("continues past a consumer-detach failure (a queue the Worker doesn't consume)", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct-1",
        exists: [{ resource: { kind: "queue" as const, name: "activity-dev", binding: "Q" } }],
        missing: [],
        ships: []
      });
      vi.mocked(promptLine).mockResolvedValueOnce("dev");
      // The detach is best-effort — a "not a consumer" error must not abort the teardown.
      vi.mocked(runWrangler).mockRejectedValueOnce(new Error("[worker] not a consumer"));
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(deleteWorker).toHaveBeenCalledWith("test-worker-dev");
      expect(destroyResource).toHaveBeenCalledTimes(1);
      expect(report.status).toBe("destroyed");
    });

    it("skips the worker delete when the Worker is not deployed (data stores only)", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce(planWithKv);
      vi.mocked(workerExists).mockResolvedValueOnce(false);
      vi.mocked(promptLine).mockResolvedValueOnce("dev");
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).toHaveBeenCalledTimes(1);
      expect(report.status).toBe("destroyed");
    });

    it("captures a failed resource and still deletes the rest (status failed)", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct-1",
        exists: [
          { resource: { kind: "r2" as const, name: "files-dev", binding: "FILES" } },
          { resource: { kind: "kv" as const, name: "cache-dev", binding: "KV" }, id: "ns-1" }
        ],
        missing: [],
        ships: []
      });
      vi.mocked(workerExists).mockResolvedValueOnce(false);
      vi.mocked(promptLine).mockResolvedValueOnce("dev");
      vi.mocked(destroyResource)
        .mockRejectedValueOnce(
          new Error(
            "[worker] wrangler exited with code 1.\n  The bucket you tried to delete is not empty"
          )
        )
        .mockResolvedValueOnce(undefined);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(destroyResource).toHaveBeenCalledTimes(2); // both attempted despite the first failing
      expect(report.status).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.errors.join(" ")).toContain("not empty");
    });

    it("is a clean no-op (status destroyed) when nothing exists for the stage", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct-1",
        exists: [],
        missing: [],
        ships: []
      });
      vi.mocked(workerExists).mockResolvedValueOnce(false);
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy({ stage: "dev" });

      expect(report.status).toBe("destroyed");
      expect(report.ok).toBe(true);
      expect(createBrandPrompts).not.toHaveBeenCalled(); // no confirm gate
      expect(promptLine).not.toHaveBeenCalled(); // no typed gate
      expect(deleteWorker).not.toHaveBeenCalled();
      expect(destroyResource).not.toHaveBeenCalled();
    });

    it("falls back to ctx.global.stage when no stage is given", async () => {
      vi.mocked(planInfra).mockResolvedValueOnce(planWithKv);
      vi.mocked(workerExists).mockResolvedValueOnce(false);
      vi.mocked(promptLine).mockResolvedValueOnce("test"); // default mock ctx stage is "test"
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      const report = await api.destroy();

      expect(report.stage).toBe("test");
      expect(report.status).toBe("destroyed");
    });
  });

  // ───────── init ────────────────────────────────────────────────────────────

  describe("init", () => {
    it("calls scaffoldWranglerAndCi with configFile and ci=false by default", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.init();

      expect(scaffoldWranglerAndCi).toHaveBeenCalledWith("wrangler.jsonc", false);
    });

    it("passes opts.ci=true to scaffoldWranglerAndCi", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.init({ ci: true });

      expect(scaffoldWranglerAndCi).toHaveBeenCalledWith("wrangler.jsonc", true);
    });

    it("uses ctx.config.ci when opts.ci is not set", async () => {
      const ctx = createMockCtx({ ci: true });
      const api = createDeployApi(ctx);

      await api.init();

      expect(scaffoldWranglerAndCi).toHaveBeenCalledWith("wrangler.jsonc", true);
    });
  });

  // ───────── upload ──────────────────────────────────────────────────────────

  describe("upload", () => {
    it("calls uploadDirToR2 with the stage-suffixed bucket name and upload dir", async () => {
      const ctx = createMockCtx({ has: name => name === "storage" });
      const api = createDeployApi(ctx);

      await api.run();

      // Default mock stage is "test" → the r2 bucket name "assets" is suffixed → "assets-test".
      expect(uploadDirToR2).toHaveBeenCalledWith("assets-test", "./public");
    });
  });

  // ───────── type-level tests ─────────────────────────────────────────────────

  describe("types", () => {
    it("run returns Promise<DeployReport>", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api.run).returns.toEqualTypeOf<Promise<DeployReport>>();
    });

    it("dev returns Promise<void>", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api.dev).returns.toEqualTypeOf<Promise<void>>();
    });

    it("init returns Promise<void>", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api.init).returns.toEqualTypeOf<Promise<void>>();
    });

    it("ctx.emit accepts deploy:phase with correct payload", () => {
      const ctx = createMockCtx();

      ctx.emit("deploy:phase", { phase: "detect" });
      ctx.emit("deploy:phase", { phase: "upload", detail: "3 files" });
      ctx.emit("deploy:complete", { url: "https://x.workers.dev" });
      ctx.emit("provision:resource", { kind: "kv", name: "KV" });

      expect(ctx.emit).toBeDefined();
    });

    it("ctx.emit rejects unknown event names", () => {
      const ctx = createMockCtx();

      // @ts-expect-error -- "unknown:event" is not declared in WorkerEvents
      ctx.emit("unknown:event", {});

      expect(ctx.emit).toBeDefined();
    });

    it("ctx.emit rejects wrong payload for deploy:phase", () => {
      const ctx = createMockCtx();

      // @ts-expect-error -- deploy:phase expects { phase: string }, not { wrong: true }
      ctx.emit("deploy:phase", { wrong: true });

      expect(ctx.emit).toBeDefined();
    });

    it("ResourceManifest is exhaustively narrowable by kind", () => {
      // A function param typed as the full union is NOT narrowed to one variant,
      // so every case stays reachable and each branch's narrowing is type-checked.
      // Each per-instance variant carries `name` + `binding` (DOs carry `binding` + `className`).
      // eslint-disable-next-line unicorn/consistent-function-scoping -- type-only exhaustiveness helper, co-located with its test
      const narrow = (resource: ResourceManifest): void => {
        switch (resource.kind) {
          // The per-instance variants share a `name` + `binding` shape; one fall-through block
          // narrows `resource` to their union and type-checks both common fields.
          case "kv":
          case "r2":
          case "d1":
          case "queue": {
            expectTypeOf(resource.name).toEqualTypeOf<string>();
            expectTypeOf(resource.binding).toEqualTypeOf<string>();
            break;
          }
          case "do": {
            expectTypeOf(resource.binding).toEqualTypeOf<string>();
            expectTypeOf(resource.className).toEqualTypeOf<string>();
            break;
          }
          // No default
        }
      };

      expect(() => narrow({ kind: "kv", name: "cache", binding: "KV" })).not.toThrow();
    });

    it("ctx.require(storagePlugin) exposes deployManifest returning an array of { kind:'r2' }", () => {
      const ctx = createMockCtx();
      const storageApi = ctx.require(storagePlugin);

      // deployManifest() returns one entry PER configured instance → an array.
      expectTypeOf(storageApi.deployManifest).returns.toMatchTypeOf<
        Array<{ kind: "r2"; name: string; binding: string }>
      >();
    });

    it("api surface matches the Api type", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api).toMatchTypeOf<Api>();
    });
  });
});
