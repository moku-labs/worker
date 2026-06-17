/**
 * @file storage — Complex tier plugin skeleton. Cloudflare R2 object storage behind a provider adapter.
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createStorageApi } from "./api";
import type { StorageConfig } from "./types";

const defaultConfig: StorageConfig = { upload: "", bucket: "ASSETS" };

/**
 * Complex tier — Cloudflare R2 object storage behind a provider adapter seam.
 *
 * @see README.md
 */
export const storagePlugin = createPlugin("storage", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createStorageApi
});
