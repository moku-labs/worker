/**
 * @file turn plugin — API factory (`deployManifest` over the keyed instance map).
 *
 * Build-time only: TURN keys have no request-time surface — the worker READS the two bound secrets
 * straight off its `env` (by the configured binding names), exactly like any other secret. The api
 * therefore exposes only the deploy metadata the deploy plugin assembles.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";

/**
 * One declared TURN key: the base Cloudflare key name (stage-suffixed downstream, like every other
 * provisioned resource name) and the two worker-secret names the key's id + API token bind to —
 * the names the app (or a composed plugin such as `@moku-labs/room/server`'s hub) reads off `env`.
 */
export type TurnInstance = {
  /** Base Cloudflare TURN key name (e.g. "myapp-turn"); stages suffix it like every resource name. */
  name: string;
  /** Worker-secret name the created key's id binds to. Default `"TURN_KEY_ID"`. */
  keyIdBinding?: string;
  /** Worker-secret name the created key's API token binds to. Default `"TURN_KEY_API_TOKEN"`. */
  apiTokenBinding?: string;
};

/** turn plugin configuration — a keyed map of TURN key instances (usually exactly one). */
export type Config = Record<string, TurnInstance>;

/** Default worker-secret name for the TURN key id. */
const DEFAULT_KEY_ID_BINDING = "TURN_KEY_ID";

/** Default worker-secret name for the TURN key API token. */
const DEFAULT_API_TOKEN_BINDING = "TURN_KEY_API_TOKEN";

/** turn public API surface (mounted at app.turn). */
export type TurnApi = {
  /**
   * Returns this plugin's own deploy metadata (one entry per configured TURN key), read by the
   * deploy plugin: the key is ENSURED after every successful deploy (created via the Cloudflare
   * Realtime API when the worker's secrets are missing; a fail-open no-op otherwise). Build-time
   * only — takes no env.
   *
   * @returns One turn deploy descriptor per configured instance (binding defaults resolved).
   * @example
   * ```ts
   * api.deployManifest();
   * // [{ kind: "turn", name: "myapp-turn", keyIdBinding: "TURN_KEY_ID", apiTokenBinding: "TURN_KEY_API_TOKEN" }]
   * ```
   */
  deployManifest(): Array<{
    kind: "turn";
    name: string;
    keyIdBinding: string;
    apiTokenBinding: string;
  }>;
};

/** THIS plugin's own config first; empty state (build-time metadata only, spec/08 §6). */
export type Context = PluginCtx<Config, Record<string, never>, WorkerEvents>;

/**
 * Builds the app.turn api over the keyed map of TURN key instances — deploy metadata only (the
 * runtime reads the bound secrets straight off `env`; there is nothing to wrap).
 *
 * @param ctx - The turn plugin context (keyed-map config).
 * @returns The app.turn api: deployManifest.
 * @example
 * ```ts
 * const api = createTurnApi(ctx);
 * api.deployManifest(); // one descriptor per configured instance
 * ```
 */
export const createTurnApi = (ctx: Context): TurnApi => ({
  /** @inheritdoc */
  deployManifest() {
    return Object.values(ctx.config).map(instance => ({
      kind: "turn" as const,
      name: instance.name,
      keyIdBinding: instance.keyIdBinding ?? DEFAULT_KEY_ID_BINDING,
      apiTokenBinding: instance.apiTokenBinding ?? DEFAULT_API_TOKEN_BINDING
    }));
  }
});
