/**
 * @file deploy plugin — type definitions (Config, ResourceManifest, ExternalManifest, Ctx, Api).
 */
import type { EnvApi } from "@moku-labs/common";
import type { PluginCtx, PluginInstance } from "@moku-labs/core";

import type { WorkerConfig, WorkerEvents } from "../../config";

/**
 * A web-site build hook wired in from the consumer's deploy/dev script — e.g.
 * `() => webApp.cli.build()`. This is the seam that lets one small app-side script compose a
 * Moku Web app with this Worker framework: `dev` / `deploy` invoke it to (re)build the site before
 * serving or deploying. The hook may resolve ANYTHING — `void`, the web app's own build summary, or
 * a `{ files }` count; when the resolved value carries a numeric `files` field it is surfaced in
 * `dev:rebuilt`, otherwise the count is reported as 0. Returning `Promise<unknown>` keeps the hook
 * assignable from any real build function (whose return type the worker framework cannot know).
 *
 * @returns Resolves when the web build completes (the value is read opportunistically for `files`).
 * @example
 * ```ts
 * await server.cli.dev({ webBuild: () => web.cli.build() });
 * ```
 */
export type WebBuild = () => Promise<unknown>;

/** deploy plugin configuration. Flat; complete defaults so omission never yields undefined. */
export type Config = {
  /**
   * Wrangler config file generated/updated and read by `wrangler deploy`. Default "wrangler.jsonc".
   * Also the file parsed in the universal/non-moku path.
   */
  configFile: string;
  /**
   * The Worker entry module → wrangler `main` (e.g. "src/cloudflare/worker.ts"). Required for any
   * real Worker deploy (its absence is wrangler's "Missing entry-point" error).
   */
  entry?: string;
  /**
   * Enable Node.js compat → `compatibility_flags: ["nodejs_compat"]`. Needed when the Worker bundle
   * pulls in Node-flavored code (e.g. composing the deploy/cli tooling into the runtime app).
   */
  nodeCompat?: boolean;
  /**
   * Static assets served via `env.<binding>` → the wrangler `assets` block. `spa: true` sets
   * `not_found_handling: "single-page-application"` so client-routed deep links resolve to index.html.
   */
  assets?: { binding: string; directory: string; spa?: boolean };
  /**
   * Escape hatch — extra top-level wrangler keys merged into the generated config for anything the
   * typed fields above don't cover (`vars`, `routes`, `observability`, `triggers`, …). The
   * deploy-managed resource keys (name, compatibility_date, kv_namespaces, r2_buckets, d1_databases,
   * queues, durable_objects, and the auto-derived Durable Object `migrations`) always win over these.
   */
  wrangler?: Record<string, unknown>;
  /**
   * Standing CI/automated default for `run()`. When true (or when stdout is non-TTY) the deploy
   * never prompts and auto-confirms every gate; `run({ ci })` overrides it per call. CF credentials
   * are read from the env (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) via `ctx.env`. Default false.
   */
  ci: boolean;
  /** Globs watched by `dev()` to trigger a Moku-site rebuild. */
  watch: string[];
  /**
   * Standing default web-site build hook (e.g. `() => webApp.cli.build()`). Usually passed
   * call-time to `dev` / `deploy` via `opts.webBuild` (the script-driven path); set here only for
   * a persistent default. When absent, dev() falls back to `buildCommand`, then auto-detects
   * `scripts/build.ts`.
   */
  webBuild?: WebBuild;
  /** Shell rebuild fallback (e.g. "bun run scripts/build.ts"); empty → auto-detect scripts/build.ts. */
  buildCommand: string;
  /** Apply local D1 migrations before serving when a d1 manifest is present. */
  migrateLocal: boolean;
  /** Debounce window (ms) coalescing rapid file changes into one rebuild. */
  debounceMs: number;
};

/**
 * Discriminated union of per-INSTANCE resource descriptors. Each resource plugin's `deployManifest()`
 * returns an ARRAY of these (one per configured instance). `name` is the base Cloudflare resource
 * name (stage-suffixed downstream via {@link stageName}); `binding` is the stable env var. Durable
 * Objects carry no provisioned `name` — they ship with the Worker script — and declare the exported
 * `className` instead.
 */
