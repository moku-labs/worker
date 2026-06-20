/**
 * @file cli plugin — argv parsing helpers (isolated so they unit-test without a real process).
 *
 * `dev` resolves its port from the command line (`bun scripts/dev.ts --port 3000`) so a consumer
 * never hardcodes it in the app. Pure: takes an argv array, reads no globals. Node-only tooling.
 */

/** The valid TCP port range a `--port` value must fall within to be accepted. */
const MAX_PORT = 65_535;

/**
 * Extract a `--port`/`-p` value from a single token (and the token after it, for the spaced form).
 *
 * @param token - The current argv token.
 * @param next - The following argv token (the value, for the `--port 3000` spaced form).
 * @returns The raw string value when this token is a port flag, else undefined.
 * @example
 * ```ts
 * portValueFrom("--port=3000", undefined); // "3000"
 * portValueFrom("--port", "3000");         // "3000"
 * portValueFrom("--config", "x");          // undefined
 * ```
 */
const portValueFrom = (token: string, next: string | undefined): string | undefined => {
  const inline = /^(?:--port|-p)=(.+)$/u.exec(token);
  if (inline) return inline[1];
  if (token === "--port" || token === "-p") return next;
  return undefined;
};

/**
 * Parse a `--port <n>` / `--port=<n>` / `-p <n>` flag out of an argv array.
 *
 * Returns the first valid port (a positive integer ≤ 65535) found, or undefined when the flag is
 * absent or its value is not a usable port — letting the caller fall back to a default.
 *
 * @param argv - The argv array to scan (the caller passes the process argv).
 * @returns The parsed port number, or undefined when no valid `--port`/`-p` flag is present.
 * @example
 * ```ts
 * parsePortArg(["bun", "scripts/dev.ts", "--port", "3000"]); // 3000
 * parsePortArg(["bun", "scripts/dev.ts", "--port=3000"]);    // 3000
 * parsePortArg(["bun", "scripts/dev.ts"]);                   // undefined
 * ```
 */
export const parsePortArg = (argv: readonly string[]): number | undefined => {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;

    const raw = portValueFrom(token, argv[index + 1]);
    if (raw === undefined) continue;

    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port <= MAX_PORT) return port;
  }
  return undefined;
};
