/**
 * stage — Core Plugin (Nano tier).
 *
 * Deployment-stage / dev-mode detection. Flat-injected as `ctx.stage` on every
 * regular plugin's context (spec/02 §6). No state, no events, no depends, no lifecycle.
 *
 * Worker-specific: `@moku-labs/common`'s `env` plugin covers env-VARIABLE access
 * (`get`/`require`/`has`), NOT deployment-stage detection — so the worker keeps
 * stage detection as its own small core plugin rather than reimplementing log/env.
 *
 * @see README.md
 */
// createCorePlugin is framework-agnostic — imported directly from @moku-labs/core.
import { createCorePlugin } from "@moku-labs/core";

/** This plugin's own config type (Nano tier — declared inline, no types.ts). */
type Config = {
  /**
   * Deployment stage for this Worker.
   * - "production"  — live deploy; isDev() === false, isProduction() === true
   * - "development" — local `wrangler dev`; isDev() === true
   * - "test"        — automated tests; isDev() === false, isProduction() === false
   * Default: "production" (fail-safe — an unspecified app behaves as production).
   */
  stage: "production" | "development" | "test";
};

/** The ctx.stage accessor surface injected on every regular plugin's context. */
export type StageApi = {
  /**
   * Whether this Worker runs in the development stage.
   *
   * @returns True iff `stage === "development"`.
   * @example
   * ```typescript
   * if (ctx.stage.isDev()) return Response.json({ stack: err.stack });
   * ```
   */
  isDev(): boolean;

  /**
   * Whether this Worker runs in the production stage. Note: false in "test".
   *
   * @returns True iff `stage === "production"`.
   * @example
   * ```typescript
   * const cc = ctx.stage.isProduction() ? "public, max-age=31536000" : "no-store";
   * ```
   */
  isProduction(): boolean;

  /**
   * The raw deployment stage, as the literal union (not `string`).
   *
   * @returns The resolved stage value.
   * @example
   * ```typescript
   * ctx.log.info("startup", { stage: ctx.stage.current() });
   * ```
   */
  current(): "production" | "development" | "test";
};

/**
 * Production-safe default config. Declared as a typed const ABOVE the factory so
 * the literal `"production"` is checked against `Config` here — no inline `as`
 * cast inside the config slot (R6, spec/11 §Part 2).
 */
const defaultConfig: Config = {
  stage: "production"
};

/**
 * stage core plugin — deployment-stage / dev-mode detection, flat-injected on
 * every regular plugin's context as `ctx.stage` (spec/02 §6). No state, no
 * events, no depends, no lifecycle hooks.
 *
 * @see README.md
 * @example
 * ```typescript
 * // Inside any regular plugin's api factory:
 * api: (ctx) => ({
 *   errorBody: (e: Error) =>
 *     ctx.stage.isDev() ? e.stack ?? e.message : "Internal Error",
 * })
 * ```
 */
export const stagePlugin = createCorePlugin("stage", {
  config: defaultConfig,
  /**
   * Builds the stage accessor surface from the resolved stage.
   *
   * @param ctx - Core plugin context (spec/02 §6 — `{ config, state }` only;
   *   no `global`, `emit`, or `require`). `state` is unused by this plugin.
   * @param ctx.config - The resolved plugin config containing the deployment stage.
   * @returns The `ctx.stage` API: `isDev`, `isProduction`, `current`.
   * @example
   * ```typescript
   * const api = stagePlugin.spec.api({ config: { stage: "development" }, state: {} });
   * api.isDev(); // true
   * ```
   */
  api: ({ config }) => ({
    /**
     * Whether this Worker runs in the development stage.
     *
     * @returns True iff `stage === "development"`.
     * @example
     * ```typescript
     * if (ctx.stage.isDev()) return Response.json({ stack: err.stack });
     * ```
     */
    isDev: (): boolean => config.stage === "development",

    /**
     * Whether this Worker runs in the production stage. Note: false in "test".
     *
     * @returns True iff `stage === "production"`.
     * @example
     * ```typescript
     * const cc = ctx.stage.isProduction() ? "public, max-age=31536000" : "no-store";
     * ```
     */
    isProduction: (): boolean => config.stage === "production",

    /**
     * The raw deployment stage, as the literal union (not `string`).
     *
     * @returns The resolved stage.
     * @example
     * ```typescript
     * ctx.log.info("startup", { stage: ctx.stage.current() });
     * ```
     */
    current: (): "production" | "development" | "test" => config.stage
  })
});
