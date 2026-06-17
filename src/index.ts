/**
 * @file `@moku-labs/worker` — server-side Cloudflare Workers app + deploy framework on `@moku-labs/core`.
 */
import { coreConfig, createCore } from "./config";
import { bindingsPlugin, serverPlugin } from "./plugins";

const framework = createCore(coreConfig, {
  plugins: [bindingsPlugin, serverPlugin]
});

// ─── Plugins + Types ──────────────────────────────────────────
export * from "./plugins";

// ─── Core plugins (log + env from @moku-labs/common; stage is worker-local) ───
export { envPlugin, logPlugin } from "@moku-labs/common";
export { stagePlugin } from "./plugins/stage";
export type { StageApi } from "./plugins/stage";

// ─── Framework API + helpers ─────────────────────────────────
export const { createApp, createPlugin } = framework;
export { endpoint } from "./plugins/server/helpers";
export { defineDurableObject } from "./plugins/durable-objects/helpers";
export type { WorkerConfig, WorkerEvents, WorkerEnv } from "./config";
