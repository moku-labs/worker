/**
 * @file deploy plugin — stage-aware resource naming.
 *
 * One source of truth for turning a base Cloudflare resource name into its stage variant, so the
 * worker name, the provisioners, the infra existence diff, and the generated wrangler config all
 * agree. Production keeps the base name; every other stage gets a `-${stage}` suffix. Node-only;
 * never imported by the runtime Worker bundle.
 */

/**
 * Apply the deploy stage to a base Cloudflare resource name: the base name in `production`, else
 * `${base}-${stage}` (e.g. dev → `tracker-db-dev`). Env bindings + DO class names never get the
 * suffix — only provisioned resource names (and the worker name) are stage-qualified.
 *
 * @param base - The base resource name (e.g. "tracker-db").
 * @param stage - The deploy stage (e.g. "production", "development", "dev").
 * @returns The stage-qualified name.
 * @example
 * ```ts
 * stageName("tracker-db", "production"); // "tracker-db"
 * stageName("tracker-db", "dev");        // "tracker-db-dev"
 * ```
 */
export const stageName = (base: string, stage: string): string =>
  stage === "production" ? base : `${base}-${stage}`;
