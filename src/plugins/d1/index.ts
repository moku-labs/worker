/**
 * @file d1 — Standard tier plugin skeleton. Cloudflare D1 SQL access (not an ORM).
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createD1Api } from "./api";
import type { Config } from "./types";

const defaultConfig: Config = { binding: "DB", migrations: "" };

/**
 * Standard tier — Cloudflare D1 SQL access (thin typed wrappers, not an ORM).
 *
 * @see README.md
 */
export const d1Plugin = createPlugin("d1", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createD1Api
});
