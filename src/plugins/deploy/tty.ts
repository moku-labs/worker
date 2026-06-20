/**
 * @file deploy plugin — TTY detection (isolated so the guided flow is testable).
 *
 * The guided deploy only prompts on an interactive terminal; in a pipe or CI it must never block
 * on stdin. Kept in its own module so tests can mock it without stubbing `process.stdout`.
 * Node-only; never imported by the runtime Worker bundle.
 */

/**
 * Whether stdout is an interactive TTY (so prompts are safe to show).
 *
 * @returns True when stdout is a terminal.
 * @example
 * ```ts
 * if (stdoutIsTty()) await prompts.confirm("Deploy?");
 * ```
 */
export const stdoutIsTty = (): boolean => process.stdout.isTTY === true;
