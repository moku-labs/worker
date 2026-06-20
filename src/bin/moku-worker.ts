#!/usr/bin/env node
/**
 * @file moku-worker bin — the unified Moku CLI front door.
 *
 * A THIN argv dispatcher: resolve the consumer's `moku.config` app, then dispatch onto app.cli.*.
 * Holds no business logic (all behavior is behind app.cli.*), so `scripts/*.ts` passthroughs
 * remain valid — this is how SPEC BOUNDARY #3 is lifted "by addition". Run via `bun` for a `.ts`
 * config. Node-only; never imported by the runtime Worker bundle.
 */
import { createBrandConsole } from "@moku-labs/common/cli";

import { dispatch, HELP, parseArgv } from "./dispatch";
import { loadApp, resolveConfigPath } from "./load";

/**
 * Read a `--config <path>` flag from argv.
 *
 * @param argv - The raw argv tokens (after node + script).
 * @returns The explicit config path, or undefined.
 * @example
 * ```ts
 * configFlag(["deploy", "--config", "x.ts"]); // "x.ts"
 * ```
 */
const configFlag = (argv: string[]): string | undefined => {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
};

/**
 * Run the bin: parse argv, (load the app unless help), dispatch onto app.cli.*.
 *
 * @returns Resolves once the command completes.
 * @example
 * ```ts
 * await main();
 * ```
 */
const main = async (): Promise<void> => {
  const ui = createBrandConsole();
  const argv = process.argv.slice(2);
  const { verb, rest } = parseArgv(argv);

  // Help never needs the consumer app.
  if (verb === "help" || verb === "--help" || verb === "-h") {
    ui.line(HELP);
    return;
  }

  const app = await loadApp(resolveConfigPath(process.cwd(), configFlag(argv)));
  const message = await dispatch(app, verb, rest);
  if (message !== undefined) {
    ui.line(message);
    process.exitCode = 1; // unknown command
  }
};

// eslint-disable-next-line unicorn/prefer-top-level-await -- the bin is also built as CJS, where top-level await is invalid
main().catch((error: unknown) => {
  createBrandConsole().error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
