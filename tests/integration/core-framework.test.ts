/**
 * @file ROOT integration tests for `@moku-labs/worker` — the REAL framework
 * exercised end-to-end (build Step 5.8).
 *
 * These are framework-level tests, NOT plugin-specific ones: they drive the
 * shipped `createApp` (which already wires the defaults — core log/env/stage +
 * bindings + server) and assert plugin composition, config resolution, the
 * duplicate-name guard, missing-dependency rejection, and lifecycle.
 *
 * The Cloudflare Workers runtime is absent under vitest, so the runtime EDGE
 * (KV/R2/D1/Queue/DO bindings) is substituted with in-memory FAKES passed via
 * the per-request `env`. The framework and its plugins run for real — only the
 * CF binding is doubled (design §1a / SB4: env is threaded, never stored).
 */
import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, it } from "vitest";

import type { WorkerConfig, WorkerEnv, WorkerEvents } from "../../src/config";
import { bindingsPlugin, createApp, createPlugin, kvPlugin, serverPlugin } from "../../src/index";

// ---------------------------------------------------------------------------
// Fakes for the absent Cloudflare runtime edge.
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory KVNamespace stub — only the methods the kv plugin uses.
 * Copied from `src/plugins/kv/__tests__/integration/kv.test.ts` so the root
 * suite stays self-contained.
 *
 * @param initial - Seed key/value pairs for the fake store.
 * @returns A fake KVNamespace exposing get/put/delete/list.
 */
const makeFakeKv = (initial: Record<string, string> = {}) => {
  const store = structuredClone(initial);

  return {
    // eslint-disable-next-line unicorn/no-null
    get: async (key: string): Promise<string | null> => store[key] ?? null,
    put: async (key: string, value: string, _opts?: unknown): Promise<void> => {
      store[key] = value;
    },
    delete: async (key: string): Promise<void> => {
      delete store[key];
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const allKeys = Object.keys(store);
      const filtered = opts?.prefix
        ? allKeys.filter(k => k.startsWith(opts.prefix ?? ""))
        : allKeys;
      const limited = opts?.limit === undefined ? filtered : filtered.slice(0, opts.limit);
      return {
        keys: limited.map(name => ({ name })),
        list_complete: true,
        cursor: ""
      };
    }
  };
};

/**
 * Builds a fake ExecutionContext for driving `server.handle` under vitest.
 *
 * @returns A no-op ExecutionContext stand-in.
 */
const makeExec = (): ExecutionContext =>
  ({
    waitUntil() {},
    passThroughOnException() {}
  }) as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Root integration tests
// ---------------------------------------------------------------------------

