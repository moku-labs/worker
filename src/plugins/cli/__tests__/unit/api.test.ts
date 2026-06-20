/**
 * Unit tests for createCliApi — mock ctx, no kernel.
 * Verifies the two thin-passthrough verbs: dev → deploy.dev, deploy → deploy.run.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { deployPlugin } from "../../../deploy";
import type {
  AuthStatus,
  InfraPlan,
  PermissionGroup,
  ProvisionResult,
  TokenRequirement,
  WebBuild
} from "../../../deploy/types";
import type { CliCtx } from "../../api";
import { createCliApi } from "../../api";

// ---------------------------------------------------------------------------
// Stub deploy API — vi.fn() stubs for dev and run
// ---------------------------------------------------------------------------

const makeDeployStub = () => ({
  dev: vi
    .fn<(opts?: { port?: number; webBuild?: WebBuild }) => Promise<void>>()
    .mockResolvedValue(undefined),
  run: vi
    .fn<(opts?: { ci?: boolean; webBuild?: WebBuild }) => Promise<void>>()
    .mockResolvedValue(undefined),
  init: vi.fn<(opts?: { ci?: boolean }) => Promise<void>>().mockResolvedValue(undefined),
  checkInfra: vi
    .fn<() => Promise<InfraPlan>>()
    .mockResolvedValue({ account: "", accountId: "", exists: [], missing: [] }),
  provisionInfra: vi
    .fn<(plan: InfraPlan) => Promise<ProvisionResult>>()
    .mockResolvedValue({ created: [], skipped: [], failed: [], ids: {} }),
  verifyAuth: vi
    .fn<() => Promise<AuthStatus>>()
    .mockResolvedValue({ ok: true, account: "Play Co", accountId: "acc-1", scopes: [] }),
  requiredToken: vi
    .fn<() => TokenRequirement>()
    .mockReturnValue({ base: "Edit Cloudflare Workers", required: [], toAdd: [] }),
  ciToken: vi.fn<() => PermissionGroup[]>().mockReturnValue([]),
  tokenInstructions: vi.fn<() => string>().mockReturnValue("token instructions\nline 2"),
  wrangler: vi.fn<(args: string[]) => Promise<void>>().mockResolvedValue(undefined)
});

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

/**
 * Builds a mock CliCtx for createCliApi testing.
 *
 * @param port - Default port stored in config (default 8787).
 * @returns A mock CliCtx with a require() that returns the deploy stub.
 */
