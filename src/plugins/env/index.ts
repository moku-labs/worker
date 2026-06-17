/**
 * @file env — Nano-tier CORE plugin skeleton. Stage / dev-mode detection, flat-injected as ctx.env.
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";

/** This plugin's own config type (Nano tier — declared inline, no types.ts). */
type Config = {
  /** Deployment stage; production-safe default. */
  stage: "production" | "development" | "test";
};

/** The ctx.env accessor surface injected on every regular plugin's context. */
export type EnvApi = {
  /** True iff stage === "development". */
  isDev(): boolean;
  /** True iff stage === "production" (false in "test"). */
  isProduction(): boolean;
  /** The raw stage as the literal union (not string). */
  stage(): "production" | "development" | "test";
};

/** Production-safe default config — no inline `as` (typed const above the factory). */
const defaultConfig: Config = {
  stage: "production"
};

/**
 * Core·Nano tier — stage / dev-mode detection, flat-injected on every regular plugin as ctx.env.
 *
 * @see README.md
 */
export const envPlugin = createCorePlugin("env", {
  config: defaultConfig,
  /**
   * Builds the env accessor surface from the resolved stage.
   *
   * @param _ctx - Core plugin context (unused in skeleton).
   * @example
   * ```ts
   * const api = envApi(ctx);
   * ```
   */
  api(_ctx): EnvApi {
    throw new Error("not implemented");
  }
});
