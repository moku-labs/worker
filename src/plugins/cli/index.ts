/**
 * cli plugin — Standard tier (node-only).
 *
 * Developer-facing CLI surface: `app.cli.dev()` / `app.cli.deploy()`, both thin
 * passthroughs to the deploy plugin. Subscribes to the GLOBAL deploy:phase / dev:* /
 * deploy:complete events to print a live progress TUI via ctx.log (the infra plan + per-resource
 * result are branded panels rendered by the deploy plugin). Emits no events of its own. Excluded
 * from the ./worker runtime bundle (HC11).
 *
 * @see README.md
 */
import { brandedSink } from "@moku-labs/common/cli";
import { createPlugin } from "../../config";
import { deployPlugin } from "../deploy";
import { createCliApi } from "./api";
import { createCliHooks } from "./handlers";
import type { Config } from "./types";

// Typed const ABOVE the factory — no inline `as` in config (R6; spec/11 §Part 2).
const defaultConfig: Config = { port: 8787 };

/**
 * Standard tier (node-only) — developer-facing CLI surface.
 *
 * Mounts `app.cli.dev()` and `app.cli.deploy()` as thin passthroughs to deployPlugin.
 * Hooks subscribe to the global deploy:phase / provision:resource / deploy:complete events
 * and print a live progress TUI via the injected ctx.log core API.
 *
 * Inline lambdas on `api`/`hooks` preserve event-name inference so the hook map keys
 * are constrained to `WorkerEvents` keys (spec/15 §5).
 *
 * @see README.md
 */
export const cliPlugin = createPlugin("cli", {
  depends: [deployPlugin] as const,
  config: defaultConfig,
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural lifecycle wiring: the deploy TUI is ALWAYS branded — swap the default object log sink for the branded one (node-only; excluded from the runtime bundle).
  onInit: ctx => {
    ctx.log.clearSinks();
    ctx.log.addSink(brandedSink("info"));
  },
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural api wiring (contextual typing)
  api: ctx => createCliApi(ctx),
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural hooks wiring (contextual typing)
  hooks: ctx => createCliHooks(ctx)
});

export type { Config } from "./types";
