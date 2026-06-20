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
import type { Api, Ctx, ExternalManifest, ResourceManifest } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Vitest module stubs — must be at top level (hoisted by vitest)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("https://test.workers.dev")
}));

vi.mock("../../wrangler-config", () => ({
  writeWranglerConfig: vi.fn().mockResolvedValue(undefined),
  scaffoldWranglerAndCi: vi.fn().mockResolvedValue(undefined)
}));

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
    missing: manifest.resources
  }))
}));

vi.mock("../../auth/verify", () => ({
  // Network-bound; mocked. requiredToken/tokenInstructions are pure and run for real.
  verifyAuth: vi
    .fn()
    .mockResolvedValue({ ok: true, account: "Play Co", accountId: "acc-1", scopes: [] })
}));

// TTY defaults to interactive so the guided path is exercisable; overridden per test.
vi.mock("../../tty", () => ({ stdoutIsTty: vi.fn(() => true) }));

// Branded prompts mocked — confirm defaults to "yes"; overridden per guided test.
vi.mock("@moku-labs/common/cli", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createBrandPrompts: vi.fn(() => ({
      confirm: vi.fn().mockResolvedValue(true),
      select: vi.fn()
    }))
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Imports after mocking
// ─────────────────────────────────────────────────────────────────────────────

import { createBrandPrompts } from "@moku-labs/common/cli";
import { beforeEach } from "vitest";
import { verifyAuth } from "../../auth/verify";
import { planInfra } from "../../infra/plan";
import { provisionResource } from "../../providers";
import { uploadDirToR2 } from "../../providers/r2";
import { runWrangler } from "../../runner";
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
    .mockReturnValue({ kind: "r2" as const, bucket: "ASSETS", upload: uploadDir })
});

const makeKvApi = () => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  deployManifest: vi.fn().mockReturnValue({ kind: "kv" as const, binding: "KV" })
});

const makeD1Api = () => ({
  query: vi.fn(),
  first: vi.fn(),
  run: vi.fn(),
  batch: vi.fn(),
  prepare: vi.fn(),
  deployManifest: vi
    .fn()
    .mockReturnValue({ kind: "d1" as const, binding: "DB", migrations: "./migrations" })
});

const makeQueuesApi = () => ({
  send: vi.fn(),
  sendBatch: vi.fn(),
  consume: vi.fn(),
  deployManifest: vi.fn().mockReturnValue({ kind: "queue" as const, producers: ["orders"] })
});

