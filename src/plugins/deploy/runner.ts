/**
 * @file deploy plugin — wrangler subprocess wrapper skeleton (node:child_process).
 */

/**
 * Spawn `wrangler` with the given args and resolve the deployed URL (or "" for non-deploy verbs).
 *
 * @param _args - Wrangler CLI arguments.
 * @example
 * ```ts
 * const url = await runWrangler(["deploy", "--config", "wrangler.jsonc"]);
 * ```
 */
export function runWrangler(_args: string[]): Promise<string> {
  throw new Error("not implemented");
}
