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

/**
 * A per-change INCREMENTAL rebuild hook wired in from the consumer's dev script — e.g.
 * `(changes) => webApp.cli.update(changes)`. The fast counterpart to {@link WebBuild}: `dev`
 * calls {@link WebBuild} ONCE for the cold build, then (when this hook is wired) calls `onChange`
 * with the set of paths changed in the debounce window so the web build can rebuild only what
 * changed instead of doing a full `webBuild()` every keystroke. Omit it and `dev` keeps doing a
 * full `webBuild()` per change (the prior behavior). Like {@link WebBuild} it may resolve ANYTHING
 * (the web build's own summary); the value is read opportunistically for a `files` count.
 *
 * @param changes - The paths changed since the last rebuild (the watcher's debounced set).
 * @returns Resolves when the incremental rebuild completes.
 * @example
 * ```ts
 * await server.cli.dev({ webBuild: () => web.cli.build(), onChange: changes => web.cli.update(changes) });
 * ```
 */
export type OnChange = (changes: readonly string[]) => Promise<unknown>;

/**
 * The remote seed wired into `deploy({ seed: true })`: which SQL file to load into the REMOTE D1
 * AFTER a successful deploy (+ migration), and which cached KV keys to clear afterwards so the app
 * rebuilds them from the freshly-seeded rows. Declarative — the deploy plugin runs no app code, so
 * the app-specific seed lives in `pluginConfigs.deploy.seed` (config) rather than a deploy hook.
 *
 * @example
 * ```ts
 * deploy: { seed: { file: "db/seed.sql", resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] } }
 * ```
 */
export type SeedConfig = {
  /** SQL file executed against the remote D1 (e.g. "db/seed.sql"). */
  file: string;
  /** The d1 binding to target when more than one database is configured (e.g. "DB"); the sole one otherwise. */
  binding?: string;
  /** Cached KV keys to delete after seeding so reads rebuild from the freshly-seeded DB. */
  resetKv?: { binding: string; key: string }[];
};

/**
 * The wrangler-backed Worker-secret helpers handed to a {@link PostDeployStep} — scoped to the
 * worker the pipeline just deployed (they run `wrangler secret …` against the generated config, so
 * the stage-qualified worker name always agrees with the deploy). `list` is read-only (names only —
 * secret VALUES are never readable); `putBulk` pushes every given name/value in one
 * `wrangler secret bulk` call (values ride stdin, never argv or a temp file).
 */
export type PostDeploySecrets = {
  /**
   * List the names of the secrets currently bound to the deployed worker (read-only, idempotent).
   *
   * @returns The bound secret names (empty when none, or when the listing is unparsable).
   */
  list(): Promise<string[]>;
  /**
   * Push the given name → value secrets to the deployed worker in one `wrangler secret bulk` call.
   *
   * @param values - The secret names and values to bind.
   * @returns Resolves once wrangler confirms the bulk upload.
   */
  putBulk(values: Record<string, string>): Promise<void>;
};

/**
 * The per-run context a registered {@link PostDeployStep} receives — everything a step needs to act
 * on the JUST-DEPLOYED worker without re-deriving pipeline facts: the stage-qualified worker name,
 * the resolved Cloudflare account, the pipeline's API token (when set), CI mode, the
 * {@link PostDeploySecrets} helpers, and a branded output line.
 */
export type PostDeployStepCtx = {
  /** The stage-qualified worker name that just deployed (production = bare). */
  workerName: string;
  /** The resolved deploy stage. */
  stage: string;
  /** The Cloudflare account id the auth preflight resolved. */
  accountId: string;
  /** The pipeline's `CLOUDFLARE_API_TOKEN` (absent only if the env var vanished mid-run). */
  apiToken?: string;
  /** Whether the run is CI/automated — a step must never prompt when true (none should anyway). */
  ci: boolean;
  /** Wrangler-backed secret helpers scoped to the deployed worker. */
  secrets: PostDeploySecrets;
  /**
   * Emit one branded info line to the deploy output (the step's status/instruction channel).
   *
   * @param message - The line to render.
   */
  note(message: string): void;
};

/**
 * A post-deploy pipeline step contributed by a SIBLING plugin via {@link Api.registerPostDeploy} —
 * the generic seam that lets a composed plugin (e.g. `@moku-labs/room/server`'s hub) extend the
 * deploy pipeline without the deploy plugin knowing it exists. Steps run INSIDE `run()`, only after
 * a successful `wrangler deploy` (an aborted/failed deploy never runs them), awaited in registration
 * order before the remote migration/seed. A step that throws is captured into the report's `errors`
 * (the deploy stays live; `ok` flips false) — a step whose failure should NOT degrade the report
 * catches internally and `note()`s an actionable line instead.
 */
