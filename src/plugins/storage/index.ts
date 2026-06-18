/**
 * storage — Complex tier plugin.
 *
 * Cloudflare R2 object storage behind a provider adapter seam (real R2Bucket
 * via `providers/r2.ts`; in-memory test double in `__tests__/helpers/memory-provider.ts`).
 * Env-first runtime API — every method resolves the R2 binding from the
 * per-request `env` argument, never from stored state (SB4; spec/08 §6).
 * Build-time `deployManifest()` hands the deploy plugin this plugin's R2 metadata.
 * No state, no events — deploy owns upload-progress via global `deploy:phase`.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createStorageApi } from "./api";
import type { StorageConfig } from "./types";

/** Typed-const default — no inline `as` cast (R6; spec/11 §Part 2). */
const defaultConfig: StorageConfig = { upload: "", bucket: "ASSETS" };

/**
 * Complex tier — Cloudflare R2 object storage behind a provider adapter seam.
 *
 * Exposes `get`, `put`, `delete`, `list` (all env-first) and `deployManifest()`
 * (build-time). Depends on `bindingsPlugin` to resolve the `R2Bucket` binding
 * per request. No state, no events, no lifecycle hooks.
 *
 * @see README.md
 */
export const storagePlugin = createPlugin("storage", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createStorageApi
});
