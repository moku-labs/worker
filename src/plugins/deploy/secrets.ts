/**
 * @file deploy plugin — wrangler-backed Worker-secret helpers for post-deploy steps.
 *
 * The {@link PostDeploySecrets} implementation handed to each registered post-deploy step: `list`
 * wraps `wrangler secret list` (read-only, idempotent — names only, values are never readable) and
 * `putBulk` wraps `wrangler secret bulk` with the JSON payload on stdin (secret values never touch
 * argv or a temp file). Both run against the generated wrangler config, so the targeted worker is
 * exactly the stage-qualified one the pipeline just deployed. Node-only; never imported by the
 * runtime Worker bundle.
 */
import { runWrangler, runWranglerStdin } from "./runner";
import type { PostDeploySecrets } from "./types";

/**
 * Pull the `name` fields out of wrangler's `secret list` output. Wrangler prints a JSON array of
 * `{ name, type }` rows (possibly surrounded by log lines), so the array slice is parsed leniently:
 * anything unparsable yields `[]` — callers treat that as "nothing known to be bound", which at
 * worst re-ensures an already-bound secret (idempotent) rather than crashing the deploy.
 *
 * @param output - The captured `wrangler secret list` stdout.
 * @returns The bound secret names (empty on no secrets or unparsable output).
 * @example
 * ```ts
 * parseSecretNames('[ { "name": "TURN_KEY_ID", "type": "secret_text" } ]'); // ["TURN_KEY_ID"]
 * ```
 */
export const parseSecretNames = (output: string): string[] => {
  // Slice the outermost JSON array out of any surrounding wrangler log lines.
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(row =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as { name?: unknown }).name === "string"
          ? (row as { name: string }).name
          : ""
      )
      .filter(name => name !== "");
  } catch {
    return [];
  }
};

/**
 * Build the {@link PostDeploySecrets} helpers bound to one generated wrangler config file (whose
 * `name` is the stage-qualified worker the pipeline just deployed).
 *
 * @param configFile - The generated wrangler config path (e.g. "wrangler.jsonc").
 * @returns The secrets helpers a post-deploy step receives.
 * @example
 * ```ts
 * const secrets = createPostDeploySecrets(ctx.config.configFile);
 * const names = await secrets.list();
 * ```
 */
export const createPostDeploySecrets = (configFile: string): PostDeploySecrets => ({
  /** @inheritdoc */
  async list(): Promise<string[]> {
    const output = await runWrangler(["secret", "list", "--config", configFile]);
    return parseSecretNames(output);
  },

  /** @inheritdoc */
  async putBulk(values: Record<string, string>): Promise<void> {
    await runWranglerStdin(["secret", "bulk", "--config", configFile], JSON.stringify(values));
  }
});