const makeMockCtx = (
  port = 8787
): { ctx: CliCtx; deployStub: ReturnType<typeof makeDeployStub> } => {
  const deployStub = makeDeployStub();
  const ctx: CliCtx = {
    config: { port },
    state: {} as Record<string, never>,
    emit: vi.fn() as CliCtx["emit"],
    require: (_plugin: typeof deployPlugin) => deployStub
  };
  return { ctx, deployStub };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCliApi", () => {
  // ─── dev ──────────────────────────────────────────────────────────────────

  describe("dev", () => {
    it("calls require(deployPlugin).dev({ port: <default> }) when no opts are supplied", async () => {
      const { ctx, deployStub } = makeMockCtx(8787);
      const api = createCliApi(ctx);

      await api.dev();

      expect(deployStub.dev).toHaveBeenCalledOnce();
      expect(deployStub.dev).toHaveBeenCalledWith({ port: 8787 });
    });

    it("forwards { port: 3000 } unchanged when caller passes an explicit port", async () => {
      const { ctx, deployStub } = makeMockCtx(8787);
      const api = createCliApi(ctx);

      await api.dev({ port: 3000 });

      expect(deployStub.dev).toHaveBeenCalledWith({ port: 3000 });
    });

    it("respects a non-default configured port (9000) when dev() has no opts", async () => {
      const { ctx, deployStub } = makeMockCtx(9000);
      const api = createCliApi(ctx);

      await api.dev();

      expect(deployStub.dev).toHaveBeenCalledWith({ port: 9000 });
    });

    it("forwards a webBuild hook alongside the default port", async () => {
      const { ctx, deployStub } = makeMockCtx(8787);
      const api = createCliApi(ctx);
      const webBuild = vi.fn<WebBuild>().mockResolvedValue({ files: 4 });

      await api.dev({ webBuild });

      expect(deployStub.dev).toHaveBeenCalledWith({ port: 8787, webBuild });
    });

    it("forwards a webBuild hook alongside an explicit port", async () => {
      const { ctx, deployStub } = makeMockCtx(8787);
      const api = createCliApi(ctx);
      const webBuild = vi.fn<WebBuild>().mockResolvedValue({ files: 4 });

      await api.dev({ port: 3000, webBuild });

      expect(deployStub.dev).toHaveBeenCalledWith({ port: 3000, webBuild });
    });

    it("resolves to undefined on the happy path", async () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      await expect(api.dev()).resolves.toBeUndefined();
    });

    it("renders a branded error + sets a non-zero exit code when deploy.dev throws", async () => {
      const { ctx, deployStub } = makeMockCtx();
      deployStub.dev.mockRejectedValueOnce(new Error("boom"));
      const api = createCliApi(ctx);
      const originalExit = process.exitCode;

      await expect(api.dev()).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);

      process.exitCode = originalExit;
    });
  });

  // ─── deploy ───────────────────────────────────────────────────────────────

  describe("deploy", () => {
    it("calls require(deployPlugin).run({ ci: true }) verbatim", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy({ ci: true });

      expect(deployStub.run).toHaveBeenCalledWith({ ci: true });
    });

    it("calls run({}) when no opts are passed (guided default; opts spread, no --stage)", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy();

      // deploy() forwards `{ ...opts, ...(stage ? { stage } : {}) }`; with no opts and no --stage
      // in argv that collapses to an empty object (not `undefined`).
      expect(deployStub.run).toHaveBeenCalledWith({});
    });

    it("forwards { ci: false } verbatim to run", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy({ ci: false });

      expect(deployStub.run).toHaveBeenCalledWith({ ci: false });
    });

    it("forwards a webBuild hook verbatim to run", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);
      const webBuild = vi.fn<WebBuild>().mockResolvedValue({ files: 4 });

      await api.deploy({ ci: true, webBuild });

      expect(deployStub.run).toHaveBeenCalledWith({ ci: true, webBuild });
    });

    it("renders a branded error + sets a non-zero exit code when run() throws (no rethrow)", async () => {
      const { ctx, deployStub } = makeMockCtx();
      deployStub.run.mockRejectedValueOnce(new Error("CLOUDFLARE_API_TOKEN is not set"));
      const api = createCliApi(ctx);
      const originalExit = process.exitCode;

      await expect(api.deploy({ ci: true })).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);

      process.exitCode = originalExit;
    });

    it("resolves to undefined on the happy path", async () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      await expect(api.deploy({ ci: true })).resolves.toBeUndefined();
    });
  });

  // ─── auth ─────────────────────────────────────────────────────────────────

  describe("auth", () => {
    it("auth('setup') renders the branded token guidance (LOCAL + CI) without verifying", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.auth("setup");

      expect(deployStub.requiredToken).toHaveBeenCalled();
      expect(deployStub.ciToken).toHaveBeenCalled();
      expect(deployStub.verifyAuth).not.toHaveBeenCalled();
    });

    it("auth() verifies via deploy.verifyAuth()", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.auth();

      expect(deployStub.verifyAuth).toHaveBeenCalledOnce();
    });

    it("auth() handles a verify failure without throwing", async () => {
      const { ctx, deployStub } = makeMockCtx();
      deployStub.verifyAuth.mockRejectedValueOnce(new Error("bad token"));
      const api = createCliApi(ctx);

      await expect(api.auth()).resolves.toBeUndefined();
    });
  });

  // ─── doctor ───────────────────────────────────────────────────────────────

  describe("doctor", () => {
    it("runs verifyAuth then checkInfra", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.doctor();

      expect(deployStub.verifyAuth).toHaveBeenCalledOnce();
      expect(deployStub.checkInfra).toHaveBeenCalledOnce();
    });

    it("stops after a failed token check (does not call checkInfra)", async () => {
      const { ctx, deployStub } = makeMockCtx();
      deployStub.verifyAuth.mockRejectedValueOnce(new Error("no token"));
      const api = createCliApi(ctx);

      await api.doctor();

      expect(deployStub.checkInfra).not.toHaveBeenCalled();
    });
  });

  // ─── whoami ─────────────────────────────────────────────────────────────────

  describe("whoami", () => {
    it("verifies via deploy.verifyAuth()", async () => {
      const { ctx, deployStub } = makeMockCtx();

      await createCliApi(ctx).whoami();

      expect(deployStub.verifyAuth).toHaveBeenCalledOnce();
    });

    it("handles a verify failure without throwing", async () => {
      const { ctx, deployStub } = makeMockCtx();
      deployStub.verifyAuth.mockRejectedValueOnce(new Error("no token"));

      await expect(createCliApi(ctx).whoami()).resolves.toBeUndefined();
    });
  });

  // ─── wrangler passthrough ─────────────────────────────────────────────────

  describe("wrangler", () => {
    it("forwards all args to deploy.wrangler", async () => {
      const { ctx, deployStub } = makeMockCtx();

      await createCliApi(ctx).wrangler(["kv", "namespace", "list"]);

      expect(deployStub.wrangler).toHaveBeenCalledWith(["kv", "namespace", "list"]);
    });
  });

  // ─── type-level tests ─────────────────────────────────────────────────────

  describe("types", () => {
    it("dev is a function", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      expectTypeOf(api.dev).toBeFunction();
    });

    it("dev returns Promise<void>", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      expectTypeOf(api.dev()).toEqualTypeOf<Promise<void>>();
    });

    it("deploy is a function", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      expectTypeOf(api.deploy).toBeFunction();
    });

    it("deploy returns Promise<void>", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      expectTypeOf(api.deploy()).toEqualTypeOf<Promise<void>>();
    });

    it("@ts-expect-error: dev rejects port: string", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      const badCall = (): Promise<void> =>
        // @ts-expect-error -- port must be number, not string
        api.dev({ port: "3000" });

      expect(typeof badCall).toBe("function");
    });

    it("@ts-expect-error: deploy rejects ci: number", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      const badCall = (): Promise<void> =>
        // @ts-expect-error -- ci must be boolean, not number
        api.deploy({ ci: 1 });

      expect(typeof badCall).toBe("function");
    });
  });
});
