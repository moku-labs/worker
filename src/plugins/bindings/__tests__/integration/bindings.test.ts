/**
 * Integration tests for the bindings plugin — full createApp wiring, end-to-end
 * API behavior, and a depends:[bindingsPlugin] consumer that calls ctx.require(bindingsPlugin).
 *
 * Uses a test-local coreConfig (no core plugins) so this test runs independently of
 * Wave 0 siblings (log/env) that may still be stubs when bindings is built.
 */
import { createCoreConfig } from "@moku-labs/core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkerConfig, WorkerEvents } from "../../../../config";
import { bindingsPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Test-local coreConfig — isolates from Wave-0 sibling stubs (log, env).
// Omitting core plugins is valid: createCoreConfig plugins?: [...] is optional.
// ---------------------------------------------------------------------------

const testCoreConfig = createCoreConfig<WorkerConfig, WorkerEvents>("moku-worker", {
  config: {
    stage: "test",
    name: "bindings-test",
    compatibilityDate: ""
  }
});

// ---------------------------------------------------------------------------
// Test factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal test app that includes only the bindings plugin.
 *
 * @param requiredBindings - Binding names to assert via config.required.
 * @returns A created app instance.
 */
const createTestApp = (requiredBindings: string[] = []) => {
  const { createApp } = testCoreConfig.createCore(testCoreConfig, {
    plugins: [bindingsPlugin]
  });

  return createApp({
    pluginConfigs: {
      bindings: { required: requiredBindings }
    }
  });
};

// ---------------------------------------------------------------------------
// Runtime: API behavior via app.bindings
// ---------------------------------------------------------------------------

describe("bindings plugin (integration)", () => {
  describe("runtime: API behavior via app.bindings", () => {
    it("app.bindings is defined after createApp", () => {
      const app = createTestApp();

      expect(app.bindings).toBeDefined();
    });

    it("app.bindings.require returns the bound value from a stub env", () => {
      const app = createTestApp(["DB"]);
      const stubEnv = { DB: { prepare: () => undefined } };

      const result = app.bindings.require<{ prepare: () => undefined }>(stubEnv, "DB");

      expect(result).toBe(stubEnv.DB);
    });

    it("app.bindings.has returns true for a present key", () => {
      const app = createTestApp(["DB"]);
      const stubEnv = { DB: {} };

      expect(app.bindings.has(stubEnv, "DB")).toBe(true);
    });

    it("app.bindings.has returns false for a missing key", () => {
      const app = createTestApp();
      const stubEnv = { DB: {} };

      expect(app.bindings.has(stubEnv, "MISSING")).toBe(false);
    });

    it("app.bindings.require throws [moku-worker] for an unbound key", () => {
      const app = createTestApp();
      const stubEnv = {};

      expect(() => app.bindings.require(stubEnv, "UNBOUND")).toThrow("[moku-worker]");
      expect(() => app.bindings.require(stubEnv, "UNBOUND")).toThrow("UNBOUND");
    });
  });

  // -------------------------------------------------------------------------
  // Runtime: depends consumer reaching ctx.require(bindingsPlugin)
  // -------------------------------------------------------------------------

  describe("runtime: depends consumer via ctx.require(bindingsPlugin)", () => {
    it("a plugin with depends:[bindingsPlugin] can call ctx.require(bindingsPlugin).require()", () => {
      const resolved: unknown[] = [];

      const { createApp, createPlugin } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [bindingsPlugin]
      });

      const consumerPlugin = createPlugin("test-consumer", {
        depends: [bindingsPlugin],
        api: ctx => ({
          resolveX: (env: Record<string, unknown>) => {
            const value = ctx.require(bindingsPlugin).require<string>(env, "X");
            resolved.push(value);
            return value;
          }
        })
      });

      const app = createApp({
        plugins: [consumerPlugin]
      });

      const stubEnv = { X: "hello-from-x" };
      const result = app["test-consumer"].resolveX(stubEnv);

      expect(result).toBe("hello-from-x");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toBe("hello-from-x");
    });

    it("a plugin with depends:[bindingsPlugin] can call ctx.require(bindingsPlugin).has()", () => {
      const { createApp, createPlugin } = testCoreConfig.createCore(testCoreConfig, {
        plugins: [bindingsPlugin]
      });

      const consumerPlugin = createPlugin("test-has-consumer", {
        depends: [bindingsPlugin],
        api: ctx => ({
          checkPresence: (env: Record<string, unknown>, name: string) =>
            ctx.require(bindingsPlugin).has(env, name)
        })
      });

      const app = createApp({
        plugins: [consumerPlugin]
      });

      const stubEnv = { PRESENT: "yes" };
      expect(app["test-has-consumer"].checkPresence(stubEnv, "PRESENT")).toBe(true);
      expect(app["test-has-consumer"].checkPresence(stubEnv, "ABSENT")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Types: API surface
  // -------------------------------------------------------------------------

  describe("types: API surface", () => {
    it("app.bindings.require<T> is typed to return T", () => {
      const app = createTestApp();
      const env = { n: 42 };

      expectTypeOf(app.bindings.require<number>(env, "n")).toEqualTypeOf<number>();
    });

    it("app.bindings.has returns boolean", () => {
      const app = createTestApp();
      const env = { x: "value" };

      expectTypeOf(app.bindings.has(env, "x")).toEqualTypeOf<boolean>();
    });

    it("bindingsPlugin.name is the literal type 'bindings'", () => {
      expectTypeOf(bindingsPlugin.name).toEqualTypeOf<"bindings">();
    });
  });
});
