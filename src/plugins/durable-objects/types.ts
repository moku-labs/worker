/**
 * @file durableObjects plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";

/**
 * durableObjects plugin configuration. Flat; complete default so omission never yields undefined.
 *
 * @example
 * ```ts
 * { bindings: { counter: "COUNTER" } }
 * ```
 */
export type Config = {
  /** Logical name -> Cloudflare DO binding name. A missing logical name falls back to itself. Default {}. */
  bindings: Record<string, string>;
};

/**
 * Deploy metadata entry for Durable Objects, read by the deploy plugin.
 *
 * @example
 * ```ts
 * { kind: "do", bindings: { counter: "COUNTER" } }
 * ```
 */
export type DeployManifest = {
  /** Discriminant identifying this as a Durable Objects resource. */
  kind: "do";
  /** Logical name -> Cloudflare DO binding name. */
  bindings: Record<string, string>;
};

/** Public api surface of the durableObjects plugin. */
export type Api = {
  /**
   * Resolve a DurableObjectStub off the request env (logical name -> configured binding).
   *
   * @param env - Per-request Cloudflare bindings.
   * @param logicalName - Logical DO name used in code.
   * @param idName - Stable id name passed to idFromName.
   * @returns The addressed Durable Object stub.
   */
  get(env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub;
  /**
   * Return this plugin's deploy metadata (read by the deploy plugin).
   *
   * @returns Deploy manifest entry `{ kind: "do", bindings }`.
   */
  deployManifest(): DeployManifest;
};

/** Internal context type — own config first, no state, no DO events. */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents>;
