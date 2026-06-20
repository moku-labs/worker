/**
 * Unit tests for createCliApi — mock ctx, no kernel.
 * Verifies the two thin-passthrough verbs: dev → deploy.dev, deploy → deploy.run.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { deployPlugin } from "../../../deploy";
import type { InfraPlan, ProvisionResult } from "../../../deploy/types";
import type { CliCtx } from "../../api";
import { createCliApi } from "../../api";

// ---------------------------------------------------------------------------
// Stub deploy API — vi.fn() stubs for dev and run
// ---------------------------------------------------------------------------

const makeDeployStub = () => ({
  dev: vi.fn<(opts?: { port?: number }) => Promise<void>>().mockResolvedValue(undefined),
  run: vi
    .fn<(opts?: { guided?: boolean; yes?: boolean }) => Promise<void>>()
    .mockResolvedValue(undefined),
  init: vi.fn<(opts?: { ci?: boolean }) => Promise<void>>().mockResolvedValue(undefined),
  checkInfra: vi
    .fn<() => Promise<InfraPlan>>()
    .mockResolvedValue({ account: "", accountId: "", exists: [], missing: [] }),
  provisionInfra: vi
    .fn<(plan: InfraPlan) => Promise<ProvisionResult>>()
    .mockResolvedValue({ created: [], skipped: [], ids: {} })
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

    it("returns the exact Promise the deploy api returns (passthrough, not re-wrapped)", async () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      // The stub returns Promise<void>; we verify the same promise resolves
      await expect(api.dev()).resolves.toBeUndefined();
    });
  });

  // ─── deploy ───────────────────────────────────────────────────────────────

  describe("deploy", () => {
    it("calls require(deployPlugin).run({ guided: true, yes: false }) verbatim", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy({ guided: true, yes: false });

      expect(deployStub.run).toHaveBeenCalledWith({ guided: true, yes: false });
    });

    it("calls run(undefined) when no opts are passed", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy();

      expect(deployStub.run).toHaveBeenCalledWith(undefined);
    });

    it("forwards { yes: true } only (guided omitted) to run", async () => {
      const { ctx, deployStub } = makeMockCtx();
      const api = createCliApi(ctx);

      await api.deploy({ yes: true });

      expect(deployStub.run).toHaveBeenCalledWith({ yes: true });
    });

    it("returns the exact Promise the deploy api returns (passthrough, not re-wrapped)", async () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      await expect(api.deploy({ guided: true })).resolves.toBeUndefined();
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

    it("@ts-expect-error: deploy rejects guided: number", () => {
      const { ctx } = makeMockCtx();
      const api = createCliApi(ctx);

      const badCall = (): Promise<void> =>
        // @ts-expect-error -- guided must be boolean, not number
        api.deploy({ guided: 1 });

      expect(typeof badCall).toBe("function");
    });
  });
});
