/**
 * @file deploy — Complex, node-only plugin (build-time deploy orchestrator).
 *
 * Complex tier. Runs the full deploy pipeline at build time:
 * detect → provision → wrangler-config → upload → wrangler deploy.
 * Emits only the three GLOBAL events declared in WorkerEvents
 * (deploy:phase / deploy:complete / provision:resource — no per-plugin events block).
 * No state, no hooks, no lifecycle (one-shot build-time; Workers are request-scoped).
 * @see README.md
 */
import { createPlugin } from "../../config";
import { d1Plugin } from "../d1";
import { durableObjectsPlugin } from "../durable-objects";
import { kvPlugin } from "../kv";
import { queuesPlugin } from "../queues";
import { storagePlugin } from "../storage";
import { createDeployApi } from "./api";
import type { Config } from "./types";

/** Typed default — no inline `as` cast in config (R6 / spec/11 §Part 2). */
const defaultConfig: Config = { configFile: "wrangler.jsonc", ci: false };

/**
 * Complex tier (node-only) — build-time deploy orchestrator over the five resource plugins.
 *
 * Assembles each resource plugin's deployManifest() via ctx.require, provisions resources,
 * generates/updates wrangler config, uploads the R2 upload dir, and runs wrangler deploy.
 * Also supports a universal path: run({ manifest }) uses a caller-supplied manifest verbatim.
 *
 * Emits only the global events `deploy:phase`, `deploy:complete`, and `provision:resource`
 * (declared in WorkerEvents — no per-plugin events block).
 *
 * @see README.md
 */
export const deployPlugin = createPlugin("deploy", {
  config: defaultConfig,
  depends: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin] as const,
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createDeployApi(ctx)
});