export type PostDeployStep = {
  /** Short step name for the `deploy:phase` line (e.g. "turn"). */
  name: string;
  /**
   * Execute the step against the just-deployed worker.
   *
   * @param step - The per-run step context (worker name, account, secrets helpers, note).
   * @returns Resolves when the step completes.
   */
  run(step: PostDeployStepCtx): Promise<void>;
};

/**
 * The outcome of applying one D1 database's migrations (remote or local), parsed from wrangler's
 * captured output so the branded migrate panel can report exactly what ran — instead of streaming
 * wrangler's raw migration TUI. `applied` lists the migration filenames wrangler reported applying
 * this run (in order, newest last); `upToDate` is true when none were pending.
 *
 * @example
 * ```ts
 * { binding: "DB", applied: ["0003_add_boards.sql", "0004_add_index.sql"], upToDate: false }
 * ```
 */
export type MigrationOutcome = {
  /** The d1 binding whose migrations were applied (e.g. "DB"). */
  binding: string;
  /** The migration filenames wrangler reported applying this run (empty when already up to date). */
  applied: string[];
  /** True when no migrations were pending (wrangler reported "No migrations to apply"). */
  upToDate: boolean;
};

/**
 * The outcome of running a configured seed against one scope, surfaced so the branded seed panel can
 * confirm WHAT was loaded and WHICH cached KV keys were dropped — instead of streaming wrangler's raw
 * `d1 execute` / `kv key delete` TUI. The counts are best-effort (parsed when wrangler prints them,
 * omitted otherwise); `resetKv` echoes the keys that were deleted so the panel can list them.
 *
 * @example
 * ```ts
 * { file: "db/seed.sql", binding: "DB", rowsWritten: 18, resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] }
 * ```
 */
export type SeedOutcome = {
  /** The SQL file that was executed (e.g. "db/seed.sql"). */
  file: string;
  /** The d1 binding the file was executed against (e.g. "DB"). */
  binding: string;
  /** Statements executed, when wrangler reported a command count (best-effort). */
  statements?: number;
  /** Rows written, when wrangler reported a write count (best-effort). */
  rowsWritten?: number;
  /** The cached KV keys deleted after seeding, so the panel can show what was dropped. */
  resetKv: { binding: string; key: string }[];
};

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
  /**
   * The remote seed `deploy({ seed: true })` loads AFTER a successful deploy (+ migration): the SQL
   * file and the cached KV keys to reset. Omit it and `deploy({ seed: true })` reports a clear
   * "no seed configured" error instead of silently doing nothing.
   */
  seed?: SeedConfig;
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
  | { kind: "queue"; name: string; binding: string; consumer?: boolean; maxBatchTimeout?: number }
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
 * account, which are still missing and must be created, and which ship with the Worker. Produced by
 * `checkInfra()`. Durable Objects are neither "exists" nor "missing" — the planner never queries the
 * account for them and never API-provisions them; they are created by `wrangler deploy` (the
 * auto-derived DO migration), so they get their own `ships` bucket instead of masquerading as
 * already-existing.
 */
