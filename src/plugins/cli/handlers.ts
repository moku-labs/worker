/**
 * @file cli plugin — hook handler factory (the three deploy-event TUI formatters).
 */

import type { LogApi } from "@moku-labs/common";
import { createBrandConsole } from "@moku-labs/common/cli";
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";
import type { Config } from "./types";

/** Divider drawn before the native `wrangler dev` TUI so the moku preamble reads as one section. */
const WRANGLER_DIVIDER = `  ── wrangler ${"─".repeat(48)}`;

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
  /** Log the infra preflight summary (existing vs to-create, in account). */
  "provision:plan": (payload: WorkerEvents["provision:plan"]) => void;
  /** Log one clean line per provisioned resource. */
  "provision:resource": (payload: WorkerEvents["provision:resource"]) => void;
  /** Log one clean line per already-existing resource (skipped). */
  "provision:skip": (payload: WorkerEvents["provision:skip"]) => void;
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
 * @returns Hook map for the three global deploy events.
 * @example
 * ```ts
 * const hooks = createCliHooks(ctx);
 * hooks["deploy:phase"]({ phase: "detect" }); // logs "detect" → renders "  › detect"
 * hooks["provision:resource"]({ kind: "kv", name: "KV" }); // logs "kv KV" → "  › kv KV"
 * hooks["deploy:complete"]({ url: "https://x.workers.dev" }); // "deployed → https://x.workers.dev"
 * ```
 */
export const createCliHooks = (ctx: CliCtx): CliHooks => {
  // Direct branded renderer for the dev-session boundary: the `›` phase lines stream via ctx.log
  // (the branded sink), while the divider that brackets the native wrangler TUI is drawn to stdout
  // — the same split the auth/doctor verbs use.
  const ui = createBrandConsole();

  return {
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
     * Log the infra preflight summary: "infra · N exist, M to create · account".
     *
     * @param p - The provision:plan event payload.
     * @example
     * ```ts
     * handler({ exists: 2, missing: 1, account: "Play Co" }); // "infra · 2 exist, 1 to create · Play Co"
     * ```
     */
    "provision:plan"(p: WorkerEvents["provision:plan"]): void {
      ctx.log.info(`infra · ${p.exists} exist, ${p.missing} to create · ${p.account}`);
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
     * Log one clean line per already-existing resource (skipped): "kind name (exists)".
     *
     * @param p - The provision:skip event payload.
     * @example
     * ```ts
     * handler({ kind: "kv", name: "KV" }); // "kv KV (exists)"
     * ```
     */
    "provision:skip"(p: WorkerEvents["provision:skip"]): void {
      ctx.log.info(`${p.kind} ${p.name} (exists)`);
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
      ctx.log.info(`deployed → ${p.url}`);
    }
  };
};
