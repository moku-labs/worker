/**
 * @file `@moku-labs/worker` — server-side Cloudflare Workers app + deploy framework on `@moku-labs/core`.
 *
 * The package root exports the bound {@link createApp} factory (the Layer-3 entry
 * point), {@link createPlugin} for consumer plugins, every runtime plugin instance,
 * the `server`/`durable-objects` helpers, and the framework types. Node-only tooling
 * (`deploy`, `cli`) ships from the separate `@moku-labs/worker/cli` entry, never here.
 *
 * `createApp(options?)` boots a fully-typed, synchronous, per-isolate app. The
 * framework defaults `[logPlugin, envPlugin, stagePlugin, bindingsPlugin, serverPlugin]`
 * are applied first, then the `options` below are shallow-merged on top:
 *
 * - `config` — `Partial<WorkerConfig>`; defaults `{ stage: "production", name: "moku-worker", compatibilityDate: "" }`.
 * - `pluginConfigs` — per-plugin config overrides keyed by plugin name (e.g. `server.endpoints`, `bindings.required`); default `{}`.
 * - `plugins` — extra `PluginInstance[]` appended to the defaults; default `[]`. Do NOT re-list a default plugin.
 * - `onReady` — optional `(app) => void`, runs after every plugin's `onInit`.
 * - `onError` — optional `(error) => void` boot/lifecycle error handler.
 * - `onStart` / `onStop` — optional `() => void | Promise<void>` runtime lifecycle hooks (`app.start()` / `app.stop()`).
 *
 * Re-listing a default plugin name in `plugins` throws
 * `TypeError: [moku-worker] Duplicate plugin name: "<name>"` — `bindings` and `server`
 * are already wired, so consumers list only the resource plugins they add (`kv`, `d1`, …).
 *
 * Minimal HTTP Worker (shape taken from the server integration test):
 *
 * ```typescript
 * import { createApp, endpoint } from "@moku-labs/worker";
 *
 * export const app = createApp({
 *   config: { name: "my-worker", compatibilityDate: "2024-09-23" },
 *   pluginConfigs: {
 *     server: { endpoints: [endpoint("/health").get(() => new Response("ok"))] }
 *   }
 * });
 *
 * // worker.ts — the default export is hand-assembled; no plugin produces it.
 * export default {
 *   fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
 *     app.server.handle(request, env, ctx)
 * } satisfies ExportedHandler;
 * ```
 */
import { coreConfig, createCore } from "./config";
import { bindingsPlugin, serverPlugin } from "./plugins";

const framework = createCore(coreConfig, {
  plugins: [bindingsPlugin, serverPlugin]
});

// ─── Framework API ───────────────────────────────────────────
// Spec-prescribed destructured re-export (spec/02-CORE-API §3; spec/04-FACTORY-CHAIN §4):
// `createApp` is bound to the framework defaults + types; `createPlugin` is the same
// binding as config.ts, re-exported for consumer convenience. Consumer-facing docs for
// `createApp` live in the module JSDoc above (the options/defaults table).
export const { createApp, createPlugin } = framework;

// ─── Plugins + Types ─────────────────────────────────────────
export * from "./plugins";

// Core plugins (log + env from @moku-labs/common; stage is worker-local).
export { envPlugin, logPlugin } from "@moku-labs/common";
export { stagePlugin } from "./plugins/stage";
export type { StageApi } from "./plugins/stage";

// ─── Helpers ─────────────────────────────────────────────────
export { endpoint } from "./plugins/server/helpers";
export { defineDurableObject } from "./plugins/durable-objects/helpers";

// ─── Types ───────────────────────────────────────────────────
export type { WorkerConfig, WorkerEvents, WorkerEnv } from "./config";
