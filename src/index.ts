/**
 * @file `@moku-labs/worker` — server-side Cloudflare Workers app + deploy framework on `@moku-labs/core`.
 *
 * The package root exports the bound {@link createApp} factory (the Layer-3 entry
 * point), {@link createPlugin} for consumer plugins, every runtime plugin instance,
 * the `server`/`durable-objects` helpers, and the framework types. The node-only deploy
 * tooling (`deployPlugin`, `cliPlugin`) is exported from here too. Tree-shaking
 * (`"sideEffects": false`) keeps the node-only `node:child_process`/`node:fs` graph out
 * of any consumer bundle that does not actually add those two plugins.
 *
 * `createApp(options?)` boots a fully-typed, synchronous, per-isolate app. The
 * framework defaults `[logPlugin, envPlugin, bindingsPlugin, serverPlugin]`
 * are applied first, then the `options` below are shallow-merged on top:
 *
 * - `config` — `Partial<WorkerConfig>`; defaults `{ stage: "production", name: "worker", compatibilityDate: "" }`.
 *   `config.stage` is the single stage source, read off `ctx.global.stage`; `deploy`/`cli` use it to
 *   suffix resource names (`production` = bare). There is no stage plugin.
 * - `pluginConfigs` — per-plugin config overrides keyed by plugin name (e.g. `server.endpoints`, `bindings.required`); default `{}`.
 * - `plugins` — extra `PluginInstance[]` appended to the defaults; default `[]`. Do NOT re-list a default plugin.
 * - `onReady` — optional `(app) => void`, runs after every plugin's `onInit`.
 * - `onError` — optional `(error) => void` boot/lifecycle error handler.
 * - `onStart` / `onStop` — optional `() => void | Promise<void>` runtime lifecycle hooks (`app.start()` / `app.stop()`).
 *
 * Re-listing a default plugin name in `plugins` throws
 * `TypeError: [worker] Duplicate plugin name: "<name>"` — `bindings` and `server`
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
// `createPlugin` is the same binding as config.ts, re-exported for consumer
// convenience (spec/02-CORE-API §3; spec/04-FACTORY-CHAIN §4). `createApp` is the
// core-bound factory wrapped just below to bridge the stage config — its
// consumer-facing options/defaults live in the module JSDoc above.
export const { createPlugin } = framework;

/**
 * Boots a fully-typed, synchronous, per-isolate Worker app — the Layer-3 entry point.
 *
 * The framework defaults (`log`/`env` core + `bindings`, `server`) are wired first;
 * your `options` are merged over them through the 4-level config cascade, every
 * plugin's `onInit` runs, and a fully-typed, frozen app is returned. Deployment stage
 * is the single global `config.stage` (read via `ctx.global.stage`). The `env` core
 * plugin's default workerd-safe provider is seeded in {@link coreConfig} (not injected
 * here), so deploy/auth can read `CLOUDFLARE_API_TOKEN` and friends via `ctx.env` with
 * no extra wiring.
 *
 * @param options - The createApp options (`config`, `pluginConfigs`, `plugins`, and lifecycle
 *   callbacks). See the module JSDoc above for the full options/defaults table.
 * @returns The initialized app — every plugin's `onInit` has already run.
 * @example
 * ```typescript
 * const app = createApp({ config: { stage: "development", name: "my-worker" } });
 * app.env.get("CLOUDFLARE_API_TOKEN"); // read from process.env via the default env provider
 * ```
 */
export const createApp = framework.createApp;

// ─── Plugins + Types ─────────────────────────────────────────
export * from "./plugins";

// Node-only deploy tooling — exported from the root so consumers add `deployPlugin`/`cliPlugin`
// straight from `@moku-labs/worker`. Their `node:child_process`/`node:fs` graph is
// pulled into a bundle ONLY when a consumer actually lists them in `createApp({ plugins })`
// (`"sideEffects": false` tree-shakes them out otherwise).
export { cliPlugin } from "./plugins/cli";
export { deployPlugin } from "./plugins/deploy";
export type {
  DeployReport,
  ExternalManifest,
  PostDeploySecrets,
  PostDeployStep,
  PostDeployStepCtx,
  ResourceManifest,
  SeedConfig
} from "./plugins/deploy/types";

// Core plugins (log + env from @moku-labs/common). The deployment stage lives on
// the global `WorkerConfig.stage`; deploy/cli read it directly (no stage plugin).
export { envPlugin, logPlugin } from "@moku-labs/common";

// ─── Helpers ─────────────────────────────────────────────────
export { endpoint } from "./plugins/server/helpers";
// `endpoint.new(guard)` types: the chainable factory + the guard a consumer authors.
export type { GuardedEndpointFactory } from "./plugins/server/helpers";
export type { EndpointGuard } from "./plugins/server/types";
export { defineDurableObject } from "./plugins/durable-objects/helpers";

// ─── Types ───────────────────────────────────────────────────
// `PluginCtx` is re-exported raw so Layer-3 consumer plugins type their context
// without importing from `@moku-labs/core` (a Layer-1 boundary the spec validator
// flags for consumers). `WorkerPluginCtx` is the ergonomic worker-bound alias that
// pre-merges `WorkerEvents`. core is already a dependency, so this adds no new one.
export type { PluginCtx } from "@moku-labs/core";
export type { WorkerConfig, WorkerEvents, WorkerEnv, WorkerPluginCtx } from "./config";
