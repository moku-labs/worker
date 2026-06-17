/**
 * @file log — Nano-tier CORE plugin skeleton. Structured logging flat-injected as ctx.log.
 * @see README.md
 */
import { createCorePlugin } from "@moku-labs/core";

/** Minimum severity that reaches the console; calls below it are no-ops. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A single retained log entry. */
export type LogEntry = {
  /** Severity at which the entry was recorded. */
  readonly level: LogLevel;
  /** The primary message string. */
  readonly message: string;
  /** Extra positional args passed to the level method. */
  readonly args: readonly unknown[];
  /** Epoch milliseconds when recorded. */
  readonly at: number;
};

/** log core-plugin configuration. */
export type LogConfig = {
  /** Threshold; calls strictly below it are dropped. Default "info". */
  level: LogLevel;
  /** Ring-buffer cap for retained entries; 0 disables buffering. Default 100. */
  bufferSize: number;
};

/** Mutable log state — bounded ring buffer of recent entries, most-recent-last, capped at config.bufferSize. */
export type LogState = { entries: LogEntry[] };

/** The ctx.log surface injected on every regular plugin's context. */
export type LogApi = {
  /** Record a debug-level entry (no-op below threshold). */
  debug(message: string, ...args: unknown[]): void;
  /** Record an info-level entry. */
  info(message: string, ...args: unknown[]): void;
  /** Record a warn-level entry. */
  warn(message: string, ...args: unknown[]): void;
  /** Record an error-level entry (always emitted). */
  error(message: string, ...args: unknown[]): void;
  /** Return a frozen snapshot of the ring buffer, most-recent-last. */
  recent(): readonly LogEntry[];
};

/** Default config — complete so omission never yields undefined (spec/05 §6). */
const defaultLogConfig: LogConfig = { level: "info", bufferSize: 100 };

/**
 * Core·Nano tier — structured logging, flat-injected on every regular plugin as ctx.log.
 *
 * @see README.md
 */
export const logPlugin = createCorePlugin("log", {
  config: defaultLogConfig,
  /**
   * Creates the initial log ring-buffer state.
   *
   * @param _ctx - Core plugin context (unused in skeleton).
   * @example
   * ```ts
   * const state = createState(ctx);
   * ```
   */
  createState(_ctx): LogState {
    throw new Error("not implemented");
  },
  /**
   * Creates the ctx.log API surface (level methods + recent).
   *
   * @param _ctx - Core plugin context (unused in skeleton).
   * @example
   * ```ts
   * const api = logApi(ctx);
   * ```
   */
  api(_ctx): LogApi {
    throw new Error("not implemented");
  }
});
