/**
 * log — Nano-tier CORE plugin.
 *
 * Structured logging for `@moku-labs/worker`. Flat-injected as `ctx.log` on every
 * regular plugin's context (spec/02 §6). No depends / events / hooks — pure infrastructure.
 *
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimum severity that reaches the console; calls below it are no-ops.
 *
 * Order (low → high): `"debug"` < `"info"` < `"warn"` < `"error"`.
 *
 * @example
 * ```typescript
 * const level: LogLevel = "warn";
 * ```
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * A single retained log entry in the ring buffer.
 *
 * @example
 * ```typescript
 * const entry: LogEntry = { level: "warn", message: "binding missing", args: [{ name: "DB" }], at: Date.now() };
 * ```
 */
export type LogEntry = {
  /** Severity at which the entry was recorded. */
  readonly level: LogLevel;
  /** The primary message string. */
  readonly message: string;
  /** Extra positional args passed to the level method (structured payloads). */
  readonly args: readonly unknown[];
  /** Epoch milliseconds when recorded (`Date.now()`). */
  readonly at: number;
};

/**
 * log core-plugin configuration. Complete defaults prevent `undefined` at runtime (spec/05 §6).
 *
 * @example
 * ```typescript
 * // Override via createApp pluginConfigs:
 * createApp({ pluginConfigs: { log: { level: "debug", bufferSize: 50 } } });
 * ```
 */
export type LogConfig = {
  /**
   * Threshold; calls strictly below this level are dropped.
   * Order: `"debug"` < `"info"` < `"warn"` < `"error"`.
   *
   * @default "info"
   */
  level: LogLevel;
  /**
   * Ring-buffer cap for retained entries in `state.entries`.
   * Oldest entries are shifted off when length exceeds this. Set `0` to disable.
   *
   * @default 100
   */
  bufferSize: number;
};

/**
 * Mutable log state — a bounded ring buffer of recent entries.
 *
 * @example
 * ```typescript
 * const state: LogState = { entries: [] };
 * ```
 */
export type LogState = {
  /** Most-recent-last entries, capped at `config.bufferSize`. */
  entries: LogEntry[];
};

/**
 * The `ctx.log` surface flat-injected on every regular plugin's context (spec/02 §6).
 *
 * @example
 * ```typescript
 * // Inside any regular plugin:
 * api: (ctx) => ({
 *   handle: (req: Request) => {
 *     ctx.log.info("incoming", { method: req.method });
 *   },
 * });
 * ```
 */
export type LogApi = {
  /**
   * Record a `debug`-level entry. No-op when `config.level` is above `"debug"`.
   *
   * @param message - Primary log message.
   * @param args - Optional structured payloads forwarded to `console.debug`.
   */
  debug(message: string, ...args: unknown[]): void;
  /**
   * Record an `info`-level entry. Emitted at the default `"info"` level.
   *
   * @param message - Primary log message.
   * @param args - Optional structured payloads forwarded to `console.info`.
   */
  info(message: string, ...args: unknown[]): void;
  /**
   * Record a `warn`-level entry. Emitted unless `config.level` is `"error"`.
   *
   * @param message - Primary log message.
   * @param args - Optional structured payloads forwarded to `console.warn`.
   */
  warn(message: string, ...args: unknown[]): void;
  /**
   * Record an `error`-level entry. Always emitted (highest severity).
   *
   * @param message - Primary log message.
   * @param args - Optional structured payloads forwarded to `console.error`.
   */
  error(message: string, ...args: unknown[]): void;
  /**
   * Return a frozen snapshot of the ring buffer, most-recent-last.
   *
   * @returns Readonly frozen copy of `state.entries`. Mutations do not affect the live buffer.
   */
  recent(): readonly LogEntry[];
};

// ─── Private constants ────────────────────────────────────────────────────────

/** Numeric severity ranks for level gating. A call is emitted iff `RANK[callLevel] >= RANK[config.level]`. */
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Console dispatch map keyed by log level. `console.info`, `warn`, and `error`
 * are in biome's `noConsole` allow list; only `debug` needs a suppression.
 * Private implementation detail; JSDoc not required on object method values.
 */
/* eslint-disable jsdoc/require-jsdoc */
const CONSOLE: Record<LogLevel, (message: string, ...args: unknown[]) => void> = {
  // biome-ignore lint/suspicious/noConsole: console.debug not in allow list
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args)
};
/* eslint-enable jsdoc/require-jsdoc */

/** Matches `CorePluginContext<LogConfig, LogState>` exactly. Used by `createLogApi`. */
type LogCtx = {
  readonly config: Readonly<LogConfig>;
  state: LogState;
};

// ─── API factory ──────────────────────────────────────────────────────────────

