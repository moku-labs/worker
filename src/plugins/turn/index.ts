/**
 * turn plugin — Nano tier.
 *
 * Declares Cloudflare Realtime TURN keys as first-class deploy resources, exactly like kv/d1/r2
 * declare theirs: the consumer lists instances under `pluginConfigs.turn`, `deployManifest()`
 * surfaces them, and the deploy plugin ENSURES each after every successful deploy — both secrets
 * already bound → read-only no-op; otherwise a key is created via the Realtime REST API (the key
 * secret is returned exactly once) and its id + token bind as worker secrets. Provisioning is
 * strictly fail-open: an impediment (token without the Calls `Edit` scope, API failure) prints one
 * actionable line and the deploy continues (the app degrades to STUN, never breaks).
 *
 * No runtime surface: the worker reads the two bound secrets straight off `env` by the configured
 * binding names. No state, no events, no hooks, no lifecycle.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { createTurnApi } from "./api";

export type { Config, TurnApi, TurnInstance } from "./api";

import type { Config } from "./api";

/** Typed default — empty keyed map; the consumer declares instances under `pluginConfigs.turn`. */
const defaultConfig: Config = {};

/**
 * Nano tier — TURN keys as first-class deploy resources (Cloudflare Realtime).
 *
 * Build-time metadata only: `deployManifest()` is read by the deploy plugin, which ensures each
 * declared key post-deploy (fail-open). The runtime reads the bound secrets off `env`.
 *
 * @see README.md
 */
export const turnPlugin = createPlugin("turn", {
  config: defaultConfig,
  api: createTurnApi
});
