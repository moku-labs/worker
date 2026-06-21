/**
 * @file cli plugin — type definitions (Config, Api).
 */

import type { DeployReport, OnChange, WebBuild } from "../deploy/types";

/**
 * Resolved configuration for the cli plugin. The cli surface is configuration-free: the dev port is
 * NOT set here (it comes only from `dev({ port })`), so there are no keys to set under
 * `pluginConfigs.cli`.
 */
export type Config = Record<string, never>;

/** Public api surface of the cli plugin, mounted at app.cli.*. */
export type Api = {
  /**
   * Run the Worker locally via Wrangler (delegates to deploy.dev). The dev port comes only from
   * `opts.port` — the consumer passes it (e.g. parsed from its own CLI flags); it defaults to 8787
   * when omitted. A failure renders a branded `✗` line and sets a non-zero exit code rather than
   * throwing a raw stack trace.
   *
   * @param opts - Optional port, stage, cold-build hook, and incremental change hook.
   * @param opts.port - Local dev port to bind. Defaults to 8787 when omitted.
   * @param opts.stage - Stage for the generated wrangler config's resource names. Falls back to the
   *   `--stage` CLI flag, then the app's configured stage. Pass it explicitly from a script for a
   *   self-documenting `dev({ stage })` instead of relying on the hidden flag.
   * @param opts.webBuild - Cold-build the web site (e.g. `() => webApp.cli.build()`); also the
   *   per-change rebuild when `onChange` is omitted.
   * @param opts.onChange - Incremental per-change rebuild (e.g. `changes => webApp.cli.update(changes)`),
   *   so each change rebuilds only the changed paths instead of a full `webBuild()` every keystroke.
   * @param opts.seed - Load the configured seed (`pluginConfigs.deploy.seed`) into the LOCAL D1 and
   *   reset its cached KV keys before serving — the local analogue of `deploy({ seed: true })`.
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.cli.dev({ stage: "dev", port: 7878, seed: true, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
   * ```
   */
  dev(opts?: {
    port?: number;
    stage?: string;
    webBuild?: WebBuild;
    onChange?: OnChange;
    seed?: boolean;
  }): Promise<void>;

  /**
   * One-command Cloudflare deploy (delegates to deploy.run), then — only on a successful deploy —
   * the requested post-deploy remote steps (migration, seed). Guided/interactive by default; pass
   * `{ ci: true }` for the automated/non-interactive path (CI). Unlike the other verbs this RETURNS
   * the structured {@link DeployReport} (so a script can branch on the outcome) AND, on a failure,
   * renders a branded `✗` line + sets a non-zero exit code rather than throwing a raw stack trace.
   *
   * @param opts - Optional ci flag, stage, a web build hook, and the post-deploy migration/seed flags.
   * @param opts.ci - Automated mode: never prompts, auto-confirms. Omit/false → guided on a TTY.
   * @param opts.stage - Stage for the generated wrangler config's resource names (e.g. "production",
   *   "staging"). Falls back to the `--stage` CLI flag, then the app's configured stage. Pass it
   *   explicitly from a script for a self-documenting `deploy({ stage })` instead of the hidden flag.
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @param opts.migration - Apply pending remote D1 migrations after a successful deploy (skipped on abort).
   * @param opts.seed - Load the configured remote seed (`pluginConfigs.deploy.seed`) after a
   *   successful deploy (+ migration); skipped on an aborted deploy.
   * @returns The deploy report (status, url, resource tally, migration/seed outcome, errors).
   * @example
   * ```ts
   * const report = await app.cli.deploy({ webBuild: () => web.cli.build(), migration: true, seed: true });
   * if (report.status === "aborted") return; // creds not set up yet — nothing shipped
   * ```
   */
  deploy(opts?: {
    ci?: boolean;
    stage?: string;
    webBuild?: WebBuild;
    migration?: boolean;
    seed?: boolean;
  }): Promise<DeployReport>;

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
