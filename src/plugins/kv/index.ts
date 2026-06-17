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

export type { KvApi } from "./api";

/** Typed default — no inline `as` cast in `config` (R6 / spec/11 §Part 2). */
const defaultConfig = { binding: "KV" };

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
