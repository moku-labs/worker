/**
 * @file cli plugin — type definitions (Config, Api).
 */

import type { WebBuild } from "../deploy/types";

/** Resolved configuration for the cli plugin. Flat; complete defaults so omission never yields undefined. */
export type Config = {
  /**
   * Default local dev port forwarded to deploy.dev when dev() gets no port.
   * Passed through to `wrangler dev --port <n>`.
   *
   * @default 8787
   */
  readonly port: number;
};

/** Public api surface of the cli plugin, mounted at app.cli.*. */
export type Api = {
  /**
   * Run the Worker locally via Wrangler (delegates to deploy.dev).
   * Defaults port to the configured value (8787) when called with no opts.
   *
   * @param opts - Optional port override and web build hook.
   * @param opts.port - Local dev port to bind.
   * @param opts.webBuild - Rebuild the web site on change (e.g. `() => webApp.cli.build()`).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.cli.dev();                               // port 8787, worker only
   * await app.cli.dev({ webBuild: () => web.cli.build() }); // wire the web build in
   * ```
   */
  dev(opts?: { port?: number; webBuild?: WebBuild }): Promise<void>;

  /**
   * One-command guided Cloudflare deploy (delegates to deploy.run).
   * Forwards opts verbatim — passes undefined when called with no opts.
   *
   * @param opts - Optional guided/yes flags and a web build hook.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive).
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await app.cli.deploy({ guided: true, webBuild: () => web.cli.build() });
   * await app.cli.deploy({ yes: true }); // CI
   * await app.cli.deploy(); // no opts → undefined forwarded
   * ```
   */
  deploy(opts?: { guided?: boolean; yes?: boolean; webBuild?: WebBuild }): Promise<void>;

  /**
   * Verify the `.env` Cloudflare token (no sub), or print the config-derived token-creation
   * guidance (`"setup"`). Delegates to deploy.verifyAuth() / deploy.tokenInstructions().
   *
   * @param sub - Pass "setup" to print token guidance; omit to verify the current token.
   * @returns Resolves once the auth check or guidance render completes.
   * @example
   * ```ts
   * await app.cli.auth();        // verify the current token
   * await app.cli.auth("setup"); // print what token to create
   * ```
   */
  auth(sub?: "setup"): Promise<void>;

  /**
   * One-shot preflight report: token + account (verifyAuth) and infra drift (checkInfra),
   * each rendered as a branded check line.
   *
   * @returns Resolves once the report is printed.
   * @example
   * ```ts
   * await app.cli.doctor();
   * ```
   */
  doctor(): Promise<void>;

  /**
   * Print the resolved Cloudflare account for the current `.env` token (delegates to verifyAuth).
   *
   * @returns Resolves once the account summary is printed.
   * @example
   * ```ts
   * await app.cli.whoami();
   * ```
   */
  whoami(): Promise<void>;

  /**
   * Run an arbitrary `wrangler` command through the branded CLI — the escape hatch for subcommands
   * Moku does not wrap (kv / d1 / r2 / queues / secret / tail / …). Streams wrangler's output.
   *
   * @param args - The wrangler arguments (e.g. ["kv", "namespace", "list"]).
   * @returns Resolves once wrangler exits.
   * @example
   * ```ts
   * await app.cli.wrangler(["kv", "namespace", "list"]);
   * ```
   */
  wrangler(args: string[]): Promise<void>;
};
