/**
 * @file durableObjects plugin — API factory (get, deployManifest).
 *
 * Builds `app.durableObjects.*`. Reached by handlers via `require(durableObjectsPlugin)`
 * (spec/08 §7). Resolves the DO namespace off the REQUEST-SUPPLIED env on every call —
 * env is threaded as an argument, never stored (design §1a / SB4).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import { bindingsPlugin } from "../bindings";
import type { Config, DeployManifest } from "./types";

/**
 * Minimal bindings API shape needed by `createDoApi`.
 * Structural type — avoids a circular import with the bindings plugin.
 */
type BindingsApi = {
  /**
   * Resolve a binding off the request env, narrowed to T.
   *
   * @param env - The per-request Cloudflare bindings object.
   * @param name - The binding name to resolve.
   * @returns The binding value narrowed to T.
   */
  require: <T>(env: WorkerEnv, name: string) => T;
  /**
   * True when the binding is non-nullish on the request env.
   *
   * @param env - The per-request Cloudflare bindings object.
   * @param name - The binding name to check.
   * @returns Whether the binding is present and non-nullish.
   */
  has: (env: WorkerEnv, name: string) => boolean;
};

/**
 * Context type for `createDoApi`. Extends `PluginCtx` with `require` — injected at
 * runtime because this is a regular plugin with `depends: [bindingsPlugin]`.
 * Structural intersection avoids importing unexported core internals.
 */
type ApiCtx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /**
   * Cross-plugin API accessor (spec/08 §7). durableObjects only resolves
   * `bindingsPlugin`, so `require` is typed to that one dependency — core does
   * not export `RequireFunction`, and a `{ name: string }` constraint is not
   * assignable from core's real `PluginLike`-constrained `require`.
   *
   * @param plugin - The bindings plugin instance.
   * @returns The bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};

/**
 * Builds the `app.durableObjects` API surface — `get` and `deployManifest`.
 *
 * All namespace resolution uses the per-call `env` argument: `env` is threaded, never
 * stored (SB4 / design §1a). The config bindings map is frozen and read-only. No state
 * is held on the plugin between calls (stateless — `Record<string, never>`).
 *
 * @param ctx - Plugin context with `config.bindings`, `require(bindingsPlugin)`, and core APIs.
 * @returns The durableObjects API: `{ get, deployManifest }`.
 * @example
 * ```typescript
 * const api = createDoApi(ctx);
 * const stub = api.get(env, "counter", "room-42");
 * const manifest = api.deployManifest(); // { kind: "do", bindings: { counter: "COUNTER" } }
 * ```
 */
export const createDoApi = (ctx: ApiCtx) => ({
  /**
   * Resolves a `DurableObjectStub` off the per-request env.
   *
   * Maps `logicalName` → `config.bindings[logicalName]` (falling back to `logicalName`
   * itself when unmapped), derives a deterministic id via `namespace.idFromName(idName)`,
   * and returns the addressed stub. Synchronous — returns a stub, not a Promise.
   * Throws (via the bindings resolver) when the binding is not present on `env`.
   *
   * @param env - Per-request Cloudflare bindings object (Worker fetch/queue/scheduled env).
   * @param logicalName - Logical DO name used in code (e.g. `"counter"`).
   * @param idName - Stable id name passed to `idFromName` (e.g. `"room-42"`).
   * @returns The addressed `DurableObjectStub`.
   * @throws {Error} With `[moku-worker]` prefix when the binding is not bound on `env`.
   * @example
   * ```typescript
   * const stub = app.durableObjects.get(env, "counter", "room-42");
   * const res = await stub.fetch("https://do/increment");
   * ```
   */
  get: (env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub => {
    const binding = ctx.config.bindings[logicalName] ?? logicalName;
    const ns = ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, binding);
    return ns.get(ns.idFromName(idName));
  },

  /**
   * Returns this plugin's deploy metadata — read by the `deploy` plugin via
   * `ctx.require(durableObjectsPlugin)`. Never reads sibling `pluginConfigs` (F6;
   * spec/08 §5, §7). Pure synchronous read of `ctx.config.bindings`.
   *
   * @returns `{ kind: "do", bindings }` reflecting the frozen plugin config.
   * @example
   * ```typescript
   * const manifest = app.durableObjects.deployManifest();
   * // → { kind: "do", bindings: { counter: "COUNTER" } }
   * ```
   */
  deployManifest: (): DeployManifest => ({
    kind: "do" as const,
    bindings: ctx.config.bindings
  })
});
