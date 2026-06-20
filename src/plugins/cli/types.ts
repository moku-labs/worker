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
   * Run the Worker locally via Wrangler (delegates to deploy.dev). Resolves the port from
   * `opts.port`, else a `--port <n>` CLI flag, else the configured default (8787). A failure renders
   * a branded `✗` line and sets a non-zero exit code rather than throwing a raw stack trace.
   *
   * @param opts - Optional port override and web build hook.
   * @param opts.port - Local dev port to bind (overrides the `--port` flag and the default).
   * @param opts.webBuild - Rebuild the web site on change (e.g. `() => webApp.cli.build()`).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.cli.dev({ webBuild: () => web.cli.build() }); // port from --port or 8787
   * ```
   */
  dev(opts?: { port?: number; webBuild?: WebBuild }): Promise<void>;

  /**
   * One-command Cloudflare deploy (delegates to deploy.run). Guided/interactive by default; pass
   * `{ ci: true }` for the automated/non-interactive path (CI). A failure renders a branded `✗`
   * line and sets a non-zero exit code rather than throwing a raw stack trace.
   *
   * @param opts - Optional ci flag and a web build hook.
   * @param opts.ci - Automated mode: never prompts, auto-confirms. Omit/false → guided on a TTY.
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @returns Resolves once the deploy completes (or after a failure is rendered).
   * @example
   * ```ts
   * await app.cli.deploy({ webBuild: () => web.cli.build() });           // guided
   * await app.cli.deploy({ ci: true, webBuild: () => web.cli.build() }); // CI
   * ```
   */
  deploy(opts?: { ci?: boolean; webBuild?: WebBuild }): Promise<void>;

  /**
   * Seed a configured D1 database from a SQL file (delegates to deploy.seed). Local by default
   * (applies the database's migrations first so its tables exist, then executes the file);
   * `opts.remote` seeds Cloudflare. A failure renders a branded `✗` line and sets a non-zero exit
   * code rather than throwing.
   *
   * @param sqlFile - Path to the SQL file to execute (e.g. "db/seed.sql").
   * @param opts - Optional options.
   * @param opts.binding - The d1 binding to target when more than one is configured (e.g. "DB").
   * @param opts.remote - Seed the remote (Cloudflare) D1 instead of the local one.
   * @returns Resolves once the seed completes (or after a failure is rendered).
   * @example
   * ```ts
   * await app.cli.seed("db/seed.sql"); // local; --stage honored
   * ```
   */
  seed(sqlFile: string, opts?: { binding?: string; remote?: boolean }): Promise<void>;

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
