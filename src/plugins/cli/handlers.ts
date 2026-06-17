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
  /** Print one line per pipeline phase. */
  "deploy:phase": (payload: WorkerEvents["deploy:phase"]) => void;
  /** Print one indented line per provisioned resource. */
  "provision:resource": (payload: WorkerEvents["provision:resource"]) => void;
  /** Print the terminal success line with the deployed URL. */
  "deploy:complete": (payload: WorkerEvents["deploy:complete"]) => void;
};

/**
 * Builds the hook handlers that turn global deploy events into a live progress TUI
 * via ctx.log. Pure observers — print and return; never mutate state, never block
 * the deploy pipeline (fire-and-forget, spec/07 §3,§4).
 *
 * @param ctx - CLI plugin context with injected log core API.
 * @returns Hook map for the three global deploy events.
 * @example
 * ```ts
 * const hooks = createCliHooks(ctx);
 * hooks["deploy:phase"]({ phase: "detect" }); // logs "> detect"
 * hooks["provision:resource"]({ kind: "kv", name: "KV" }); // logs "  + kv KV"
 * hooks["deploy:complete"]({ url: "https://x.workers.dev" }); // logs "done -> https://x.workers.dev"
 * ```
 */
export const createCliHooks = (ctx: CliCtx): CliHooks => ({
  /**
   * Print one line per pipeline phase: "> phase" or "> phase - detail".
   *
   * @param p - The deploy:phase event payload.
   * @example
   * ```ts
   * handler({ phase: "detect" }); // "> detect"
   * handler({ phase: "upload", detail: "3 files" }); // "> upload - 3 files"
   * ```
   */
  "deploy:phase"(p: WorkerEvents["deploy:phase"]): void {
    const detail = p.detail ? ` - ${p.detail}` : "";
    ctx.log.info(`> ${p.phase}${detail}`);
  },

  /**
   * Print one indented line per provisioned resource: "  + kind name".
   *
   * @param p - The provision:resource event payload.
   * @example
   * ```ts
   * handler({ kind: "kv", name: "KV" }); // "  + kv KV"
   * ```
   */
  "provision:resource"(p: WorkerEvents["provision:resource"]): void {
    ctx.log.info(`  + ${p.kind} ${p.name}`);
  },

  /**
   * Print the terminal success line with the deployed URL.
   *
   * @param p - The deploy:complete event payload.
   * @example
   * ```ts
   * handler({ url: "https://my-worker.workers.dev" }); // "done -> https://my-worker.workers.dev"
   * ```
   */
  "deploy:complete"(p: WorkerEvents["deploy:complete"]): void {
    ctx.log.info(`done -> ${p.url}`);
  }
});
