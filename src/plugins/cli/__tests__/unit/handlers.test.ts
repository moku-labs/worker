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
    config: { port: 8787, branded: true },
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

  // ─── provision:resource ───────────────────────────────────────────────────

  describe("provision:resource handler", () => {
    it('logs "kv <name>" for a kv resource', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["provision:resource"]({ kind: "kv", name: "KV" });

      expect(logInfo).toHaveBeenCalledWith("kv KV");
    });

    it('logs "r2 <name>" for an r2 resource', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["provision:resource"]({ kind: "r2", name: "ASSETS" });

      expect(logInfo).toHaveBeenCalledWith("r2 ASSETS");
    });

    it('logs "d1 <name>" for a d1 resource', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["provision:resource"]({ kind: "d1", name: "DB" });

      expect(logInfo).toHaveBeenCalledWith("d1 DB");
    });

    it('logs "queue <name>" for a queue resource', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["provision:resource"]({ kind: "queue", name: "orders" });

      expect(logInfo).toHaveBeenCalledWith("queue orders");
    });

    it('logs "do <name>" for a durable object resource', () => {
      const { ctx, logInfo } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      hooks["provision:resource"]({ kind: "do", name: "COUNTER" });

      expect(logInfo).toHaveBeenCalledWith("do COUNTER");
    });

    it("returns void and never throws", () => {
      const { ctx } = makeMockCtx();
      const hooks = createCliHooks(ctx);

      expect(() => hooks["provision:resource"]({ kind: "kv", name: "KV" })).not.toThrow();
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
