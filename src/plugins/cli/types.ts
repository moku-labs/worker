/**
 * @file cli plugin — type definitions (Config, Api).
 */

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
   * @param opts - Optional port override.
   * @param opts.port - Local dev port to bind.
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.cli.dev();            // port 8787
   * await app.cli.dev({ port: 3000 }); // port 3000
   * ```
   */
  dev(opts?: { port?: number }): Promise<void>;

  /**
   * One-command guided Cloudflare deploy (delegates to deploy.run).
   * Forwards opts verbatim — passes undefined when called with no opts.
   *
   * @param opts - Optional guided/yes flags.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive).
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await app.cli.deploy({ guided: true });
   * await app.cli.deploy({ yes: true }); // CI
   * await app.cli.deploy(); // no opts → undefined forwarded
   * ```
   */
  deploy(opts?: { guided?: boolean; yes?: boolean }): Promise<void>;
};
