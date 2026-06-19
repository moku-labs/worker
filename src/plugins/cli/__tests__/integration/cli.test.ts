/**
 * Integration test: cli plugin with createApp (full kernel wiring, wrangler stubbed).
 * Mirrors the deploy integration harness — compose the full dependency chain,
 * drive app.cli.deploy(), and assert cli hooks logged via ctx.log.
 * No app.start()/app.stop() — cli is stateless.
 */

import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { WorkerConfig, WorkerEvents } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { d1Plugin } from "../../../d1";
import { deployPlugin } from "../../../deploy";
import { durableObjectsPlugin } from "../../../durable-objects";
import { kvPlugin } from "../../../kv";
import { queuesPlugin } from "../../../queues";
import { stagePlugin } from "../../../stage";
import { storagePlugin } from "../../../storage";
import { cliPlugin } from "../../index";
import type { Api } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// Module stubs — hoisted by vitest so imports see the mocked modules
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../../deploy/runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("https://cli-test.workers.dev")
}));

vi.mock("../../../deploy/wrangler-config", () => ({
  writeWranglerConfig: vi.fn().mockResolvedValue(undefined),
  scaffoldWranglerAndCi: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../../deploy/providers", () => ({
  provisionResource: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../../../deploy/providers/r2", () => ({
  uploadDirToR2: vi.fn().mockResolvedValue(2),
  provisionR2: vi.fn().mockResolvedValue(undefined)
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test-local coreConfig — isolates from sibling plugins
// ─────────────────────────────────────────────────────────────────────────────

const testCoreConfig = createCoreConfig<
  WorkerConfig,
  WorkerEvents,
  [typeof logPlugin, typeof envPlugin, typeof stagePlugin]
>("moku-worker", {
  config: {
    stage: "test",
    name: "cli-test-worker",
    compatibilityDate: "2026-06-17"
  },
  plugins: [logPlugin, envPlugin, stagePlugin],
  pluginConfigs: { log: { mode: "test" } }
});

/**
 * Build a minimal createApp with the full dependency chain for cli:
 * bindingsPlugin → storage/kv/d1/queues/durableObjects → deployPlugin → cliPlugin.
 *
 * Every `depends` target must be registered earlier in the array (spec/11 §1.3).
 */
const createTestApp = () => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [
      bindingsPlugin,
      storagePlugin,
      kvPlugin,
      d1Plugin,
      queuesPlugin,
      durableObjectsPlugin,
      deployPlugin,
      cliPlugin
    ]
  });
  return createApp({
    pluginConfigs: {
      storage: { bucket: "ASSETS", upload: "./public" },
      kv: { binding: "KV" },
      d1: { binding: "DB", migrations: "./migrations" },
      queues: { producers: ["orders"], onMessage: async () => undefined },
      durableObjects: { bindings: { counter: "COUNTER" } },
      cli: { port: 8787 }
    }
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// The deploy TUI is ALWAYS branded. Capture its console output so a test can assert the
// branded lines end-to-end — and the rest of the suite stays quiet (captured, not printed).
// The brand rendering itself (›/⚠/✗) is unit-tested in @moku-labs/common (brandedSink).
let consoleOut: string[] = [];
let consoleSpies: { mockRestore: () => void }[] = [];
beforeEach(() => {
  consoleOut = [];
  consoleSpies = (["log", "warn", "error"] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOut.push(args.map(String).join(" "));
    })
  );
});
afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("cli plugin (integration)", () => {
  // ─── wiring ────────────────────────────────────────────────────────────────

  describe("wiring", () => {
    it("mounts app.cli after createApp", () => {
      const app = createTestApp();

      expect(app.cli).toBeDefined();
    });

    it("mounts app.cli.dev and app.cli.deploy as functions", () => {
      const app = createTestApp();

      expect(typeof app.cli.dev).toBe("function");
      expect(typeof app.cli.deploy).toBe("function");
    });

    it("throws when deployPlugin is absent from the plugins array", () => {
      const { createApp } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [
          bindingsPlugin,
          storagePlugin,
          kvPlugin,
          d1Plugin,
          queuesPlugin,
          durableObjectsPlugin,
          cliPlugin
        ]
      });

      expect(() => createApp()).toThrow();
    });
  });

  // ─── hook integration: emit → cli logs ─────────────────────────────────────

  describe("hook integration — deploy events drive cli log output", () => {
    it("renders the deploy TUI as branded › lines on the console (always branded)", async () => {
      const app = createTestApp();

      await app.cli.deploy();

      // onInit installed brandedSink (always) — events render through the brand vocabulary,
      // not the default object-dump sink. (Plain mode off a TTY: the › glyph, no ANSI.)
      const out = consoleOut.join("\n");
      expect(out).toContain("› detect");
      expect(out).toContain("› kv KV");
      expect(out).toContain("› deployed → https://cli-test.workers.dev");
    });

    it("cli hooks log detect when deploy:phase(detect) is emitted", async () => {
      const app = createTestApp();

      // Spy on log entries — log is a core plugin, entries accumulated in trace
      const traceBeforeLen = app.log.trace().length;

      await app.cli.deploy();

      const entries = app.log.trace();
      const newEntries = entries.slice(traceBeforeLen);
      const events = newEntries.map(e => e.event);

      expect(events).toContain("detect");
    });

    it("cli hooks log provision when deploy:phase(provision) is emitted", async () => {
      const app = createTestApp();

      const traceBeforeLen = app.log.trace().length;

      await app.cli.deploy();

      const events = app.log
        .trace()
        .slice(traceBeforeLen)
        .map(e => e.event);
      expect(events).toContain("provision");
    });

    it("cli hooks log deployed → <url> when deploy:complete is emitted", async () => {
      const app = createTestApp();

      const traceBeforeLen = app.log.trace().length;

      await app.cli.deploy();

      const events = app.log
        .trace()
        .slice(traceBeforeLen)
        .map(e => e.event);
      expect(events).toContain("deployed → https://cli-test.workers.dev");
    });

    it("cli hooks log kv KV when provision:resource(kv, KV) is emitted", async () => {
      const app = createTestApp();

      const traceBeforeLen = app.log.trace().length;

      await app.cli.deploy();

      const events = app.log
        .trace()
        .slice(traceBeforeLen)
        .map(e => e.event);
      expect(events).toContain("kv KV");
    });

    it("cli hooks log r2 ASSETS when provision:resource(r2, ASSETS) is emitted", async () => {
      const app = createTestApp();

      const traceBeforeLen = app.log.trace().length;

      await app.cli.deploy();

      const events = app.log
        .trace()
        .slice(traceBeforeLen)
        .map(e => e.event);
      expect(events).toContain("r2 ASSETS");
    });
  });

  // ─── app.cli.dev passthrough ───────────────────────────────────────────────

  describe("app.cli.dev", () => {
    it("resolves without throwing when called with default port", async () => {
      const app = createTestApp();

      await expect(app.cli.dev()).resolves.toBeUndefined();
    });

    it("resolves without throwing when called with an explicit port", async () => {
      const app = createTestApp();

      await expect(app.cli.dev({ port: 3000 })).resolves.toBeUndefined();
    });
  });

  // ─── type-level tests ──────────────────────────────────────────────────────

  describe("types", () => {
    it("app.cli surface matches the Api type", () => {
      const app = createTestApp();

      expectTypeOf(app.cli).toMatchTypeOf<Api>();
    });

    it("app.cli.dev is a function", () => {
      const app = createTestApp();

      expectTypeOf(app.cli.dev).toBeFunction();
    });

    it("app.cli.dev returns Promise<void>", () => {
      const app = createTestApp();

      expectTypeOf(app.cli.dev()).toEqualTypeOf<Promise<void>>();
    });

    it("app.cli.deploy returns Promise<void>", () => {
      const app = createTestApp();

      expectTypeOf(app.cli.deploy()).toEqualTypeOf<Promise<void>>();
    });

    it("@ts-expect-error: dev rejects port as string", () => {
      const app = createTestApp();

      const badCall = (): Promise<void> =>
        // @ts-expect-error -- port must be number
        app.cli.dev({ port: "3000" });

      expect(typeof badCall).toBe("function");
    });

    it("@ts-expect-error: deploy rejects guided as number", () => {
      const app = createTestApp();

      const badCall = (): Promise<void> =>
        // @ts-expect-error -- guided must be boolean, not number
        app.cli.deploy({ guided: 1 });

      expect(typeof badCall).toBe("function");
    });

    it("cliPlugin.name is the literal type 'cli'", () => {
      expectTypeOf(cliPlugin.name).toEqualTypeOf<"cli">();
    });
  });
});
