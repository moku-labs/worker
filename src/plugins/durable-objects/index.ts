/**
 * @file durableObjects — Standard tier plugin skeleton. Cloudflare Durable Objects stub accessor + helper.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createDoApi } from "./api";
import { defineDurableObject } from "./helpers";
import type { Config } from "./types";

const defaultConfig: Config = { bindings: {} };

/**
 * Standard tier — Cloudflare Durable Objects stub accessor + defineDurableObject helper.
 *
 * @see README.md
 */
export const durableObjectsPlugin = createPlugin("durableObjects", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createDoApi,
  helpers: { defineDurableObject }
});

export { defineDurableObject } from "./helpers";
export type { Config } from "./types";
