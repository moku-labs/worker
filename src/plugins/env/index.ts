/**
 * env — Core Plugin (Nano tier).
 *
 * Stage / dev-mode detection. Flat-injected as `ctx.env` on every regular
 * plugin's context (spec/02 §6). No state, no events, no depends, no lifecycle.
 *
 * @see README.md
 */
// createCorePlugin is framework-agnostic — imported directly from @moku-labs/core,
// NOT routed through ../../config (spec/03 §5 imports it from @moku-labs/core).
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

/** The ctx.env accessor surface injected on every regular plugin's context. */
export type EnvApi = {
  /**
   * Whether this Worker runs in the development stage.
   *
   * @returns True iff `stage === "development"`.
   * @example
   * ```typescript
   * if (ctx.env.isDev()) return Response.json({ stack: err.stack });
   * ```
   */
  isDev(): boolean;

  /**
   * Whether this Worker runs in the production stage. Note: false in "test".
   *
   * @returns True iff `stage === "production"`.
   * @example
   * ```typescript
   * const cc = ctx.env.isProduction() ? "public, max-age=31536000" : "no-store";
   * ```
   */
  isProduction(): boolean;

  /**
   * The raw deployment stage, as the literal union (not `string`).
   *
   * @returns The resolved stage value.
   * @example
   * ```typescript
   * ctx.log.info(`running in ${ctx.env.stage()} mode`);
   * ```
   */
  stage(): "production" | "development" | "test";
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
 * env core plugin — stage / dev-mode detection, flat-injected on every regular
 * plugin's context as `ctx.env` (spec/02 §6). No state, no events, no depends,
 * no lifecycle hooks.
 *
 * @see README.md
 * @example
 * ```typescript
 * // Inside any regular plugin's api factory:
 * api: (ctx) => ({
 *   errorBody: (e: Error) =>
 *     ctx.env.isDev() ? e.stack ?? e.message : "Internal Error",
 * })
 * ```
 */
export const envPlugin = createCorePlugin("env", {
  config: defaultConfig,
  /**
   * Builds the env accessor surface from the resolved stage.
   *
   * @param ctx - Core plugin context (spec/02 §6 — `{ config, state }` only;
   *   no `global`, `emit`, or `require`). `state` is unused by this plugin.
   * @param ctx.config - The resolved plugin config containing the deployment stage.
   * @returns The `ctx.env` API: `isDev`, `isProduction`, `stage`.
   * @example
   * ```typescript
   * const api = envPlugin.spec.api({ config: { stage: "development" }, state: {} });
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
     * if (ctx.env.isDev()) return Response.json({ stack: err.stack });
     * ```
     */
    isDev: (): boolean => config.stage === "development",

    /**
     * Whether this Worker runs in the production stage. Note: false in "test".
     *
     * @returns True iff `stage === "production"`.
     * @example
     * ```typescript
     * const cc = ctx.env.isProduction() ? "public, max-age=31536000" : "no-store";
     * ```
     */
    isProduction: (): boolean => config.stage === "production",

    /**
     * The raw deployment stage, as the literal union (not `string`).
     *
     * @returns The resolved stage.
     * @example
     * ```typescript
     * ctx.log.info(`running in ${ctx.env.stage()} mode`);
     * ```
     */
    stage: (): "production" | "development" | "test" => config.stage
  })
});
