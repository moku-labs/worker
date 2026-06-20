/**
 * @file cli plugin — argv parsing helpers (isolated so they unit-test without a real process).
 *
 * `deploy`/`dev` resolve the target stage from the command line (`--stage dev`) so a consumer never
 * hardcodes it. The dev PORT is not parsed here — it comes only from the `dev()` argument (no hidden
 * argv/config resolution). Pure: takes an argv array, reads no globals. Node-only tooling.
 */

/**
 * Extract a `--stage` value from a single token (and the token after it, for the spaced form).
 *
 * @param token - The current argv token.
 * @param next - The following argv token (the value, for the `--stage dev` spaced form).
 * @returns The raw string value when this token is a stage flag, else undefined.
 * @example
 * ```ts
 * stageValueFrom("--stage=dev", undefined); // "dev"
 * stageValueFrom("--stage", "dev");         // "dev"
 * stageValueFrom("--other", "x");           // undefined
 * ```
 */
const stageValueFrom = (token: string, next: string | undefined): string | undefined => {
  const inline = /^--stage=(.+)$/u.exec(token);
  if (inline) return inline[1];
  if (token === "--stage") return next;
  return undefined;
};

/**
 * Parse a `--stage <name>` / `--stage=<name>` flag out of an argv array — the deploy/dev stage that
 * drives the resource-name suffix (e.g. `tracker-db-dev`). Returns the first non-empty value, or
 * undefined so the caller can fall back to the app's configured stage.
 *
 * @param argv - The argv array to scan (the caller passes the process argv).
 * @returns The parsed stage string, or undefined when no `--stage` flag is present.
 * @example
 * ```ts
 * parseStageArg(["bun", "scripts/deploy.ts", "--stage", "dev"]); // "dev"
 * parseStageArg(["bun", "scripts/deploy.ts"]);                    // undefined
 * ```
 */
export const parseStageArg = (argv: readonly string[]): string | undefined => {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;

    const raw = stageValueFrom(token, argv[index + 1]);
    if (raw !== undefined && raw.length > 0) return raw;
  }
  return undefined;
};