export type InfraPlan = {
  /** Resolved account display name (or id when the name is unknown). */
  account: string;
  /** Resolved Cloudflare account id used for the existence checks. */
  accountId: string;
  /** Declared resources the account listing confirmed already exist (with captured ids where applicable). */
  exists: ProvisionedRef[];
  /** Declared resources that do not yet exist and must be created. */
  missing: ResourceManifest[];
  /** Durable Objects that ship with the Worker — created by `wrangler deploy`, never API-provisioned. */
  ships: ResourceManifest[];
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
 * already existed, those that ship with the Worker (Durable Objects — not created here), those that
 * FAILED to create, and the merged id map (binding → Cloudflare id) for the config writer.
 * Provisioning is resilient — a single resource failure is captured here, not thrown, so the guided
 * flow can report a clear per-resource result.
 */
export type ProvisionResult = {
  /** Resources created during this run. */
  created: ProvisionedRef[];
  /** Resources skipped because they already existed. */
  skipped: ProvisionedRef[];
  /** Durable Objects that ship with the Worker — not created at the provision step (`wrangler deploy` does). */
  bundled: ResourceManifest[];
  /** Resources that failed to create (captured, not thrown). */
  failed: ProvisionFailure[];
  /** Merged binding → Cloudflare id map (existing + created) for writeWranglerConfig. */
  ids: Record<string, string>;
};

/**
 * Structured outcome of a deploy run (the value `run()` / `cli.deploy()` now resolve to, replacing
 * the old `void`) so a script can branch on the result instead of guessing from a thrown error. It
 * is also WHY the post-deploy migration + seed live inside `run()`: the report's `status` is the
 * single source of truth for whether the worker actually went live, so those remote-DB steps run
 * only on a successful deploy and never on an aborted one.
 *
 * `ok` is true only when the worker is live AND every requested post-step (migration, seed) also
 * succeeded. `status` is the coarse outcome: `"deployed"` (live, all post-steps ok), `"aborted"`
 * (a gate was declined or auth was never set up — nothing shipped), `"failed"` (a step errored), or
 * `"destroyed"` (a `{ delete: true }` teardown removed the stage's infrastructure).
 */
export type DeployReport = {
  /** True only when the worker is live and every requested post-step (migration, seed) succeeded — or, for a teardown, when every resource was destroyed. */
  ok: boolean;
  /** Coarse outcome: "deployed" (live + post-steps ok), "aborted" (a gate declined / auth not set up), "failed" (a step errored), "destroyed" (teardown removed the stage). */
  status: "deployed" | "aborted" | "failed" | "destroyed";
  /** The resolved deploy stage (resource-name suffix; "production" is bare). */
  stage: string;
  /** The live worker URL once `wrangler deploy` succeeded — set even if a later migration/seed failed. */
  url?: string;
  /** Provisioning tally: resources created, already-existing, shipped-with-the-Worker (DOs), and failed to create. */
  resources?: { created: number; exists: number; bundled: number; failed: number };
  /** Remote D1 migration outcome — "skipped" (not requested), "applied", or "failed". */
  migration: "skipped" | "applied" | "failed";
  /** Remote seed outcome — "skipped" (not requested), "applied", or "failed". */
  seed: "skipped" | "applied" | "failed";
  /** Wall-clock duration of the whole run (ms). */
  elapsedMs: number;
  /** Branded failure message(s) — empty when `ok`; one per failed step otherwise. */
  errors: string[];
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

/** deploy plugin state — the {@link PostDeployStep}s sibling plugins registered (run-order = registration order). */
export type State = {
  /** Steps to run inside `run()` after a successful `wrangler deploy` (before migration/seed). */
  postDeploySteps: PostDeployStep[];
};

/** Public api surface of the deploy plugin, mounted at app.deploy.*. */
export type Api = {
  /**
   * Register a {@link PostDeployStep} to run INSIDE the deploy pipeline, after a successful
   * `wrangler deploy` (and before the remote migration/seed). The generic contribution seam for
   * sibling plugins (e.g. a signaling hub ensuring its TURN secrets): call it from the sibling's
   * `onInit` — every plugin api exists by then — and the step runs on every subsequent
   * `run()`/`cli.deploy` for that app. Steps never run on an aborted or failed deploy.
   *
   * @param step - The named step to append (steps run in registration order, awaited).
   * @example
   * ```ts
   * ctx.require(deployPlugin).registerPostDeploy({ name: "turn", run: ensureTurn });
   * ```
   */
  registerPostDeploy(step: PostDeployStep): void;

  /**
   * Run the full deploy pipeline (detect -> provision -> config -> upload -> deploy), then — ONLY on
   * a successful deploy — the requested post-deploy remote steps (migration, seed). Resolves to a
   * {@link DeployReport}: a deploy that aborts (a declined gate, or auth never set up) returns
   * `status: "aborted"` and never touches the remote DB, so `deploy --seed` on a first run with no
   * token can no longer fall through to a raw `wrangler … --remote` auth error.
   *
   * @param opts - Optional run options.
   * @param opts.ci - CI/automated mode: never prompts, auto-confirms every gate. When false (the
   *   default) and stdout is a TTY, the deploy is guided — each gate is confirmed interactively.
   * @param opts.stage - Target stage; suffixes resource names ("production" = bare).
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @param opts.manifest - Caller-supplied universal manifest (bypasses auto-detection).
   * @param opts.migration - After a successful deploy, apply pending D1 migrations to the REMOTE
   *   database for every configured d1 instance that ships migrations. Skipped on an aborted deploy.
   * @param opts.seed - After a successful deploy (+ migration), load the seed configured under
   *   `pluginConfigs.deploy.seed` into the remote D1 and reset its cached KV keys. Skipped on abort.
   * @returns The deploy report (status, url, resource tally, migration/seed outcome, errors).
   * @example
   * ```ts
   * const report = await app.deploy.run({ webBuild: () => web.cli.build(), migration: true, seed: true });
   * if (report.status === "aborted") process.exit(0);
   * ```
   */
  run(opts?: {
    ci?: boolean;
    stage?: string;
    webBuild?: WebBuild;
    manifest?: ExternalManifest;
    migration?: boolean;
    seed?: boolean;
  }): Promise<DeployReport>;

  /**
   * Destroy ALL infrastructure provisioned for a stage — the Worker (which also removes its Durable
   * Object namespaces and their stored data), plus every existing KV namespace, R2 bucket, D1
   * database, and Queue for that stage, with all their data. Irreversible, so it is gated behind a
   * DOUBLE confirmation: a branded preview + y/N confirm, then a typed gate where the user must type
   * the stage name. INTERACTIVE-ONLY: off a TTY it refuses and destroys nothing.
   *
   * Discovers what actually exists via the same preflight as {@link Api.checkInfra}, so only real
   * resources are deleted, and deletion is resilient — one resource that fails to delete is captured
   * (not thrown), so the rest still go. A non-empty R2 bucket cannot be emptied from the CLI
   * (wrangler 4.x cannot list R2 objects); it is reported with a dashboard hint and the teardown
   * continues. Resolves to a {@link DeployReport} (`status: "destroyed"` on success, `"aborted"` when
   * a gate is declined / not a TTY, `"failed"` when a resource could not be deleted).
   *
   * @param opts - Optional teardown options.
   * @param opts.stage - Target stage whose resources are destroyed ("production" = bare names).
   *   Falls back to the app's configured stage.
   * @returns The teardown report (status, stage, elapsed, errors).
   * @example
   * ```ts
   * const report = await app.deploy.destroy({ stage: "dev" });
   * if (report.status !== "destroyed") process.exitCode = 1; // aborted or a resource failed
   * ```
   */
  destroy(opts?: { stage?: string }): Promise<DeployReport>;

  /**
   * Start a local Cloudflare dev session via `wrangler dev`: cold-build the web site, spawn
   * `wrangler dev`, then watch + recompile the site on change.
   *
   * @param opts - Optional port override, cold-build hook, and incremental change hook.
   * @param opts.port - Local dev port to bind.
   * @param opts.webBuild - Cold-build the web site (e.g. `() => webApp.cli.build()`); also the
   *   per-change rebuild when `onChange` is omitted.
   * @param opts.onChange - Incremental per-change rebuild (e.g. `changes => webApp.cli.update(changes)`).
   *   When set, each debounced change rebuilds only the changed paths instead of a full `webBuild()`.
   * @param opts.seed - Load the configured seed (`pluginConfigs.deploy.seed`) into the LOCAL D1 and
   *   reset its cached KV keys before serving — the local analogue of `deploy({ seed: true })`.
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await app.deploy.dev({ port: 8787, seed: true, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
   * ```
   */
  dev(opts?: {
    port?: number;
    webBuild?: WebBuild;
    onChange?: OnChange;
    seed?: boolean;
  }): Promise<void>;

  /**
   * Execute a SQL file against a configured D1 database via `wrangler d1 execute` — for seeding dev
   * data (e.g. before a `dev` session). Targets the LOCAL D1 by default; `opts.remote` runs against
   * Cloudflare. Resolves the database to the single configured d1 instance, or the one bound to
   * `opts.binding` when more than one exists. Generates/updates the wrangler config first (so the
   * binding resolves on a first run) and, locally, applies that database's migrations before the file
   * so its tables exist (the usual seed file only inserts rows). Captures wrangler's output and
   * renders a branded "Migrated" / "Seeded" summary (the raw TUI is hidden); failures still surface.
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
 * Internal context type — own config first, the {@link State} step registry, global events only.
 *
 * `PluginCtx` surfaces only config/state/emit; the runtime fields core also injects
 * (`global`, `require`, `has`) are composed in here via intersection. `require` uses the
 * general `RequireFn` so every ctx.require(xPlugin) resolves to that plugin's Api.
 */
export type Ctx = PluginCtx<Config, State, WorkerEvents> & {
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
