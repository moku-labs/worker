/**
 * @file cli — Standard tier, node-only plugin skeleton. Developer-facing CLI surface.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { deployPlugin } from "../deploy";
import { createCliApi } from "./api";
import { createCliHooks } from "./handlers";
import type { Config } from "./types";

const defaultConfig: Config = { port: 8787 };

/**
 * Standard tier (node-only) — developer-facing CLI surface; thin passthroughs to deploy.
 *
 * @see README.md
 */
export const cliPlugin = createPlugin("cli", {
  depends: [deployPlugin] as const,
  config: defaultConfig,
  api: createCliApi,
  hooks: createCliHooks
});

export type { Config } from "./types";