export type ResourceManifest =
  | { kind: "r2"; name: string; binding: string; upload?: string }
  | { kind: "kv"; name: string; binding: string }
  | { kind: "d1"; name: string; binding: string; migrations?: string }
  | { kind: "queue"; name: string; binding: string; consumer?: boolean }
  | { kind: "do"; binding: string; className: string };

/**
 * The whole deploy manifest the pipeline consumes (assembled, or caller-supplied for the
 * universal path).
 */
export type ExternalManifest = {
  /** Worker name. */
  name: string;
  /** Cloudflare compatibility date. */
  compatibilityDate: string;
  /** Resource descriptors to provision. */
  resources: ResourceManifest[];
};

/**
 * Outcome of provisioning a single resource. Carries the captured Cloudflare id for the
 * kinds that have one (kv namespace id, d1 database id) so writeWranglerConfig can write a
 * real id into the generated config instead of an empty placeholder. r2/queue/do have no
 * such id (they are referenced by name) and resolve to an empty object.
 */
export type ProvisionOutcome = {
  /** Captured Cloudflare resource id, when the provisioned kind reports one (kv/d1). */
  id?: string;
};

/**
 * A resource that already exists in the account (the infra preflight discovered it), with its
 * captured Cloudflare id when the kind has one (kv namespace id, d1 database id).
 */
export type ProvisionedRef = {
  /** The resource descriptor from the manifest. */
  resource: ResourceManifest;
  /** The existing resource's Cloudflare id (kv/d1 only). */
  id?: string;
};

/**
 * Read-only infra preflight result: which declared resources already exist in the Cloudflare
 * account versus which are still missing and must be created. Produced by `checkInfra()`.
 */
export type InfraPlan = {
  /** Resolved account display name (or id when the name is unknown). */
  account: string;
  /** Resolved Cloudflare account id used for the existence checks. */
  accountId: string;
  /** Declared resources that already exist (with their captured ids where applicable). */
  exists: ProvisionedRef[];
  /** Declared resources that do not yet exist and must be created. */
  missing: ResourceManifest[];
};

/**
 * A resource that failed to provision, with the (branded) error message captured so the guided flow
 * can show WHICH resource failed and why — instead of aborting the whole run on the first failure.
 */
export type ProvisionFailure = {
  /** The resource descriptor that failed to create. */
  resource: ResourceManifest;
  /** The captured error message (e.g. the branded wrangler failure). */
  error: string;
};

/**
 * Outcome of acting on an {@link InfraPlan}: the resources just created, those skipped because they
 * already existed, those that FAILED to create, and the merged id map (binding → Cloudflare id) for
 * the config writer. Provisioning is resilient — a single resource failure is captured here, not
 * thrown, so the guided flow can report a clear per-resource result.
 */
export type ProvisionResult = {
  /** Resources created during this run. */
  created: ProvisionedRef[];
  /** Resources skipped because they already existed. */
  skipped: ProvisionedRef[];
  /** Resources that failed to create (captured, not thrown). */
  failed: ProvisionFailure[];
  /** Merged binding → Cloudflare id map (existing + created) for writeWranglerConfig. */
  ids: Record<string, string>;
};

/** Result of verifying the `.env` Cloudflare API token and resolving its account. */
export type AuthStatus = {
  /** Whether the token is present and active. */
  ok: boolean;
  /** Resolved account display name (or id when the name is unknown). */
  account: string;
  /** Resolved Cloudflare account id. */
  accountId: string;
  /** Token scopes, when discoverable (empty otherwise). */
  scopes: string[];
};

/** One Cloudflare API-token permission group the app's manifest requires. */
export type PermissionGroup = {
  /** Human-readable group label, e.g. "Account · D1". */
  group: string;
  /** Permission scope. */
  scope: "Edit" | "Read";
  /** Why it is required, e.g. "d1", "queue", "deploy", "account". */
  reason: string;
  /** Whether Cloudflare's stock "Edit Cloudflare Workers" template already includes it. */
  inBaseTemplate: boolean;
};

/** The Cloudflare API token this app requires, derived from its manifest. */
export type TokenRequirement = {
  /** The recommended starting template. */
  base: "Edit Cloudflare Workers";
  /** The full set of permission groups required. */
  required: PermissionGroup[];
  /** Groups NOT in the base template that the user must add (e.g. D1, Queues). */
  toAdd: PermissionGroup[];
};

