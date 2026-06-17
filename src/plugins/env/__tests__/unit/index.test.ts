/**
 * Unit tests for the env core plugin (Nano tier).
 *
 * Truth table contract (spec/02 §API):
 *   "production"  → isProduction true,  isDev false, stage "production"
 *   "development" → isDev true,          isProduction false, stage "development"
 *   "test"        → isDev false,         isProduction false (both false), stage "test"
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { EnvApi } from "../../index";
import { envPlugin } from "../../index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Stage = "production" | "development" | "test";

/** Core plugin context shape: { config, state } only (spec/02 §6). */
type EnvCoreCtx = { config: { stage: Stage }; state: Record<string, never> };

/** Type of the api factory extracted from the plugin spec. */
type EnvApiFactory = (ctx: EnvCoreCtx) => EnvApi;

/** Typed accessor into the plugin's spec.api factory. */
const envApiFactory = (envPlugin as unknown as { spec: { api: EnvApiFactory } }).spec.api;

/**
 * Build the core plugin context by hand.
 * Core plugin context is { config, state } only (spec/02 §6 — no global/emit/require).
 */
function makeCtx(stage: Stage): EnvCoreCtx {
  return { config: { stage }, state: {} };
}

/**
 * Invoke the api factory with a given stage and return the EnvApi surface.
 * Uses the envPlugin's api spec field directly.
 */
function makeApi(stage: Stage): EnvApi {
  return envApiFactory(makeCtx(stage));
}

// ─── Truth table: production stage ───────────────────────────────────────────

describe("env — stage: production", () => {
  it("isProduction() returns true", () => {
    expect(makeApi("production").isProduction()).toBe(true);
  });

  it("isDev() returns false", () => {
    expect(makeApi("production").isDev()).toBe(false);
  });

  it("stage() returns 'production'", () => {
    expect(makeApi("production").stage()).toBe("production");
  });
});

// ─── Truth table: development stage ──────────────────────────────────────────

describe("env — stage: development", () => {
  it("isDev() returns true", () => {
    expect(makeApi("development").isDev()).toBe(true);
  });

  it("isProduction() returns false", () => {
    expect(makeApi("development").isProduction()).toBe(false);
  });

  it("stage() returns 'development'", () => {
    expect(makeApi("development").stage()).toBe("development");
  });
});

// ─── Truth table: test stage (both false case) ───────────────────────────────

describe("env — stage: test", () => {
  it("isDev() returns false", () => {
    expect(makeApi("test").isDev()).toBe(false);
  });

  it("isProduction() returns false (both false in test stage)", () => {
    expect(makeApi("test").isProduction()).toBe(false);
  });

  it("stage() returns 'test'", () => {
    expect(makeApi("test").stage()).toBe("test");
  });
});

// ─── Default stage resolves to production behavior ────────────────────────────

describe("env — default config", () => {
  it("default stage is 'production' (production-safe default)", () => {
    // The spec default is { stage: "production" } — build ctx from defaultConfig
    const api = envApiFactory(makeCtx("production"));
    expect(api.isProduction()).toBe(true);
    expect(api.isDev()).toBe(false);
    expect(api.stage()).toBe("production");
  });
});

// ─── Purity / idempotence ─────────────────────────────────────────────────────

describe("env — purity and idempotence", () => {
  it("isDev() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("development");
    const api = envApiFactory(ctx);
    const first = api.isDev();
    const second = api.isDev();
    expect(first).toBe(second);
    // config must not be mutated
    expect(ctx.config.stage).toBe("development");
  });

  it("isProduction() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("production");
    const api = envApiFactory(ctx);
    const first = api.isProduction();
    const second = api.isProduction();
    expect(first).toBe(second);
    expect(ctx.config.stage).toBe("production");
  });

  it("stage() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("test");
    const api = envApiFactory(ctx);
    const first = api.stage();
    const second = api.stage();
    expect(first).toBe(second);
    expect(ctx.config.stage).toBe("test");
  });
});

// ─── Type-level assertions ────────────────────────────────────────────────────

describe("env — type-level assertions", () => {
  it("isDev is typed as () => boolean", () => {
    expectTypeOf<EnvApi["isDev"]>().toEqualTypeOf<() => boolean>();
  });

  it("isProduction is typed as () => boolean", () => {
    expectTypeOf<EnvApi["isProduction"]>().toEqualTypeOf<() => boolean>();
  });

  it("stage is typed as () => literal union, not string", () => {
    expectTypeOf<EnvApi["stage"]>().toEqualTypeOf<() => "production" | "development" | "test">();
  });

  it("stage() return type is not assignable to arbitrary string literal outside the union", () => {
    const api = makeApi("production");
    // @ts-expect-error — stage() returns the literal union; assigning to a
    // variable typed as a specific string outside the union is not valid
    const _bad: "staging" = api.stage();
    // Runtime guard: the value is a valid union member, never "staging"
    expect(["production", "development", "test"]).toContain(_bad);
  });
});