const makeDoApi = () => ({
  get: vi.fn(),
  deployManifest: vi.fn().mockReturnValue({ kind: "do" as const, bindings: { counter: "COUNTER" } })
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
      ci: overrides?.ci ?? false
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createDeployApi", () => {
  // ───────── run — manifest assembly ─────────────────────────────────────────

  describe("run — manifest assembly", () => {
    it("assembles manifest from each plugin's deployManifest() when has() returns true", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(writeWranglerConfig).toHaveBeenCalled();
      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      expect(manifest.resources).toContainEqual({ kind: "kv", binding: "KV" });
      expect(manifest.resources).toContainEqual(
        expect.objectContaining({ kind: "r2", bucket: "ASSETS" })
      );
      expect(manifest.resources).toContainEqual({
        kind: "d1",
        binding: "DB",
        migrations: "./migrations"
      });
      expect(manifest.resources).toContainEqual({ kind: "queue", producers: ["orders"] });
      expect(manifest.resources).toContainEqual({ kind: "do", bindings: { counter: "COUNTER" } });
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
        resources: [{ kind: "kv", binding: "CACHE" }]
      };

      await api.run({ manifest: callerManifest });

      const [[, manifest]] = (writeWranglerConfig as ReturnType<typeof vi.fn>).mock.calls as [
        [string, ExternalManifest]
      ];
      expect(manifest.name).toBe("legacy-worker");
      expect(manifest.resources).toEqual([{ kind: "kv", binding: "CACHE" }]);
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

    it("emits deploy:phase in full order detect → provision → wrangler-config → upload → deploy", async () => {
      const ctx = createMockCtx(); // all resources present; storage has an upload dir
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

    it("emits provision:resource with correct kind and name for kv", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      const api = createDeployApi(ctx);

      await api.run();

      expect(ctx.emit).toHaveBeenCalledWith("provision:resource", { kind: "kv", name: "KV" });
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

      expect(provisionResource).toHaveBeenCalledWith({ kind: "kv", binding: "KV" }, false);
    });

    it("calls writeWranglerConfig with the configFile from ctx.config", async () => {
      const ctx = createMockCtx({ configFile: "my-wrangler.jsonc", has: () => false });
      const api = createDeployApi(ctx);

      await api.run();

      expect(writeWranglerConfig).toHaveBeenCalledWith(
        "my-wrangler.jsonc",
        expect.any(Object),
        expect.any(Object)
      );
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

  // ───────── infra preflight (check-before-create) ────────────────────────────

  describe("infra preflight", () => {
    it("skips a resource that already exists and reuses its captured id", async () => {
      const ctx = createMockCtx({ has: name => name === "kv" });
      vi.mocked(planInfra).mockResolvedValueOnce({
        account: "acct",
        accountId: "acct",
        exists: [{ resource: { kind: "kv", binding: "KV" }, id: "ns-existing" }],
        missing: []
      });
      const api = createDeployApi(ctx);

      await api.run();

      expect(provisionResource).not.toHaveBeenCalled();
      expect(ctx.emit).toHaveBeenCalledWith("provision:skip", { kind: "kv", name: "KV" });
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
        missing: [{ kind: "kv", binding: "KV" }]
      });

      expect(provisionResource).toHaveBeenCalledWith({ kind: "kv", binding: "KV" }, false);
      expect(result.created).toEqual([{ resource: { kind: "kv", binding: "KV" } }]);
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

  // ───────── guided prompts ───────────────────────────────────────────────────

  describe("guided prompts", () => {
    it("verifies the token before deploying (auth fail-fast)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(verifyAuth).toHaveBeenCalledWith(ctx);
    });

    it("does NOT prompt when not guided (createBrandPrompts unused)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run();

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("prompts and deploys when guided + confirmed", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run({ guided: true });

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

      await api.run({ guided: true });

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

      await api.run({ guided: true });

      expect(provisionResource).toHaveBeenCalled(); // infra confirmed → provisioned
      expect(runWrangler).not.toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("does NOT prompt when guided but --yes (yes overrides guided)", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.run({ guided: true, yes: true });

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });

    it("does NOT prompt in ci mode even when guided", async () => {
      const ctx = createMockCtx({ ci: true });
      const api = createDeployApi(ctx);

      await api.run({ guided: true });

      expect(createBrandPrompts).not.toHaveBeenCalled();
      expect(runWrangler).toHaveBeenCalledWith(["deploy", "--config", "wrangler.jsonc"]);
    });
  });

  // ───────── dev ─────────────────────────────────────────────────────────────

  describe("dev", () => {
    it("calls runWrangler with dev args and default port 8787", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.dev();

      expect(runWrangler).toHaveBeenCalledWith([
        "dev",
        "--port",
        "8787",
        "--config",
        "wrangler.jsonc"
      ]);
    });

    it("passes the supplied port to wrangler dev", async () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      await api.dev({ port: 9000 });

      expect(runWrangler).toHaveBeenCalledWith([
        "dev",
        "--port",
        "9000",
        "--config",
        "wrangler.jsonc"
      ]);
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
    it("calls uploadDirToR2 with bucket name and upload dir", async () => {
      const ctx = createMockCtx({ has: name => name === "storage" });
      const api = createDeployApi(ctx);

      await api.run();

      expect(uploadDirToR2).toHaveBeenCalledWith("ASSETS", "./public");
    });
  });

  // ───────── type-level tests ─────────────────────────────────────────────────

  describe("types", () => {
    it("run returns Promise<void>", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api.run).returns.toEqualTypeOf<Promise<void>>();
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
      // eslint-disable-next-line unicorn/consistent-function-scoping -- type-only exhaustiveness helper, co-located with its test
      const narrow = (resource: ResourceManifest): void => {
        switch (resource.kind) {
          case "kv": {
            expectTypeOf(resource.binding).toEqualTypeOf<string>();
            break;
          }
          case "r2": {
            expectTypeOf(resource.bucket).toEqualTypeOf<string>();
            break;
          }
          case "d1": {
            expectTypeOf(resource.binding).toEqualTypeOf<string>();
            break;
          }
          case "queue": {
            expectTypeOf(resource.producers).toEqualTypeOf<string[]>();
            break;
          }
          case "do": {
            expectTypeOf(resource.bindings).toEqualTypeOf<Record<string, string>>();
            break;
          }
          // No default
        }
      };

      expect(() => narrow({ kind: "kv", binding: "KV" })).not.toThrow();
    });

    it("ctx.require(storagePlugin) exposes deployManifest returning { kind:'r2' }", () => {
      const ctx = createMockCtx();
      const storageApi = ctx.require(storagePlugin);

      expectTypeOf(storageApi.deployManifest).returns.toMatchTypeOf<{
        kind: "r2";
        bucket: string;
      }>();
    });

    it("api surface matches the Api type", () => {
      const ctx = createMockCtx();
      const api = createDeployApi(ctx);

      expectTypeOf(api).toMatchTypeOf<Api>();
    });
  });
});
