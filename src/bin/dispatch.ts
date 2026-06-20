/**
 * @file moku-worker bin — argv parsing + dispatch (pure, testable).
 *
 * Maps a parsed command line onto the consumer app's `app.cli.*` surface. Holds NO business logic
 * — every behavior lives behind app.cli.*, so `scripts/*.ts` passthroughs remain valid (this is
 * how SPEC BOUNDARY #3 is lifted "by addition"). Node-only; never in the runtime Worker bundle.
 */

/** The cli surface the bin dispatches onto (a structural subset of app.cli). */
export type CliApp = {
  readonly cli: {
    dev(opts?: { port?: number }): Promise<void>;
    deploy(opts?: { guided?: boolean; yes?: boolean }): Promise<void>;
    auth(sub?: "setup"): Promise<void>;
    doctor(): Promise<void>;
    whoami(): Promise<void>;
    wrangler(args: string[]): Promise<void>;
  };
};

/** The branded command tree printed by `moku-worker help` / `--help`. */
export const HELP = [
  "moku-worker <command>",
  "",
  "  dev [--port <n>]      watch + recompile the site, run locally (wrangler dev)",
  "  deploy [--yes]        guided, infra-aware deploy (--yes / --ci to skip prompts)",
  "  auth [setup]          verify the .env token, or print the token to create",
  "  doctor                token + account + infra-drift report",
  "  whoami                show the resolved Cloudflare account",
  "  wrangler <args…>      run any wrangler command through the branded CLI",
  "  help                  show this help"
].join("\n");

/**
 * Parse argv (after the node binary + script) into a verb + its remaining tokens.
 *
 * @param argv - process.argv.slice(2).
 * @returns The verb (default "help") and the remaining tokens.
 * @example
 * ```ts
 * parseArgv(["dev", "--port", "3000"]); // { verb: "dev", rest: ["--port", "3000"] }
 * ```
 */
export const parseArgv = (argv: string[]): { verb: string; rest: string[] } => {
  const [verb, ...rest] = argv;
  return { verb: verb ?? "help", rest };
};

/**
 * Read a `--port <n>` flag from the remaining tokens.
 *
 * @param rest - The tokens after the verb.
 * @returns The parsed port number, or undefined when absent.
 * @example
 * ```ts
 * portFlag(["--port", "3000"]); // 3000
 * ```
 */
const portFlag = (rest: string[]): number | undefined => {
  const index = rest.indexOf("--port");
  if (index === -1) return undefined;
  const value = rest[index + 1];
  return value === undefined ? undefined : Number(value);
};

/**
 * Dispatch a parsed command onto the app's cli surface. Returns help text for help / unknown
 * commands (the caller prints it); returns undefined when a verb was handled.
 *
 * @param app - The consumer app (structural app.cli surface).
 * @param verb - The command verb.
 * @param rest - The tokens after the verb.
 * @returns Help/error text for help/unknown verbs, else undefined.
 * @example
 * ```ts
 * await dispatch(app, "deploy", ["--yes"]); // app.cli.deploy({ yes: true })
 * ```
 */
export const dispatch = async (
  app: CliApp,
  verb: string,
  rest: string[]
): Promise<string | undefined> => {
  switch (verb) {
    case "dev": {
      const port = portFlag(rest);
      await app.cli.dev(port === undefined ? undefined : { port });
      return undefined;
    }
    case "deploy": {
      const yes = rest.includes("--yes") || rest.includes("--ci");
      await app.cli.deploy(yes ? { yes: true } : { guided: true });
      return undefined;
    }
    case "auth": {
      await app.cli.auth(rest[0] === "setup" ? "setup" : undefined);
      return undefined;
    }
    case "doctor": {
      await app.cli.doctor();
      return undefined;
    }
    case "whoami": {
      await app.cli.whoami();
      return undefined;
    }
    case "wrangler": {
      await app.cli.wrangler(rest);
      return undefined;
    }
    case "help":
    case "--help":
    case "-h": {
      return HELP;
    }
    default: {
      return `Unknown command: ${verb}\n\n${HELP}`;
    }
  }
};
