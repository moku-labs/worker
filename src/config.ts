/**
 * @file Framework configuration — Config + Events types, core plugin registration.
 */
import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig, type PluginCtx } from "@moku-labs/core";
import { stagePlugin } from "./plugins/stage";

/** Per-request Cloudflare bindings object (env). Framework-level shared type. */
export type WorkerEnv = Record<string, unknown>;

/** Global framework config — flat, with complete defaults. */
export type WorkerConfig = {
  stage: "production" | "development" | "test";
  name: string;
  compatibilityDate: string;
};

/** Global framework events — declared once, visible to every plugin. */
export type WorkerEvents = {
  "request:start": { method: string; path: string; requestId: string };
  "request:end": { method: string; path: string; status: number; ms: number };
  "deploy:phase": { phase: string; detail?: string };
  "deploy:complete": { url: string };
  "provision:resource": { kind: "kv" | "r2" | "d1" | "queue" | "do"; name: string };
  "provision:plan": { exists: number; missing: number; account: string };
  "provision:skip": { kind: "kv" | "r2" | "d1" | "queue" | "do"; name: string };
  "auth:verified": { account: string; accountId: string; scopes: string[] };
};

/**
 * Worker-bound plugin context for Layer-3 consumer plugins. Aliases the core
 * {@link PluginCtx} with the global {@link WorkerEvents} pre-merged into the event
 * map, so a consumer plugin types its own `config`/`state`/`emit` by passing only
 * its OWN event map — never hand-merging `WorkerEvents`, and never importing from
 * `@moku-labs/core` (a Layer-1 boundary the spec validator flags for consumers).
 *
 * A plugin that resolves sibling plugins also needs a `require` field; intersect the
 * public `Server.RequireFn` for it, exactly as this framework's own plugins do. When
 * you need the unaliased shape (e.g. a different global event map), use the raw
 * re-exported {@link PluginCtx} instead.
 *
 * @template Config - This plugin's own flat configuration object.
 * @template State - This plugin's mutable state (use `Record<string, never>` when stateless).
 * @template Events - This plugin's own event map, merged on top of {@link WorkerEvents}; defaults to none.
 * @example
 * ```typescript
 * import type { Server, WorkerPluginCtx } from "@moku-labs/worker";
 * type MyEvents = { "my:done": { id: string } };
 * export type MyCtx = WorkerPluginCtx<MyConfig, Record<string, never>, MyEvents> & {
 *   require: Server.RequireFn;
 * };
 * ```
 */
export type WorkerPluginCtx<
  Config,
  State,
  Events extends Record<string, unknown> = Record<never, never>
> = PluginCtx<Config, State, WorkerEvents & Events>;

const defaultConfig: WorkerConfig = {
  stage: "production",
  name: "moku-worker",
  compatibilityDate: ""
};

export const coreConfig = createCoreConfig<
  WorkerConfig,
  WorkerEvents,
  [typeof logPlugin, typeof envPlugin, typeof stagePlugin]
>("moku-worker", {
  config: defaultConfig,
  plugins: [logPlugin, envPlugin, stagePlugin]
});

export const { createPlugin, createCore } = coreConfig;