describe("core framework (root integration)", () => {
  // ─── Boot + defaults ──────────────────────────────────────────────────────

  describe("boot with defaults", () => {
    it("createApp() (no plugins, no config) boots and exposes app.server", () => {
      const app = createApp();

      // The framework defaults (bindings + server) surface as app.<name>.
      expect(app.server).toBeDefined();
      expect(typeof app.server.handle).toBe("function");
      expect(app.bindings).toBeDefined();
    });

    it("surfaces core plugin apis (log/env/stage) on the app object", () => {
      const app = createApp() as Record<string, unknown>;

      // Core plugins are BOTH flat-injected on every plugin's ctx (ctx.log/env/stage)
      // AND mounted as app.<name> like any other plugin — so app.log/env/stage exist.
      expect(app.log).toBeDefined();
      expect(app.env).toBeDefined();
      expect(app.stage).toBeDefined();
    });
  });

  // ─── Plugin merge: consumer extras mount alongside framework defaults ──────

  describe("plugin merge + resource add", () => {
    it("adding kvPlugin mounts app.kv alongside the default app.server", () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "MY_KV" } }
      });

      // spec/02 §4: registration is [...defaults, ...extras] — both must be present.
      expect(app.kv).toBeDefined();
      expect(app.server).toBeDefined();
    });

    it("the default bindings plugin is still wired when extras are added", () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "MY_KV" } }
      });

      expect(app.bindings).toBeDefined();
    });
  });

  // ─── Per-plugin config override reaches the plugin ────────────────────────

  describe("per-plugin config override", () => {
    it("pluginConfigs.kv.binding resolves the value off the per-request env", async () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "CUSTOM_KV" } }
      });
      const env: WorkerEnv = { CUSTOM_KV: makeFakeKv({ k: "v" }) };

      const result = await app.kv.get(env, "k");

      expect(result).toBe("v");
    });

    it("resolving the overridden binding against an env lacking it throws [moku-worker]", async () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "CUSTOM_KV" } }
      });
      const env: WorkerEnv = {}; // CUSTOM_KV absent

      await expect(app.kv.get(env, "k")).rejects.toThrow("[moku-worker]");
    });

    it("the not-bound error names the overridden binding", async () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "CUSTOM_KV" } }
      });
      const env: WorkerEnv = {};

      await expect(app.kv.get(env, "k")).rejects.toThrow("CUSTOM_KV");
    });
  });

  // ─── Global config override ───────────────────────────────────────────────

  describe("global config override", () => {
    it("createApp({ config: {...} }) boots and the default server still 404s on empty endpoints", async () => {
      const app = createApp({
        config: { stage: "test", name: "cfg", compatibilityDate: "2026-01-01" }
      });

      const res = await app.server.handle(
        new Request("https://example.com/anything"),
        {},
        makeExec()
      );

      expect(res.status).toBe(404);
    });

    it("a plugin api reads the overridden global name via ctx.global", () => {
      // Probe plugin uses contextual typing (no explicit ctx annotation) — the
      // framework's createPlugin infers ctx, and ctx.global is Readonly<WorkerConfig>
      // for a regular plugin. Mirrors the inline `observerPlugin` pattern in
      // src/plugins/queues/__tests__/integration/queues.test.ts.
      const namePlugin = createPlugin("nameProbe", {
        config: {},
        api: ctx => ({
          name: (): string => ctx.global.name
        })
      });

      const app = createApp({
        plugins: [namePlugin],
        config: { stage: "test", name: "cfg", compatibilityDate: "2026-01-01" }
      });

      expect(app.nameProbe.name()).toBe("cfg");
    });
  });

  // ─── Stage bridge: global config.stage drives the stage core plugin ───────
  //
  // `config.stage` is the single stage source. The framework mirrors it into the
  // `stage` core plugin's config so the flat-injected `ctx.stage.*` accessors and
  // the `app.stage.*` mount can never diverge from `ctx.global.stage` (the two
  // otherwise resolve on SEPARATE config cascades — spec/05 §1b).

  describe("stage bridge (config.stage -> ctx.stage / app.stage)", () => {
    // Probe reads BOTH stage paths off one regular plugin's ctx — proving they
    // resolve to the same value (the anti-divergence contract). Contextual typing:
    // ctx.global is Readonly<WorkerConfig>; ctx.stage is the flat-injected core api.
    const stageProbe = createPlugin("stageProbe", {
      config: {},
      api: ctx => ({
        global: (): string => ctx.global.stage,
        plugin: (): string => ctx.stage.current()
      })
    });

    it("ctx.global.stage and ctx.stage.current() agree on an overridden stage", () => {
      const app = createApp({
        plugins: [stageProbe],
        config: { stage: "development", name: "x", compatibilityDate: "" }
      });

      expect(app.stageProbe.global()).toBe("development");
      expect(app.stageProbe.plugin()).toBe("development");
      expect(app.stageProbe.global()).toBe(app.stageProbe.plugin());
    });

    it("app.stage reflects an explicit 'test' stage (isDev + isProduction both false)", () => {
      const app = createApp({
        config: { stage: "test", name: "x", compatibilityDate: "" }
      });

      expect(app.stage.current()).toBe("test");
      expect(app.stage.isDev()).toBe(false);
      expect(app.stage.isProduction()).toBe(false);
    });

    it("both paths default to 'production' when config.stage is omitted", () => {
      const app = createApp({ plugins: [stageProbe] });

      expect(app.stage.current()).toBe("production");
      expect(app.stage.isProduction()).toBe(true);
      expect(app.stageProbe.global()).toBe("production");
      expect(app.stageProbe.plugin()).toBe("production");
    });
  });

  // ─── Duplicate-name guard (spec/11 §Part 1) ───────────────────────────────

  describe("duplicate plugin name", () => {
    it("re-listing the default bindings plugin throws Duplicate plugin name", () => {
      // bindings is already a shipped default — listing it again collides.
      expect(() => createApp({ plugins: [bindingsPlugin] })).toThrow(/Duplicate plugin name/);
    });

    it("listing the same extra plugin twice throws Duplicate plugin name", () => {
      expect(() => createApp({ plugins: [kvPlugin, kvPlugin] })).toThrow(/Duplicate plugin name/);
    });
  });

  // ─── Missing dependency (pattern B — fresh core) ──────────────────────────
  //
  // A fresh core's defaults are ONLY log/env/stage, so bindings/server must be
  // listed explicitly. Omitting bindings leaves server's `depends:[bindingsPlugin]`
  // unresolved — createApp must reject. Mirrors server.test.ts ~lines 57-65.

  describe("missing dependency", () => {
    it("server without bindings (fresh core) throws on unresolved dependency", () => {
      const cc = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
        config: { stage: "test", name: "core-test", compatibilityDate: "" }
      });
      const { createApp: createBare } = cc.createCore(cc, { plugins: [serverPlugin] });

      expect(() => createBare({ pluginConfigs: { server: { endpoints: [] } } })).toThrow();
    });

    it("server WITH bindings (fresh core) does not throw — positive control", () => {
      const cc = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
        config: { stage: "test", name: "core-test", compatibilityDate: "" }
      });
      const { createApp: createWired } = cc.createCore(cc, {
        plugins: [bindingsPlugin, serverPlugin]
      });

      expect(() => createWired({ pluginConfigs: { server: { endpoints: [] } } })).not.toThrow();
    });
  });

  // ─── Lifecycle (stateless worker — spec/06 §3) ────────────────────────────

  describe("lifecycle", () => {
    it("the app is usable immediately after createApp (onInit ran synchronously)", async () => {
      const app = createApp({
        plugins: [kvPlugin],
        pluginConfigs: { kv: { binding: "SESSIONS" } }
      });
      const env: WorkerEnv = { SESSIONS: makeFakeKv({ ready: "yes" }) };

      // No app.start() called — request-scoped plugins must already work.
      const result = await app.kv.get(env, "ready");

      expect(result).toBe("yes");
    });

    it("start() and stop() resolve without throwing", async () => {
      const app = createApp();

      await expect(app.start()).resolves.not.toThrow();
      await expect(app.stop()).resolves.not.toThrow();
    });
  });
});