/**
 * Creates the `ctx.log` API object for the log core plugin.
 *
 * Each level method gates emission via the `RANK` map, dispatches to the matching
 * console function, and pushes a `LogEntry` into the ring buffer. `recent()` returns
 * a frozen spread copy of the current buffer.
 *
 * @param ctx - Core plugin context with `config` (frozen) and `state` (mutable ring buffer).
 * @returns The `LogApi` object: `debug` / `info` / `warn` / `error` / `recent`.
 * @example
 * ```typescript
 * // Used internally by logPlugin — not called directly.
 * const api = createLogApi({ config: defaultLogConfig, state: { entries: [] } });
 * api.info("hello", { key: "value" });
 * ```
 */
export function createLogApi(ctx: LogCtx): LogApi {
  // eslint-disable-next-line jsdoc/require-jsdoc
  function record(level: LogLevel, message: string, args: unknown[]): void {
    if (RANK[level] < RANK[ctx.config.level]) return;
    CONSOLE[level](message, ...args);
    if (ctx.config.bufferSize <= 0) return;
    ctx.state.entries.push({ level, message, args, at: Date.now() });
    if (ctx.state.entries.length > ctx.config.bufferSize) {
      ctx.state.entries.shift();
    }
  }

  return {
    /**
     * Record a `debug`-level entry. No-op when `config.level` is above `"debug"`.
     *
     * @param message - Primary log message.
     * @param args - Optional structured payloads forwarded to `console.debug`.
     * @example
     * ```typescript
     * ctx.log.debug("matching endpoint", { url });
     * ```
     */
    debug: (message: string, ...args: unknown[]): void => {
      record("debug", message, args);
    },
    /**
     * Record an `info`-level entry. Emitted at the default `"info"` level.
     *
     * @param message - Primary log message.
     * @param args - Optional structured payloads forwarded to `console.info`.
     * @example
     * ```typescript
     * ctx.log.info("deploy done", { url: p.url });
     * ```
     */
    info: (message: string, ...args: unknown[]): void => {
      record("info", message, args);
    },
    /**
     * Record a `warn`-level entry. Emitted unless `config.level` is `"error"`.
     *
     * @param message - Primary log message.
     * @param args - Optional structured payloads forwarded to `console.warn`.
     * @example
     * ```typescript
     * ctx.log.warn("binding missing", { name });
     * ```
     */
    warn: (message: string, ...args: unknown[]): void => {
      record("warn", message, args);
    },
    /**
     * Record an `error`-level entry. Always emitted (highest severity).
     *
     * @param message - Primary log message.
     * @param args - Optional structured payloads forwarded to `console.error`.
     * @example
     * ```typescript
     * ctx.log.error("queue handler failed", { error: String(e) });
     * ```
     */
    error: (message: string, ...args: unknown[]): void => {
      record("error", message, args);
    },
    /**
     * Return a frozen spread copy of the ring buffer, most-recent-last.
     *
     * @returns A frozen copy of `state.entries`. Mutations do not affect the live buffer.
     * @example
     * ```typescript
     * const last = ctx.log.recent().at(-1);
     * expect(last?.message).toBe("deploy done");
     * ```
     */
    recent: (): readonly LogEntry[] => Object.freeze([...ctx.state.entries])
  };
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

/** Default log configuration — complete so omission never yields `undefined` (spec/05 §6). */
export const defaultLogConfig: LogConfig = { level: "info", bufferSize: 100 };

/**
 * log core plugin — Nano tier.
 *
 * Registers as `logPlugin` in `src/config.ts` alongside `envPlugin`.
 * After registration, `ctx.log` is typed and available on every regular plugin's context.
 *
 * @example
 * ```typescript
 * // In a regular plugin api factory:
 * api: (ctx) => ({
 *   handle: (req: Request) => { ctx.log.info("request", { method: req.method }); },
 * });
 * ```
 */
export const logPlugin = createCorePlugin("log", {
  config: defaultLogConfig,

  /**
   * Creates the initial empty ring-buffer state.
   *
   * @returns An empty `LogState` with no entries.
   * @example
   * ```typescript
   * const state = createState({ config: defaultLogConfig });
   * // => { entries: [] }
   * ```
   */
  createState: (): LogState => ({ entries: [] }),

  /**
   * Builds the `ctx.log` API surface injected on every regular plugin.
   *
   * @param ctx - Core plugin context: `{ config: LogConfig; state: LogState }`.
   * @returns The `LogApi` object: `debug` / `info` / `warn` / `error` / `recent`.
   * @example
   * ```typescript
   * ctx.log.warn("binding missing", { name });
   * const last = ctx.log.recent().at(-1);
   * ```
   */
  api: createLogApi
});
