/**
 * @file `@moku-labs/worker` — server-side Cloudflare Workers app + deploy framework on `@moku-labs/core`.
 *
 * The package root exports the bound {@link createApp} factory (the Layer-3 entry
 * point), {@link createPlugin} for consumer plugins, every runtime plugin instance,
 * the `server`/`durable-objects` helpers, and the framework types. The node-only deploy
 * tooling (`deployPlugin`, `cliPlugin`) is exported from here too — the historical
 * `@moku-labs/worker/cli` subpath remains as a back-compat alias. Tree-shaking
 * (`"sideEffects": false`) keeps the node-only `node:child_process`/`node:fs` graph out
 * of any consumer bundle that does not actually add those two plugins.
 *
 * `createApp(options?)` boots a fully-typed, synchronous, per-isolate app. The
 * framework defaults `[logPlugin, envPlugin, stagePlugin, bindingsPlugin, serverPlugin]`
 * are applied first, then the `options` below are shallow-merged on top:
 *
 * - `config` — `Partial<WorkerConfig>`; defaults `{ stage: "production", name: "moku-worker", compatibilityDate: "" }`.
 *   `config.stage` is the single stage source: the framework mirrors it into the `stage` core
 *   plugin so `ctx.stage.*` / `app.stage.*` stay in lockstep with `ctx.global.stage` (see {@link createApp}).
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
import type { EnvProvider } from "@moku-labs/common";
import { coreConfig, createCore } from "./config";
import { workerSafeProcessEnv } from "./env-provider";
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

/** The core-bound app factory; wrapped by {@link createApp} to bridge `config.stage`. */
const boundCreateApp = framework.createApp;

/**
 * Boots a fully-typed, synchronous, per-isolate Worker app — the Layer-3 entry point.
 *
 * Wraps the core-bound factory to BRIDGE the single consumer-facing `config.stage`
 * into the `stage` core plugin's own config, so the typed accessors
 * (`ctx.stage.isDev()` / `app.stage.current()` / …) can never diverge from the
 * global `ctx.global.stage`. Global config and core-plugin config resolve on two
 * SEPARATE cascades (spec/05 §1b), and a core plugin cannot read global config (its
 * context is `{ config, state }` only — spec/02 §6). `createApp` is the only layer
 * that sees the consumer's chosen stage, so it mirrors `config.stage` into the stage
 * plugin's level-4 `pluginConfigs` override (`WorkerConfig.stage → pluginConfigs.stage.stage`).
 * When `config.stage` is omitted, the global config and the stage plugin both fall back
 * to their identical `"production"` default. It ALSO wires a default workerd-safe
 * {@link workerSafeProcessEnv} provider into the `env` core plugin (same bridge mechanism) so
 * deploy/auth can read `CLOUDFLARE_API_TOKEN` and friends via `ctx.env` — without it the env plugin
 * has zero providers and every `ctx.env` read is undefined. See the module JSDoc above for the
 * full options/defaults table.
 *
 * @param options - The createApp options (`config`, `pluginConfigs`, `plugins`, and lifecycle callbacks).
 * @returns The initialized app — every plugin's `onInit` has already run.
 * @example
 * ```typescript
 * const app = createApp({ config: { stage: "development", name: "my-worker" } });
 * app.stage.isDev(); // true — bridged from config.stage
 * app.env.get("CLOUDFLARE_API_TOKEN"); // read from process.env via the default env provider
 * ```
 */
export const createApp: typeof boundCreateApp = options => {
  const explicitStage = options?.config?.stage;

  // Bridge two pieces of CORE-plugin config the public `pluginConfigs` type excludes (core
  // plugins are not consumer-configurable — spec/05 §1b). `createApp` is the only layer that sees
  // the consumer's options, so it injects them here, then re-asserts the bound options type:
  //   • env — a default workerd-safe provider (workerSafeProcessEnv) so
  //     `ctx.env.get("CLOUDFLARE_API_TOKEN")` (and every other var) resolves; the env plugin ships
  //     with zero providers, which is what left `deploy` unable to read the token. A provider array
  //     supplied via the cast is kept.
  //   • stage — mirror the single global `config.stage` so `ctx.stage.*` never diverges from
  //     `ctx.global.stage` (omitted → both fall to the shared "production" default).
  const provided = options?.pluginConfigs as { env?: { providers?: EnvProvider[] } } | undefined;
  const pluginConfigs: Record<string, unknown> = {
    ...options?.pluginConfigs,
    env: { ...provided?.env, providers: provided?.env?.providers ?? [workerSafeProcessEnv()] }
  };
  if (explicitStage !== undefined) pluginConfigs.stage = { stage: explicitStage };

  return boundCreateApp({ ...options, pluginConfigs } as typeof options);
};

// ─── Plugins + Types ─────────────────────────────────────────
export * from "./plugins";

// Node-only deploy tooling — exported from the root so consumers add `deployPlugin`/`cliPlugin`
// without the extra `@moku-labs/worker/cli` import. Their `node:child_process`/`node:fs` graph is
// pulled into a bundle ONLY when a consumer actually lists them in `createApp({ plugins })`
// (`"sideEffects": false` tree-shakes them out otherwise). The `./cli` subpath stays as an alias.
export { cliPlugin } from "./plugins/cli";
export { deployPlugin } from "./plugins/deploy";
export type { ExternalManifest, ResourceManifest } from "./plugins/deploy/types";

// Core plugins (log + env from @moku-labs/common; stage is worker-local).
export { envPlugin, logPlugin } from "@moku-labs/common";
export { stagePlugin } from "./plugins/stage";
export type { StageApi } from "./plugins/stage";

// ─── Helpers ─────────────────────────────────────────────────
export { endpoint } from "./plugins/server/helpers";
export { defineDurableObject } from "./plugins/durable-objects/helpers";

// ─── Types ───────────────────────────────────────────────────
// `PluginCtx` is re-exported raw so Layer-3 consumer plugins type their context
// without importing from `@moku-labs/core` (a Layer-1 boundary the spec validator
// flags for consumers). `WorkerPluginCtx` is the ergonomic worker-bound alias that
// pre-merges `WorkerEvents`. core is already a dependency, so this adds no new one.
export type { PluginCtx } from "@moku-labs/core";
export type { WorkerConfig, WorkerEvents, WorkerEnv, WorkerPluginCtx } from "./config";
