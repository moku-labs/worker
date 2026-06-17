/**
 * @file cli plugin — type definitions skeleton.
 */

/** Resolved configuration for the cli plugin. */
export type Config = {
  /** Default local dev port forwarded to deploy.dev when dev() gets no port. Default 8787. */
  readonly port: number;
};

/** Public api surface of the cli plugin (thin passthroughs to deploy). */
export type Api = {
  /**
   * Run the Worker locally via Wrangler (delegates to deploy.dev).
   *
   * @param opts - Optional port override.
   * @param opts.port - Local dev port to bind.
   * @returns Resolves when the dev session ends.
   */
  dev(opts?: { port?: number }): Promise<void>;
  /**
   * One-command guided Cloudflare deploy (delegates to deploy.run).
   *
   * @param opts - Optional guided/yes flags.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive).
   * @returns Resolves once the deploy completes.
   */
  deploy(opts?: { guided?: boolean; yes?: boolean }): Promise<void>;
};
