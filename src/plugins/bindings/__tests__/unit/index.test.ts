/**
 * Unit tests for the bindings plugin — require/has behavior, falsy-but-bound
 * values, nullish guard, no-leakage, and type-level assertions.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { WorkerEnv } from "../../../../config";
import { createBindingsApi } from "../../api";
import type { BindingsApi } from "../../index";
import { bindingsPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Helpers: build the api without a full createApp lifecycle. The factory
// ignores ctx entirely (F4 — stateless), so a cast-away stub is safe here.
// ---------------------------------------------------------------------------

/** Produce a fresh BindingsApi for each test. */
const makeApi = (): BindingsApi => createBindingsApi({} as never);

// ---------------------------------------------------------------------------
// require<T>
// ---------------------------------------------------------------------------

describe("bindings plugin — unit", () => {
  describe("require<T>", () => {
    it("returns the exact binding value for a present key", () => {
      const api = makeApi();
      const bound = { get: (): string | undefined => undefined };
      const env: WorkerEnv = { MY_KV: bound };

      const result = api.require<typeof bound>(env, "MY_KV");

      expect(result).toBe(bound);
    });

    it("throws with [moku-worker] prefix and binding name when key is undefined", () => {
      const api = makeApi();
      const env: WorkerEnv = {};

      expect(() => api.require(env, "MISSING")).toThrow("[moku-worker]");
      expect(() => api.require(env, "MISSING")).toThrow("MISSING");
    });

    it("throws with [moku-worker] prefix and binding name when key is explicitly absent (undefined value)", () => {
      const api = makeApi();
      // undefined value — the == null guard covers undefined (same path as missing key)
      const env: WorkerEnv = { ABSENT_BINDING: undefined };

      expect(() => api.require(env, "ABSENT_BINDING")).toThrow("[moku-worker]");
      expect(() => api.require(env, "ABSENT_BINDING")).toThrow("ABSENT_BINDING");
    });

    it("does NOT throw for empty string (falsy but bound)", () => {
      const api = makeApi();
      const env: WorkerEnv = { EMPTY: "" };

      expect(() => api.require<string>(env, "EMPTY")).not.toThrow();
      expect(api.require<string>(env, "EMPTY")).toBe("");
    });

    it("does NOT throw for zero (falsy but bound)", () => {
      const api = makeApi();
      const env: WorkerEnv = { ZERO: 0 };

      expect(() => api.require<number>(env, "ZERO")).not.toThrow();
      expect(api.require<number>(env, "ZERO")).toBe(0);
    });

    it("does NOT throw for false (falsy but bound)", () => {
      const api = makeApi();
      const env: WorkerEnv = { FLAG: false };

      expect(() => api.require<boolean>(env, "FLAG")).not.toThrow();
      expect(api.require<boolean>(env, "FLAG")).toBe(false);
    });

    it("throws an Error instance (not just a string)", () => {
      const api = makeApi();
      const env: WorkerEnv = {};

      expect(() => api.require(env, "X")).toThrowError(Error);
    });
  });

  // -------------------------------------------------------------------------
  // has
  // -------------------------------------------------------------------------

  describe("has", () => {
    it("returns true for a present non-nullish key", () => {
      const api = makeApi();
      const env: WorkerEnv = { DB: {} };

      expect(api.has(env, "DB")).toBe(true);
    });

    it("returns false for a missing key", () => {
      const api = makeApi();
      const env: WorkerEnv = {};

      expect(api.has(env, "MISSING")).toBe(false);
    });

    it("returns false when the key value is undefined", () => {
      const api = makeApi();
      const env: WorkerEnv = { UNDEF: undefined };

      expect(api.has(env, "UNDEF")).toBe(false);
    });

    it("returns true for falsy-but-bound empty string", () => {
      const api = makeApi();
      const env: WorkerEnv = { S: "" };

      expect(api.has(env, "S")).toBe(true);
    });

    it("returns true for falsy-but-bound zero", () => {
      const api = makeApi();
      const env: WorkerEnv = { N: 0 };

      expect(api.has(env, "N")).toBe(true);
    });

    it("returns true for falsy-but-bound false", () => {
      const api = makeApi();
      const env: WorkerEnv = { B: false };

      expect(api.has(env, "B")).toBe(true);
    });

    it("never throws regardless of key or env shape", () => {
      const api = makeApi();
      const env: WorkerEnv = {};

      expect(() => api.has(env, "ANY")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // No-leakage: each call reads strictly from its own env argument
  // -------------------------------------------------------------------------

  describe("no-leakage (stateless — each call resolves from its own env argument)", () => {
    it("require resolves from each call's env; second env cannot see first env's keys", () => {
      const api = makeApi();
      const env1: WorkerEnv = { X: "from-env1" };
      const env2: WorkerEnv = { Y: "from-env2" };

      const v1 = api.require<string>(env1, "X");
      const v2 = api.require<string>(env2, "Y");

      expect(v1).toBe("from-env1");
      expect(v2).toBe("from-env2");
      // X is not in env2 — must throw, not leak from env1
      expect(() => api.require(env2, "X")).toThrow("[moku-worker]");
    });

    it("has resolves from each call's env; second env cannot see first env's keys", () => {
      const api = makeApi();
      const env1: WorkerEnv = { ONLY_IN_ENV1: "yes" };
      const env2: WorkerEnv = {};

      expect(api.has(env1, "ONLY_IN_ENV1")).toBe(true);
      // The key must NOT be visible from env2
      expect(api.has(env2, "ONLY_IN_ENV1")).toBe(false);
    });

    it("two sequential calls with different envs return independent values", () => {
      const api = makeApi();
      const env1: WorkerEnv = { KEY: "first" };
      const env2: WorkerEnv = { KEY: "second" };

      // Same key name, different env objects — each call must use its own env
      expect(api.require<string>(env1, "KEY")).toBe("first");
      expect(api.require<string>(env2, "KEY")).toBe("second");
    });
  });

  // -------------------------------------------------------------------------
  // Type-level assertions
  // -------------------------------------------------------------------------

  describe("types", () => {
    it("require<T> is typed to return T", () => {
      const api = makeApi();
      const env: WorkerEnv = { n: 42 };

      expectTypeOf(api.require<number>(env, "n")).toEqualTypeOf<number>();
    });

    it("has returns boolean", () => {
      const api = makeApi();
      const env: WorkerEnv = { x: "value" };

      expectTypeOf(api.has(env, "x")).toEqualTypeOf<boolean>();
    });

    it("bindingsPlugin.name is the literal 'bindings'", () => {
      expectTypeOf(bindingsPlugin.name).toEqualTypeOf<"bindings">();
    });
  });
});
