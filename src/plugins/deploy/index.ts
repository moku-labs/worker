/**
 * @file deploy — Complex, node-only plugin skeleton. Build-time deploy orchestrator.
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

const defaultConfig: Config = { configFile: "wrangler.jsonc", ci: false };

/**
 * Complex tier (node-only) — build-time deploy orchestrator over the five resource plugins.
 *
 * @see README.md
 */
export const deployPlugin = createPlugin("deploy", {
  config: defaultConfig,
  depends: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin] as const,
  api: createDeployApi
});