/** Public api surface of the deploy plugin, mounted at app.deploy.*. */
export type Api = {
  /**
   * Run the full deploy pipeline (detect -> provision -> config -> upload -> deploy).
   *
   * @param opts - Optional ci flag, a web build hook, or a caller-supplied manifest.
   * @param opts.ci - CI/automated mode: never prompts, auto-confirms every gate. When false (the
   *   default) and stdout is a TTY, the deploy is guided — each gate is confirmed interactively.
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @param opts.manifest - Caller-supplied universal manifest (bypasses auto-detection).
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await app.deploy.run({ webBuild: () => web.cli.build() });            // guided on a TTY
   * await app.deploy.run({ ci: true, webBuild: () => web.cli.build() });  // automated (CI)
   * ```
   */
  run(opts?: { ci?: boolean; webBuild?: WebBuild; manifest?: ExternalManifest }): Promise<void>;

  /**
   * Start a local Cloudflare dev session via `wrangler dev`: cold-build the web site, spawn
   * `wrangler dev`, then watch + recompile the site on change.
   *
   * @param opts - Optional port override and web build hook.
   * @param opts.port - Local dev port to bind.
   * @param opts.webBuild - Rebuild the web site on change (e.g. `() => webApp.cli.build()`).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.deploy.dev({ port: 8787, webBuild: () => web.cli.build() });
   * ```
   */
  dev(opts?: { port?: number; webBuild?: WebBuild }): Promise<void>;

  /**
   * Execute a SQL file against a configured D1 database via `wrangler d1 execute` — for seeding dev
   * data (e.g. before a `dev` session). Targets the LOCAL D1 by default; `opts.remote` runs against
   * Cloudflare. Resolves the database to the single configured d1 instance, or the one bound to
   * `opts.binding` when more than one exists. Generates/updates the wrangler config first (so the
   * binding resolves on a first run) and, locally, applies that database's migrations before the file
   * so its tables exist (the usual seed file only inserts rows). Streams wrangler's output.
   *
   * @param sqlFile - Path to the SQL file to execute (e.g. "db/seed.sql").
   * @param opts - Optional options.
   * @param opts.stage - Stage for the generated config's resource names (defaults to the app stage).
   * @param opts.binding - The d1 binding to target when more than one is configured (e.g. "DB").
   * @param opts.remote - Seed the remote (Cloudflare) D1 instead of the local one.
   * @returns Resolves once wrangler finishes executing the file.
   * @example
   * ```ts
   * await app.deploy.seed("db/seed.sql");                   // local default d1
   * await app.deploy.seed("db/seed.sql", { remote: true }); // remote
   * ```
   */
  seed(
    sqlFile: string,
    opts?: { stage?: string; binding?: string; remote?: boolean }
  ): Promise<void>;

  /**
   * Scaffold a starting wrangler config (and CI files when ci is set).
   *
   * @param opts - Optional ci flag.
   * @param opts.ci - Also scaffold CI workflow files.
   * @returns Resolves once scaffolding is written.
   * @example
   * ```ts
   * await app.deploy.init({ ci: true });
   * ```
   */
  init(opts?: { ci?: boolean }): Promise<void>;

  /**
   * Read-only infra preflight: resolve the account, list what already exists in Cloudflare,
   * diff against the assembled manifest, and report the plan. Writes nothing.
   *
   * @returns The infra plan (existing vs missing resources, with captured ids).
   * @example
   * ```ts
   * const plan = await app.deploy.checkInfra();
   * const toCreate = plan.missing.length;
   * ```
   */
  checkInfra(): Promise<InfraPlan>;

  /**
   * Create only the resources missing from the plan (skipping those that already exist),
   * capturing each created/existing id for the wrangler config.
   *
   * @param plan - A plan produced by {@link Api.checkInfra}.
   * @returns The provisioning result: created, skipped, and the merged id map.
   * @example
   * ```ts
   * const plan = await app.deploy.checkInfra();
   * const { created } = await app.deploy.provisionInfra(plan);
   * ```
   */
  provisionInfra(plan: InfraPlan): Promise<ProvisionResult>;

  /**
   * Verify the `.env` Cloudflare API token (must be active) and resolve its account. Emits
   * auth:verified. Throws a branded, actionable error (pointing at `auth setup`) when the token
   * is missing, invalid, or inactive.
   *
   * @returns The verified auth status (account + id).
   * @throws {Error} When the token is absent, invalid, or inactive.
   * @example
   * ```ts
   * const { account } = await app.deploy.verifyAuth();
   * ```
   */
  verifyAuth(): Promise<AuthStatus>;

  /**
   * Derive the minimum Cloudflare API token this app needs from its manifest — including which
   * permission groups are missing from the stock "Edit Cloudflare Workers" template (D1, Queues).
   * Pure: no network, works before a token exists.
   *
   * @returns The derived token requirement (full set + the groups to add).
   * @example
   * ```ts
   * const { toAdd } = app.deploy.requiredToken();
   * ```
   */
  requiredToken(): TokenRequirement;

  /**
   * Derive the REDUCED Cloudflare API token permission groups for CI/automation redeploys from the
   * manifest — read-mostly (data resources drop to `Read`; the idempotent preflight only lists),
   * manifest-scoped. Pure: no network. Used by the branded `auth setup` renderer.
   *
   * @returns The CI token permission groups.
   * @example
   * ```ts
   * const groups = app.deploy.ciToken();
   * ```
   */
  ciToken(): PermissionGroup[];

  /**
   * Render copy-pasteable `auth setup` guidance from the derived token requirement: the permission
   * table, the template + "add these" steps, and the `.env.local` lines. Pure: no network.
   *
   * @returns The rendered instruction text.
   * @example
   * ```ts
   * const text = app.deploy.tokenInstructions();
   * ```
   */
  tokenInstructions(): string;

  /**
   * Run an arbitrary `wrangler` command, streaming its output — the escape hatch for subcommands
   * Moku does not wrap (kv / d1 / r2 / queues / secret / tail / etc.).
   *
   * @param args - The wrangler arguments (e.g. ["kv", "namespace", "list"]).
   * @returns Resolves once wrangler exits.
   * @example
   * ```ts
   * await app.deploy.wrangler(["kv", "namespace", "list"]);
   * ```
   */
  wrangler(args: string[]): Promise<void>;
};

