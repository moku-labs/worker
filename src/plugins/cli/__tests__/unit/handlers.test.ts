/**
 * Unit tests for createCliHooks — mock ctx with a spied log, no kernel.
 * Verifies the three TUI formatter handlers log clean (prefix-free) lines via ctx.log.info;
 * the branded log sink (installed by the plugin onInit) is what adds the `›` marker.
 */
import { describe, expect, it, vi } from "vitest";
import type { CliCtx } from "../../handlers";
import { createCliHooks } from "../../handlers";

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

/**
 * Builds a mock CliCtx for createCliHooks testing.
 * ctx.log.info is a vi.fn() spy so we can assert calls.
 *
 * @returns Mock CliCtx and the log.info spy.
 */
const makeMockCtx = (): { ctx: CliCtx; logInfo: ReturnType<typeof vi.fn> } => {
  const logInfo = vi.fn<(event: string, data?: unknown) => void>();
  const ctx: CliCtx = {
    config: {},
    state: {} as Record<string, never>,
    emit: vi.fn() as CliCtx["emit"],
    log: {
      info: logInfo,
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      expect: vi.fn(),
      addSink: vi.fn(),
      clearSinks: vi.fn(),
      reset: vi.fn()
    }
  };
  return { ctx, logInfo };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCliHooks", () => {
  // ─── deploy:phase ──────────────────────────────────────────────────────────

  describe("deploy:phase handler", () => {
    it('logs "<phase>" when no detail is present', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["deploy:phase"]({ phase: "detect" });

      expect(logInfo).toHaveBeenCalledOnce();
      expect(logInfo).toHaveBeenCalledWith("detect");
    });

    it('logs "<phase> · <detail>" when detail is provided', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["deploy:phase"]({ phase: "upload", detail: "3 files" });

      expect(logInfo).toHaveBeenCalledWith("upload · 3 files");
    });

    it("works for each pipeline phase name (provision, wrangler-config, deploy)", () => {
      const phases = ["detect", "provision", "wrangler-config", "upload", "deploy"];

      for (const phase of phases) {
        const { ctx, logInfo } = makeMockCtx();
        const hooks = createCliHooks(ctx);

        hooks["deploy:phase"]({ phase });

        expect(logInfo).toHaveBeenCalledWith(phase);
      }
    });

    it("returns void and never throws", () => {
      const { ctx } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      expect(() => hooks["deploy:phase"]({ phase: "detect" })).not.toThrow();
    });
  });

  // Note: the infra plan + per-resource provision result are rendered as branded panels by the
  // deploy plugin (see deploy/infra/render.ts), so the cli no longer registers provision:plan /
  // provision:resource / provision:skip hooks — those are covered by deploy's render tests.

  // ─── dev:phase ──────────────────────────────────────────────────────────────

  describe("dev:phase handler", () => {
    it('logs "<phase> · <detail>"', () => {
      const { ctx, logInfo } = makeMockCtx();

      createCliHooks(ctx)["dev:phase"]({ phase: "serve", detail: "http://localhost:8787" });

      expect(logInfo).toHaveBeenCalledWith("serve · http://localhost:8787");
    });

    it('logs "<phase>" with no detail', () => {
      const { ctx, logInfo } = makeMockCtx();

      createCliHooks(ctx)["dev:phase"]({ phase: "build" });

      expect(logInfo).toHaveBeenCalledWith("build");
    });
  });

  // ─── dev:rebuilt ──────────────────────────────────────────────────────────

  describe("dev:rebuilt handler", () => {
    it("logs the file count when known", () => {
      const { ctx, logInfo } = makeMockCtx();

      createCliHooks(ctx)["dev:rebuilt"]({ files: 12, ms: 240 });

      expect(logInfo).toHaveBeenCalledWith("site 12 files · 240ms");
    });

    it("omits the count when 0 (shell build path)", () => {
      const { ctx, logInfo } = makeMockCtx();

      createCliHooks(ctx)["dev:rebuilt"]({ files: 0, ms: 240 });

      expect(logInfo).toHaveBeenCalledWith("site · 240ms");
    });
  });

  // ─── dev:error ────────────────────────────────────────────────────────────

  describe("dev:error handler", () => {
    it("warns the message (non-fatal; the session keeps serving)", () => {
      const { ctx } = makeMockCtx();

      createCliHooks(ctx)["dev:error"]({ message: "boom" });

      expect(ctx.log.warn).toHaveBeenCalledWith("boom");
    });
  });

  // ─── deploy:complete ──────────────────────────────────────────────────────

  describe("deploy:complete handler", () => {
    it('logs "deployed → <url>" with the deployed URL', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["deploy:complete"]({ url: "https://my-worker.workers.dev" });

      expect(logInfo).toHaveBeenCalledWith("deployed → https://my-worker.workers.dev");
    });

    it("returns void and never throws", () => {
      const { ctx } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      expect(() => hooks["deploy:complete"]({ url: "https://x.workers.dev" })).not.toThrow();
    });
  });
});
