/**
 * @file cli plugin — hook handler factory (the three deploy-event TUI formatters).
 */

import type { LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import type { Config } from "./types";

/**
 * CLI plugin context type for hooks — own config, no state, global events.
 *
 * PluginCtx<C, S, E> surfaces only `config`/`state`/`emit`. The `log` core API
 * is composed in via intersection so `ctx.log.info(...)` type-checks.
 * (spec gap: the spec's handlers.ts Code Example omits this composition — tsc
 * requires it since PluginCtx alone has no `log` field.)
 */
export type CliCtx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /** Injected core log API — `info(event, data?)` where event is the formatted line. */
  readonly log: LogApi;
};

/** The hook map cli registers on the global deploy events. */
export type CliHooks = {
  /** Log one clean line per pipeline phase. */
  "deploy:phase": (payload: WorkerEvents["deploy:phase"]) => void;
  /** Log one clean line per provisioned resource. */
  "provision:resource": (payload: WorkerEvents["provision:resource"]) => void;
  /** Log the terminal success line with the deployed URL. */
  "deploy:complete": (payload: WorkerEvents["deploy:complete"]) => void;
};

/**
 * Builds the hook handlers that turn global deploy events into a live progress TUI.
 * Each logs a clean, prefix-free message via `ctx.log`; the branded log sink (installed
 * by the cli plugin's onInit from `@moku-labs/common/cli`) adds the `›` marker, brand
 * color, and stderr routing. Pure observers — print and return; never mutate state,
 * never block the deploy pipeline (fire-and-forget, spec/07 §3,§4).
 *
 * @param ctx - CLI plugin context with injected log core API.
 * @returns Hook map for the three global deploy events.
 * @example
 * ```ts
 * const hooks = createCliHooks(ctx);
 * hooks["deploy:phase"]({ phase: "detect" }); // logs "detect" → renders "  › detect"
 * hooks["provision:resource"]({ kind: "kv", name: "KV" }); // logs "kv KV" → "  › kv KV"
 * hooks["deploy:complete"]({ url: "https://x.workers.dev" }); // "deployed → https://x.workers.dev"
 * ```
 */
export const createCliHooks = (ctx: CliCtx): CliHooks => ({
  /**
   * Log one clean line per pipeline phase: "phase" or "phase · detail".
   *
   * @param p - The deploy:phase event payload.
   * @example
   * ```ts
   * handler({ phase: "detect" }); // "detect"
   * handler({ phase: "upload", detail: "3 files" }); // "upload · 3 files"
   * ```
   */
  "deploy:phase"(p: WorkerEvents["deploy:phase"]): void {
    ctx.log.info(p.detail ? `${p.phase} · ${p.detail}` : p.phase);
  },

  /**
   * Log one clean line per provisioned resource: "kind name".
   *
   * @param p - The provision:resource event payload.
   * @example
   * ```ts
   * handler({ kind: "kv", name: "KV" }); // "kv KV"
   * ```
   */
  "provision:resource"(p: WorkerEvents["provision:resource"]): void {
    ctx.log.info(`${p.kind} ${p.name}`);
  },

  /**
   * Log the terminal success line with the deployed URL.
   *
   * @param p - The deploy:complete event payload.
   * @example
   * ```ts
   * handler({ url: "https://my-worker.workers.dev" }); // "deployed → https://my-worker.workers.dev"
   * ```
   */
  "deploy:complete"(p: WorkerEvents["deploy:complete"]): void {
    ctx.log.info(`deployed → ${p.url}`);
  }
});
