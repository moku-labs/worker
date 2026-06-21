/**
 * @file durableObjects plugin — API factory (get, deployManifest).
 *
 * Builds `app.durableObjects.*`. Reached by handlers via `require(durableObjectsPlugin)`
 * (spec/08 §7). Resolves the DO namespace off the REQUEST-SUPPLIED env on every call —
 * env is threaded as an argument, never stored (design §1a / SB4).
 */
import type { WorkerEnv } from "../../config";
import { bindingsPlugin } from "../bindings";
import { pickInstance } from "../bindings/instances";
import type { Ctx } from "./types";

/**
 * Builds the `app.durableObjects` API surface — `get` and `deployManifest`.
 *
 * All namespace resolution uses the per-call `env` argument: `env` is threaded, never
 * stored (SB4 / design §1a). The keyed-map config is frozen and read-only. No state
 * is held on the plugin between calls (stateless — `Record<string, never>`).
 *
 * @param ctx - Plugin context with the keyed-map `config`, `require(bindingsPlugin)`, and core APIs.
 * @returns The durableObjects API: `{ get, deployManifest }`.
 * @example
 * ```typescript
 * const api = createDoApi(ctx);
 * const stub = api.get(env, "board", "room-42");
 * const manifest = api.deployManifest(); // [{ kind: "do", binding: "BOARD", className: "BoardChannel" }]
 * ```
 */
export const createDoApi = (ctx: Ctx) => ({
  /**
   * Resolves a `DurableObjectStub` off the per-request env.
   *
   * Selects the configured instance by `logicalName` (the config key) via `pickInstance`, resolves
   * its `binding` off `env`, derives a deterministic id via `namespace.idFromName(idName)`, and
   * returns the addressed stub. Synchronous — returns a stub, not a Promise. Throws (branded) when
   * `logicalName` is not configured, or (via the bindings resolver) when the binding is not present
   * on `env`.
   *
   * @param env - Per-request Cloudflare bindings object (Worker fetch/queue/scheduled env).
   * @param logicalName - Logical DO key (selects the configured instance, e.g. `"board"`).
   * @param idName - Stable id name passed to `idFromName` (e.g. `"room-42"`).
   * @returns The addressed `DurableObjectStub`.
   * @throws {Error} With `[moku-worker]` prefix when `logicalName` is not configured, or when the
   *   binding is not bound on `env`.
   * @example
   * ```typescript
   * const stub = app.durableObjects.get(env, "board", "room-42");
   * const res = await stub.fetch("https://do/increment");
   * ```
   */
  get: (env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub => {
    const binding = pickInstance(ctx.config, logicalName, "durableObjects").binding;
    const ns = ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, binding);
    return ns.get(ns.idFromName(idName));
  },

  /**
   * Returns this plugin's deploy metadata — one entry per configured instance, read by the `deploy`
   * plugin via `ctx.require(durableObjectsPlugin)`. Never reads sibling `pluginConfigs` (F6;
   * spec/08 §5, §7). Pure synchronous read of `ctx.config`.
   *
   * @returns One `{ kind: "do", binding, className }` per configured instance.
   * @example
   * ```typescript
   * const manifest = app.durableObjects.deployManifest();
   * // → [{ kind: "do", binding: "BOARD", className: "BoardChannel" }]
   * ```
   */
  deployManifest: (): Array<{ kind: "do"; binding: string; className: string }> =>
    Object.values(ctx.config).map(instance => ({
      kind: "do" as const,
      binding: instance.binding,
      className: instance.className
    }))
});