// ─── ctx.require composition (mirrors src/plugins/server/types.ts) ───────────────────
// Proven assignable FROM core's real ctx.require (which returns ExtractPluginApi<P>). A single
// generic RequireFn is used instead of per-plugin `require` OVERLOADS: TypeScript cannot check
// core's generic `require` against a multi-overload target (the return collapses to `unknown`),
// but it DOES unify against one generic signature. Each call site still narrows precisely —
// ctx.require(storagePlugin) → StorageApi (with its deployManifest()).
/** Loosest plugin-instance shape — the `require` type-parameter constraint (mirrors core's RequireFunction). */
// biome-ignore lint/suspicious/noExplicitAny: mirrors core's unexported RequireFunction constraint; PluginInstance type-args must be `any` (not `unknown`) for variance
type AnyPlugin = PluginInstance<string, any, any, any, any>;

/**
 * Extract a plugin instance's API type via the `_phantom.api` slot — identical to core's
 * un-exported `ExtractPluginApi`, so `RequireFn` is assignable FROM core's real `ctx.require`.
 */
type ApiOf<P> = P extends { readonly _phantom: { readonly api: infer A } } ? A : never;

/** Cross-plugin reach: `require(plugin)` returns that plugin's API. Mirrors core's `ctx.require`. */
type RequireFn = <P extends AnyPlugin>(plugin: P) => ApiOf<P>;

/**
 * Internal context type — own config first, no state, global events only.
 *
 * `PluginCtx` surfaces only config/state/emit; the runtime fields core also injects
 * (`global`, `require`, `has`) are composed in here via intersection. `require` uses the
 * general `RequireFn` so every ctx.require(xPlugin) resolves to that plugin's Api.
 */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents> & {
  /** Frozen global framework config (name, compatibilityDate, stage). */
  readonly global: Readonly<WorkerConfig>;
  /** Injected core env api (`@moku-labs/common`) — reads CLOUDFLARE_API_TOKEN / _ACCOUNT_ID. */
  readonly env: EnvApi;
  /** Resolve a dependency plugin's api (storage / kv / d1 / queues / durableObjects). */
  readonly require: RequireFn;
  /**
   * Returns true when the named plugin was included in createApp({ plugins }).
   *
   * @param name - Plugin name string.
   * @returns Whether the plugin is present.
   */
  has(name: string): boolean;
};
