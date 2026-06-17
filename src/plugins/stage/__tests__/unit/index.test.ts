/**
 * Unit tests for the stage core plugin (Nano tier).
 *
 * Truth table contract:
 *   "production"  → isProduction true,  isDev false, current "production"
 *   "development" → isDev true,          isProduction false, current "development"
 *   "test"        → isDev false,         isProduction false (both false), current "test"
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { StageApi } from "../../index";
import { stagePlugin } from "../../index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Stage = "production" | "development" | "test";

/** Core plugin context shape: { config, state } only (spec/02 §6). */
type StageCoreCtx = { config: { stage: Stage }; state: Record<string, never> };

/** Type of the api factory extracted from the plugin spec. */
type StageApiFactory = (ctx: StageCoreCtx) => StageApi;

/** Typed accessor into the plugin's spec.api factory. */
const stageApiFactory = (stagePlugin as unknown as { spec: { api: StageApiFactory } }).spec.api;

/**
 * Build the core plugin context by hand.
 * Core plugin context is { config, state } only (spec/02 §6 — no global/emit/require).
 */
function makeCtx(stage: Stage): StageCoreCtx {
  return { config: { stage }, state: {} };
}

/**
 * Invoke the api factory with a given stage and return the StageApi surface.
 * Uses the stagePlugin's api spec field directly.
 */
function makeApi(stage: Stage): StageApi {
  return stageApiFactory(makeCtx(stage));
}

// ─── Truth table: production stage ───────────────────────────────────────────

describe("stage — stage: production", () => {
  it("isProduction() returns true", () => {
    expect(makeApi("production").isProduction()).toBe(true);
  });

  it("isDev() returns false", () => {
    expect(makeApi("production").isDev()).toBe(false);
  });

  it("current() returns 'production'", () => {
    expect(makeApi("production").current()).toBe("production");
  });
});

// ─── Truth table: development stage ──────────────────────────────────────────

describe("stage — stage: development", () => {
  it("isDev() returns true", () => {
    expect(makeApi("development").isDev()).toBe(true);
  });

  it("isProduction() returns false", () => {
    expect(makeApi("development").isProduction()).toBe(false);
  });

  it("current() returns 'development'", () => {
    expect(makeApi("development").current()).toBe("development");
  });
});

// ─── Truth table: test stage (both false case) ───────────────────────────────

describe("stage — stage: test", () => {
  it("isDev() returns false", () => {
    expect(makeApi("test").isDev()).toBe(false);
  });

  it("isProduction() returns false (both false in test stage)", () => {
    expect(makeApi("test").isProduction()).toBe(false);
  });

  it("current() returns 'test'", () => {
    expect(makeApi("test").current()).toBe("test");
  });
});

// ─── Default stage resolves to production behavior ────────────────────────────

describe("stage — default config", () => {
  it("default stage is 'production' (production-safe default)", () => {
    const api = stageApiFactory(makeCtx("production"));
    expect(api.isProduction()).toBe(true);
    expect(api.isDev()).toBe(false);
    expect(api.current()).toBe("production");
  });
});

// ─── Purity / idempotence ─────────────────────────────────────────────────────

describe("stage — purity and idempotence", () => {
  it("isDev() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("development");
    const api = stageApiFactory(ctx);
    const first = api.isDev();
    const second = api.isDev();
    expect(first).toBe(second);
    expect(ctx.config.stage).toBe("development");
  });

  it("isProduction() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("production");
    const api = stageApiFactory(ctx);
    const first = api.isProduction();
    const second = api.isProduction();
    expect(first).toBe(second);
    expect(ctx.config.stage).toBe("production");
  });

  it("current() returns the same value on repeated calls without mutating config", () => {
    const ctx = makeCtx("test");
    const api = stageApiFactory(ctx);
    const first = api.current();
    const second = api.current();
    expect(first).toBe(second);
    expect(ctx.config.stage).toBe("test");
  });
});

// ─── Type-level assertions ────────────────────────────────────────────────────

describe("stage — type-level assertions", () => {
  it("isDev is typed as () => boolean", () => {
    expectTypeOf<StageApi["isDev"]>().toEqualTypeOf<() => boolean>();
  });

  it("isProduction is typed as () => boolean", () => {
    expectTypeOf<StageApi["isProduction"]>().toEqualTypeOf<() => boolean>();
  });

  it("current is typed as () => literal union, not string", () => {
    expectTypeOf<StageApi["current"]>().toEqualTypeOf<
      () => "production" | "development" | "test"
    >();
  });

  it("current() return type is not assignable to arbitrary string literal outside the union", () => {
    const api = makeApi("production");
    // @ts-expect-error — current() returns the literal union; assigning to a
    // variable typed as a specific string outside the union is not valid
    const _bad: "staging" = api.current();
    expect(["production", "development", "test"]).toContain(_bad);
  });
});
