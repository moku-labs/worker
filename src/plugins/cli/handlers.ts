/**
 * @file cli plugin — hook handler factory (the deploy/dev-event TUI formatters).
 */

import type { LogApi } from "@moku-labs/common";
import { createBrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import type { Config } from "./types";

/** Divider drawn before the native `wrangler dev` TUI so the moku preamble reads as one section. */
const WRANGLER_DIVIDER = `  ── wrangler ${"─".repeat(48)}`;

/** Deploy phases that are a slow, opaque wait (captured output) — worth a live spinner on a TTY. */
const SPINNER_PHASES = new Set(["upload", "deploy"]);
/** Braille spinner glyphs; advance one per tick. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Spinner tick interval (ms). */
const SPINNER_TICK_MS = 80;
/** Carriage-return + blanks + carriage-return that wipes the transient spinner line before settling. */
const SPINNER_CLEAR = `\r${" ".repeat(72)}\r`;

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

/**
 * The hook map cli registers on the global deploy events. The infra plan + per-resource result are
 * NOT here — the deploy plugin renders those as branded panels (see infra/render.ts), so the
 * provision:plan / provision:resource / provision:skip events stay available to consumers without
 * the cli drawing duplicate flat lines under the panels.
 */
export type CliHooks = {
  /** Log one clean line per pipeline phase. */
  "deploy:phase": (payload: WorkerEvents["deploy:phase"]) => void;
  /** Log one clean line per dev-session phase (build / serve / rebuild / …). */
  "dev:phase": (payload: WorkerEvents["dev:phase"]) => void;
  /** Log the per-change site rebuild result. */
  "dev:rebuilt": (payload: WorkerEvents["dev:rebuilt"]) => void;
  /** Log a non-fatal dev build failure (the session keeps serving). */
  "dev:error": (payload: WorkerEvents["dev:error"]) => void;
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
 * @returns Hook map for the deploy/dev phase + completion events (provision detail is panel-rendered).
 * @example
 * ```ts
 * const hooks = createCliHooks(ctx);
 * hooks["deploy:phase"]({ phase: "detect" }); // logs "detect" → renders "  › detect"
 * hooks["dev:phase"]({ phase: "serve", detail: "http://localhost:8787" }); // "serve · …"
 * hooks["deploy:complete"]({ url: "https://x.workers.dev" }); // "deployed → https://x.workers.dev"
 * ```
 */
export const createCliHooks = (ctx: CliCtx): CliHooks => {
  // Direct branded renderer for the dev-session boundary: the `›` phase lines stream via ctx.log
  // (the branded sink), while the divider that brackets the native wrangler TUI is drawn to stdout
  // — the same split the auth/doctor verbs use.
  const ui = createBrandConsole();
  const { palette } = ui;

  // ── Live deploy spinner (TTY only) ───────────────────────────────────────────────────────────
  // A slow, opaque deploy wait — the R2 upload, the captured `wrangler deploy` — shows a branded
  // braille spinner so it never looks frozen. Off a TTY (CI / pipes) the spinner stays silent and
  // the phase prints as a plain `ctx.log` line (the prior behavior), so piped logs stay clean.
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerLabel: string | undefined;

  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const stopSpinner = (): void => {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    if (spinnerLabel !== undefined) {
      process.stdout.write(SPINNER_CLEAR);
      ctx.log.info(spinnerLabel); // settle the finished phase as a permanent line
      spinnerLabel = undefined;
    }
  };

  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const startSpinner = (label: string): void => {
    spinnerLabel = label;
    let frame = 0;
    const text = `${label} …`;
    spinnerTimer = setInterval(() => {
      const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
      frame += 1;
      process.stdout.write(`\r  ${palette.pink(glyph)} ${palette.dim(text)}`);
    }, SPINNER_TICK_MS);
  };

  return {
    /**
     * Render one pipeline phase. Quick phases print a clean line ("phase" / "phase · detail"); the
     * slow opaque waits (upload / deploy) animate a branded spinner on a TTY, settling to a line when
     * the next phase or completion arrives. Off a TTY every phase is a plain line (unchanged).
     *
     * @param p - The deploy:phase event payload.
     * @example
     * ```ts
     * handler({ phase: "detect" }); // "detect"
     * handler({ phase: "deploy" }); // spins on a TTY, else "deploy"
     * ```
     */
    "deploy:phase"(p: WorkerEvents["deploy:phase"]): void {
      stopSpinner(); // settle any prior slow-phase spinner first
      const label = p.detail ? `${p.phase} · ${p.detail}` : p.phase;
      if (process.stdout.isTTY === true && SPINNER_PHASES.has(p.phase)) {
        startSpinner(label);
      } else {
        ctx.log.info(label);
      }
    },

    /**
     * Log one dev-session phase: "phase" or "phase · detail".
     *
     * @param p - The dev:phase event payload.
     * @example
     * ```ts
     * handler({ phase: "serve", detail: "http://localhost:8787" }); // "serve · http://localhost:8787"
     * ```
     */
    "dev:phase"(p: WorkerEvents["dev:phase"]): void {
      ctx.log.info(p.detail ? `${p.phase} · ${p.detail}` : p.phase);
      // `serve` is the last moku line before wrangler takes over the terminal — draw a divider so the
      // native wrangler TUI reads as a bracketed section under the moku preamble.
      if (p.phase === "serve") ui.line(WRANGLER_DIVIDER);
    },

    /**
     * Log the site rebuild result: "site <n> files · <ms>ms" (omits the count when unknown).
     *
     * @param p - The dev:rebuilt event payload.
     * @example
     * ```ts
     * handler({ files: 12, ms: 240 }); // "site 12 files · 240ms"
     * handler({ files: 0, ms: 240 }); // "site · 240ms"
     * ```
     */
    "dev:rebuilt"(p: WorkerEvents["dev:rebuilt"]): void {
      ctx.log.info(
        p.files > 0
          ? `site ${String(p.files)} files · ${String(p.ms)}ms`
          : `site · ${String(p.ms)}ms`
      );
    },

    /**
     * Log a non-fatal dev build failure via warn (the session keeps serving the last good build).
     *
     * @param p - The dev:error event payload.
     * @example
     * ```ts
     * handler({ message: "build failed" }); // warn "build failed"
     * ```
     */
    "dev:error"(p: WorkerEvents["dev:error"]): void {
      ctx.log.warn(p.message);
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
      stopSpinner(); // settle the final deploy spinner
      ctx.log.info(`deployed → ${p.url}`);
    }
  };
};
