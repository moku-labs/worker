/**
 * @file cli plugin — hook handler factory skeleton (the three deploy-event TUI formatters).
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import type { Config } from "./types";

/** cli context — own config, no state, global events. */
type CliCtx = PluginCtx<Config, Record<string, never>, WorkerEvents>;

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
 * via ctx.log. Pure observers — print and return; never mutate state.
 *
 * @param _ctx - Plugin context (with the injected ctx.log core api).
 * @example
 * ```ts
 * const hooks = createCliHooks(ctx);
 * ```
 */
export function createCliHooks(_ctx: CliCtx): CliHooks {
  throw new Error("not implemented");
}
