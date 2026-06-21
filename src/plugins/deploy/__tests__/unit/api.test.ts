/**
 * Unit tests for createDeployApi — mock ctx, no kernel, wrangler runner stubbed.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { d1Plugin } from "../../../d1";
import { durableObjectsPlugin } from "../../../durable-objects";
import { kvPlugin } from "../../../kv";
import { queuesPlugin } from "../../../queues";
import { storagePlugin } from "../../../storage";
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

vi.mock("../../providers", () => ({
  provisionResource: vi.fn().mockResolvedValue({})
}));

vi.mock("../../providers/r2", () => ({
  uploadDirToR2: vi.fn().mockResolvedValue(3),
  provisionR2: vi.fn().mockResolvedValue(undefined)
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
import { planInfra } from "../../infra/plan";
import { provisionResource } from "../../providers";
import { uploadDirToR2 } from "../../providers/r2";
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

type PluginArg =
  | typeof storagePlugin
  | typeof kvPlugin
  | typeof d1Plugin
  | typeof queuesPlugin
  | typeof durableObjectsPlugin;

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
}): Ctx => {
  const storageApi = makeStorageApi(overrides?.storageUploadDir);
  const kvApi = makeKvApi();
  const d1Api = makeD1Api();
  const queuesApi = makeQueuesApi();
  const doApi = makeDoApi();

  const requireFn = (plugin: PluginArg) => {
    if (plugin === storagePlugin) return storageApi;
    if (plugin === kvPlugin) return kvApi;
    if (plugin === d1Plugin) return d1Api;
    if (plugin === queuesPlugin) return queuesApi;
    if (plugin === durableObjectsPlugin) return doApi;
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
      get: () => undefined,
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
        false
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
        false
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
