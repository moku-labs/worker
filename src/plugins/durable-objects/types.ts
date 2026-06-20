/**
 * @file durableObjects plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";
import type { BindingsApi, bindingsPlugin } from "../bindings";

/**
 * A single Durable Object instance: the env binding it resolves off plus the EXPORTED class it
 * addresses. DOs are not provisioned (they ship with the Worker script), so there is no base
 * Cloudflare `name` — `binding` is the env var and `className` is the class the consumer exports from
 * `worker.ts`, decoupled from the logical key.
 *
 * @example
 * ```ts
 * { binding: "BOARD", className: "BoardChannel" }
 * ```
 */
export type DoInstance = {
  /** Env binding name the namespace resolves off the per-request `env` (e.g. `env.BOARD`). */
  binding: string;
  /** The EXPORTED Durable Object class name (e.g. `"BoardChannel"`), used in the wrangler config. */
  className: string;
  /** Marks this instance the default when more than one is configured. */
  default?: boolean;
};

/**
 * durableObjects plugin config — a keyed map of Durable Object instances. The key is the stable
 * logical name passed to `app.durableObjects.get(env, key, id)`; a single entry (or one flagged
 * `default: true`) is the implicit default.
 *
 * @example
 * ```ts
 * { board: { binding: "BOARD", className: "BoardChannel" } }
 * ```
 */
export type Config = Record<string, DoInstance>;

/** Public api surface of the durableObjects plugin. */
export type Api = {
  /**
   * Resolve a DurableObjectStub off the request env (logical key -> configured binding).
   *
   * @param env - Per-request Cloudflare bindings.
   * @param logicalName - Logical DO key (selects the configured instance).
   * @param idName - Stable id name passed to idFromName.
   * @returns The addressed Durable Object stub.
   */
  get(env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub;
  /**
   * Return this plugin's deploy metadata — one entry per configured instance (read by the deploy
   * plugin).
   *
   * @returns One do deploy descriptor per configured instance.
   */
  deployManifest(): Array<{ kind: "do"; binding: string; className: string }>;
};

/**
 * Internal context type — own config first, no state, no DO events.
 * Intersected with a narrow `require` typed to the one dependency durableObjects resolves.
 */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /**
   * Resolve a dependency plugin's api. durableObjects only ever resolves `bindingsPlugin`.
   *
   * @param plugin - The bindingsPlugin instance.
   * @returns The resolved bindings api.
   */
  require(plugin: typeof bindingsPlugin): BindingsApi;
};
