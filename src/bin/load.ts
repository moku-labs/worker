/**
 * @file moku-worker bin — consumer app discovery (moku.config convention).
 *
 * Resolves and imports the consumer's app config so the bin can dispatch onto app.cli.*.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { CliApp } from "./dispatch";

/** Default config filename (also the one named in the not-found error). */
const DEFAULT_CONFIG = "moku.config.ts";

/** Candidate config filenames, in resolution order. */
const CANDIDATES = [DEFAULT_CONFIG, "moku.config.js", "moku.config.mjs"];

/**
 * Resolve the path to the consumer's app config. An explicit path wins; otherwise the first
 * existing moku.config.{ts,js,mjs} in cwd; otherwise the default (so the error names a real file).
 *
 * @param cwd - The working directory to resolve against.
 * @param explicit - An explicit --config path, when provided.
 * @returns The resolved absolute config path.
 * @example
 * ```ts
 * resolveConfigPath(process.cwd()); // "/abs/moku.config.ts"
 * ```
 */
export const resolveConfigPath = (cwd: string, explicit?: string): string => {
  if (explicit !== undefined) return path.resolve(cwd, explicit);
  const found = CANDIDATES.map(name => path.resolve(cwd, name)).find(candidate =>
    existsSync(candidate)
  );
  return found ?? path.resolve(cwd, DEFAULT_CONFIG);
};

/**
 * Import the consumer's app config and return its app (default export or `app` export).
 *
 * @param configPath - The resolved config path.
 * @returns The consumer app exposing app.cli.*.
 * @throws {Error} When the module does not export an app with a cli surface.
 * @example
 * ```ts
 * const app = await loadApp(resolveConfigPath(process.cwd()));
 * ```
 */
export const loadApp = async (configPath: string): Promise<CliApp> => {
  const imported = (await import(pathToFileURL(configPath).href)) as {
    default?: CliApp;
    app?: CliApp;
  };
  const app = imported.default ?? imported.app;
  if (app?.cli === undefined) {
    throw new Error(
      `[moku-worker] ${configPath} must export an app (default export or \`app\`) created with createApp + cliPlugin.`
    );
  }
  return app;
};
