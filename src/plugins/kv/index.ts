/**
 * kv plugin — Micro tier.
 *
 * Thin wrapper over a Cloudflare KV namespace. Resolves the namespace per request
 * via the bindings plugin; never stores env (design §1a / SB4).
 * No state, no events, no hooks, no onInit/onStart/onStop (request-scoped).
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createKvApi } from "./api";

export type { Config, KvApi, KvInstance, KvNamespaceApi } from "./api";

import type { Config } from "./api";

/** Typed default — empty keyed map; the consumer declares instances under `pluginConfigs.kv`. */
const defaultConfig: Config = {};

/**
 * Micro tier — thin env-first wrapper over a Cloudflare KV namespace.
 *
 * Resolves the KV namespace per request via `ctx.require(bindingsPlugin)`;
 * never stores env in state (design §1a / SB4). No lifecycle hooks —
 * request-scoped; nothing to open or close.
 *
 * @see README.md
 */
export const kvPlugin = createPlugin("kv", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  api: createKvApi
});
