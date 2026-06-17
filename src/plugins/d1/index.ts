/**
 * d1 plugin — Standard tier.
 *
 * Cloudflare D1 SQL access: thin typed wrappers over prepare().bind()
 * (query/first/run/batch) plus deployManifest(). NOT an ORM.
 * Depends on bindings to resolve the D1Database off the per-request env.
 * Declares no events.
 *
 * @see README.md
 */
import { createPlugin } from "../../config";
import { bindingsPlugin } from "../bindings";
import { createD1Api } from "./api";
import type { Config } from "./types";

/**
 * Default d1 config. Declared as a typed const (not an inline object) so the
 * shape is checked against `Config` with no inline `as` assertion (R6, spec/11 §Part 2).
 */
const defaultConfig: Config = { binding: "DB", migrations: "" };

/**
 * Standard tier — Cloudflare D1 SQL access (thin typed wrappers, not an ORM).
 *
 * Exposes `query`, `first`, `run`, `batch`, `prepare`, and `deployManifest`.
 * Resolves the D1 binding off the per-request `env` via the bindings plugin.
 * No state, no events, no lifecycle hooks (request-scoped, spec/06 §3).
 *
 * @see README.md
 */
export const d1Plugin = createPlugin("d1", {
  depends: [bindingsPlugin] as const,
  config: defaultConfig,
  // Arrow-wrapped to preserve context inference (spec/15 §5).
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createD1Api(ctx)
});
