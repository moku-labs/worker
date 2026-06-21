/**
 * @file deploy plugin — API factory (run, dev, init, checkInfra, provisionInfra).
 *
 * Pure ctx-taking factory. Assembles the deploy manifest from each resource plugin's own
 * deployManifest() api (never sibling pluginConfigs — design F6), runs an infra preflight
 * (check-before-create + capture real ids), generates/updates the wrangler config, uploads the
 * R2 upload dir, and runs wrangler deploy. Emits only global events: deploy:phase,
 * deploy:complete, provision:resource, provision:plan, provision:skip.
 *
 * Node-only: uses node:child_process (via runner.ts), node:fs (via wrangler-config.ts), and the
 * Cloudflare REST API (via infra/). Never called in the deployed Worker runtime.
 */
import { createBrandConsole, createBrandPrompts } from "@moku-labs/common/cli";
import { d1Plugin } from "../d1";
import { durableObjectsPlugin } from "../durable-objects";
import { kvPlugin } from "../kv";
import { queuesPlugin } from "../queues";
import { storagePlugin } from "../storage";
import { ensureEnvLocal } from "./auth/env-file";
import { ciToken as deriveCiToken, requiredToken as deriveRequiredToken } from "./auth/permissions";
import { renderAuthSetup } from "./auth/render";
import { envLocalScaffold, tokenInstructions as renderTokenInstructions } from "./auth/setup";
import { verifyAuth as runVerifyAuth } from "./auth/verify";
import { realDevDeps, runDev } from "./dev/runner";
import { planInfra } from "./infra/plan";
import {
  renderDeploySummary,
  renderMigrateSummary,
  renderPlan,
  renderProvisionResult,
  renderSeedSummary,
  resourceName
} from "./infra/render";
import { stageName } from "./naming";
import { provisionResource } from "./providers";
import { uploadDirToR2 } from "./providers/r2";
import { runWrangler, runWranglerInherit } from "./runner";
import { parseMigrationsApplied, parseSeedStats, resolveD1, runConfiguredSeed } from "./seed";
import { stdoutIsTty } from "./tty";
import type {
  AuthStatus,
  Ctx,
  DeployReport,
  ExternalManifest,
  InfraPlan,
  MigrationOutcome,
  OnChange,
  PermissionGroup,
  ProvisionedRef,
  ProvisionFailure,
  ProvisionResult,
  ResourceManifest,
  TokenRequirement,
  WebBuild
} from "./types";
import { scaffoldWranglerAndCi, wranglerExtra, writeWranglerConfig } from "./wrangler-config";

/**
 * Assemble the deploy manifest from each present resource plugin's OWN deployManifest() api (each
 * returns one entry PER configured instance), gated by ctx.has(name) so absent plugins are skipped —
 * never sibling pluginConfigs (F6). The single place the deploy stage is baked into names: the worker
 * name and every provisioned resource `name` are run through {@link stageName} (bindings/DO class
 * names are never suffixed), so provisioning, the existence diff, and the generated config all agree.
 *
 * @param ctx - The deploy plugin context.
 * @param stage - The deploy stage (e.g. "production", "dev") applied to every resource name.
 * @returns The assembled manifest (stage-qualified name, compatibilityDate, per-instance resources).
 * @example
 * ```ts
 * const manifest = assembleManifest(ctx, "production");
 * ```
 */
const assembleManifest = (ctx: Ctx, stage: string): ExternalManifest => {
  const resources: ResourceManifest[] = [
    ctx.has("storage") ? ctx.require(storagePlugin).deployManifest() : [],
    ctx.has("kv") ? ctx.require(kvPlugin).deployManifest() : [],
    ctx.has("d1") ? ctx.require(d1Plugin).deployManifest() : [],
    ctx.has("queues") ? ctx.require(queuesPlugin).deployManifest() : [],
    ctx.has("durableObjects") ? ctx.require(durableObjectsPlugin).deployManifest() : []
  ].flat();

  return {
    name: stageName(ctx.global.name, stage),
    compatibilityDate: ctx.global.compatibilityDate,
    // Apply the stage to every provisioned resource name (DOs carry no name — left untouched).
    resources: resources.map(resource =>
      "name" in resource ? { ...resource, name: stageName(resource.name, stage) } : resource
    )
  };
};

/**
 * Create the still-missing resources one at a time: provision each, fold its captured id (kv/d1) into
 * the shared `ids` map, and announce it via provision:resource. Resilient — a single failure is
 * CAPTURED (not thrown), so one bad resource never aborts the rest. Extracted from {@link applyPlan}
 * so that orchestrator stays flat (skip existing, skip DOs, create missing).
 *
 * @param ctx - The deploy plugin context.
 * @param missing - The resources the plan flagged as not-yet-existing.
 * @param ci - Whether provisioning runs non-interactively (forwarded to each provider).
 * @param ids - The binding → Cloudflare id map, mutated in place with each created kv/d1 id.
 * @returns The created refs and any captured per-resource failures.
 * @example
 * ```ts
 * const { created, failed } = await provisionMissing(ctx, plan.missing, false, ids);
 * ```
 */
const provisionMissing = async (
  ctx: Ctx,
  missing: ResourceManifest[],
  ci: boolean,
  ids: Record<string, string>
): Promise<{ created: ProvisionedRef[]; failed: ProvisionFailure[] }> => {
  // Create the missing resources one by one, capturing each new id (kv/d1) — and capturing any
  // failure instead of throwing, so the remaining resources still get a chance to provision.
  const created: ProvisionedRef[] = [];
  const failed: ProvisionFailure[] = [];
  for (const resource of missing) {
    try {
      const { id } = await provisionResource(resource, ci);

      if (id !== undefined && (resource.kind === "kv" || resource.kind === "d1")) {
        ids[resource.binding] = id;
      }

      created.push(id === undefined ? { resource } : { resource, id });
      ctx.emit("provision:resource", { kind: resource.kind, name: resourceName(resource) });
    } catch (error) {
      failed.push({ resource, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { created, failed };
};

/**
 * Act on an infra plan: skip the resources that already exist (reusing their ids), skip the Durable
 * Objects that ship with the Worker, create the missing ones (capturing each new id), and announce
 * each via provision:skip / :resource. Resilient — a single resource that fails to create is CAPTURED
 * in `failed` (not thrown), so one bad resource (e.g. an invalid bucket name) never aborts the whole
 * run and the caller can report a clear result.
 *
 * @param ctx - The deploy plugin context.
 * @param plan - The infra plan from planInfra (existing vs missing vs ships-with-Worker).
 * @param ci - Whether provisioning runs non-interactively (forwarded to each provider).
 * @returns The provisioning result: created, skipped, bundled, failed, and the merged binding → id map.
 * @example
 * ```ts
 * const { created, failed } = await applyPlan(ctx, plan, false);
 * ```
 */
const applyPlan = async (ctx: Ctx, plan: InfraPlan, ci: boolean): Promise<ProvisionResult> => {
  const ids: Record<string, string> = {};

  // Reuse the ids of resources that already exist; announce each as skipped.
  for (const ref of plan.exists) {
    if (ref.id !== undefined && (ref.resource.kind === "kv" || ref.resource.kind === "d1")) {
      ids[ref.resource.binding] = ref.id;
    }
    ctx.emit("provision:skip", { kind: ref.resource.kind, name: resourceName(ref.resource) });
  }

  // Durable Objects ship with the Worker (`wrangler deploy` creates the namespace) — never created at
  // this step. Announce each as skipped too, so a consumer hooking provision:skip still sees them.
  for (const resource of plan.ships) {
    ctx.emit("provision:skip", { kind: resource.kind, name: resourceName(resource) });
  }

  // Create the missing resources resiliently (one failure never aborts the rest).
  const { created, failed } = await provisionMissing(ctx, plan.missing, ci, ids);

  return { created, skipped: plan.exists, bundled: plan.ships, failed, ids };
};

/**
 * Sentinel a guided helper resolves to when the user declined recovery — a clean abort the caller
 * turns into a `deploy:phase aborted` + early return, never a thrown (and re-rendered) error.
 */
const ABORTED = Symbol("deploy:aborted");

/** Retry guidance shown beneath each step's failure, before the "Retry?" prompt. */
const HINTS = {
  build: "Web build failed — fix the error above, then retry.",
  provision: "Verify your token's account scopes and Cloudflare's status, then retry.",
  upload: "R2 upload failed — check the bucket and your token's R2 scope, then retry.",
  deploy: "wrangler deploy failed — review the output above, then retry."
} as const;

/**
 * Emit the terminal `aborted` phase AND build the matching {@link DeployReport} — the single exit
 * every guided gate/retry funnels through when the user stops the deploy (or auth was never set up).
 * Centralizing it keeps every abort path emitting one consistent line and returning the same shaped
 * report: `status: "aborted"`, both post-steps `"skipped"`, no errors — so a calling script sees a
 * clean stop, never a half-filled success, and the remote-DB migration/seed are guaranteed unrun.
 *
 * @param ctx - The deploy plugin context.
 * @param stage - The resolved deploy stage (echoed into the report).
 * @param startedAt - The run's start timestamp, for the elapsed field.
 * @returns The aborted deploy report.
 * @example
 * ```ts
 * if (declined) return aborted(ctx, stage, startedAt);
 * ```
 */
const aborted = (ctx: Ctx, stage: string, startedAt: number): DeployReport => {
  ctx.emit("deploy:phase", { phase: "aborted" });
  return {
    ok: false,
    status: "aborted",
    stage,
    migration: "skipped",
    seed: "skipped",
    elapsedMs: Date.now() - startedAt,
    errors: []
  };
};

/**
 * Shared interactivity for the guided recovery helpers: whether prompting is safe, and the prompt.
 * Off a TTY (or in CI) `interactive` is false, so every failure fails fast instead of recovering.
 */
type GuidedDeps = {
  /** Whether prompts are safe (a non-CI TTY). When false, failures re-throw (fail-fast). */
  interactive: boolean;
  /** The branded yes/no prompt used for the retry / `auth setup` questions. */
  confirm: (question: string) => Promise<boolean>;
};

/**
 * The full guided token setup shown after an auth failure on a TTY. Offers to walk the user through
 * it, and when accepted: prints WHERE to create the Cloudflare token (dashboard URL, which template,
 * the exact permissions to add) AND scaffolds a ready-to-fill `.env.local` — the same guidance baked
 * in as comments — for the user to paste the token + account id into (never clobbering an existing
 * file). Always ends pointing at the re-run.
 *
 * @param ctx - The deploy plugin context.
 * @param ui - The branded console to render the guidance through.
 * @param confirm - The yes/no prompt.
 * @returns Resolves once the guidance (and optional `.env.local` scaffold) has been rendered.
 * @example
 * ```ts
 * await guidedTokenSetup(ctx, createBrandConsole(), confirm);
 * ```
 */
const guidedTokenSetup = async (
  ctx: Ctx,
  ui: ReturnType<typeof createBrandConsole>,
  confirm: GuidedDeps["confirm"]
): Promise<void> => {
  // Opt-out: point at the file to set and bail (no token to capture in-process anyway).
  if (!(await confirm("Set up Cloudflare credentials now? (guided)"))) {
    ui.info("Set CLOUDFLARE_API_TOKEN in .env.local, then run `deploy` again.");
    return;
  }

  // Explain WHERE to get the token — branded panel: dashboard URL, the template, and exactly which
  // permissions to add (derived from the manifest, so D1/Queues are flagged). Always shown after the
  // user opts in — including when `.env.local` already exists — so the next step is never a mystery.
  // Stage is irrelevant to token derivation (it keys off resource KINDS, not names).
  const manifest = assembleManifest(ctx, ctx.global.stage);
  renderAuthSetup(ui, deriveRequiredToken(manifest));

  // Hand the user a real file (guidance baked in as comments) to paste into — never overwrite one.
  const { created, path } = await ensureEnvLocal(process.cwd(), envLocalScaffold(manifest));
  ui.info(
    created
      ? `Created ${path} — paste your token + account id there, then run \`deploy\` again.`
      : `${path} already exists — fill in CLOUDFLARE_API_TOKEN there, then run \`deploy\` again.`
  );
};

/**
 * Verify the `.env` token, turning a missing/invalid token into a guided recovery on a TTY: surface
 * WHY auth failed, then walk the user through {@link guidedTokenSetup} (where to create the token +
 * scaffold a `.env.local`). The env is snapshotted at app start, so a freshly-pasted token only
 * takes effect on a NEW run. In CI/pipes the branded error re-throws (fail-fast).
 *
 * @param ctx - The deploy plugin context.
 * @param deps - Interactivity + the confirm prompt.
 * @returns True when the token verified; false when the user must set it up and re-run.
 * @throws {Error} Re-throws the branded auth error in CI / non-interactive runs.
 * @example
 * ```ts
 * if (!(await guidedAuth(ctx, { interactive, confirm }))) return;
 * ```
 */
const guidedAuth = async (ctx: Ctx, deps: GuidedDeps): Promise<boolean> => {
  try {
    await runVerifyAuth(ctx);
    return true;
  } catch (error) {
    // CI / non-TTY: no human to guide — keep the fail-fast contract.
    if (!deps.interactive) throw error;

    const ui = createBrandConsole();
    ui.error(error instanceof Error ? error.message : String(error));
    await guidedTokenSetup(ctx, ui, deps.confirm);
    return false;
  }
};

/**
 * Run one external pipeline step with interactive recovery: on failure, render the branded error +
 * an actionable hint, then offer to retry — looping until the step succeeds or the user declines.
 * A decline resolves to {@link ABORTED} (a clean abort the caller surfaces), so the error is shown
 * once, not re-rendered downstream. In CI/pipes the first failure re-throws (fail-fast). The step
 * MUST be safe to re-run (idempotent).
 *
 * @param step - The async step to run (e.g. the web build, the R2 upload, `wrangler deploy`).
 * @param hint - One-line guidance shown beneath the error before the retry prompt.
 * @param deps - Interactivity + the confirm prompt.
 * @returns The step's resolved value once it succeeds, or {@link ABORTED} when a retry is declined.
 * @throws {Error} Re-throws the step's error in CI / non-interactive runs.
 * @example
 * ```ts
 * const url = await guidedStep(() => runWrangler(args), "wrangler deploy failed …", deps);
 * if (url === ABORTED) return;
 * ```
 */
const guidedStep = async <T>(
  step: () => Promise<T>,
  hint: string,
  deps: GuidedDeps
): Promise<T | typeof ABORTED> => {
  for (;;) {
    try {
      return await step();
    } catch (error) {
      // CI / non-TTY: no human to guide — fail fast.
      if (!deps.interactive) throw error;

      const ui = createBrandConsole();
      ui.error(error instanceof Error ? error.message : String(error));
      ui.info(hint);
      if (!(await deps.confirm("Retry?"))) return ABORTED;
    }
  }
};

/**
 * Run the read-only infra preflight with interactive recovery: a network/scope failure fails fast in
 * CI, or (on a TTY) renders the error + hint and offers a retry. Resolves the plan, or {@link ABORTED}
 * when the user declines the retry.
 *
 * @param ctx - The deploy plugin context.
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @param deps - Interactivity + the confirm prompt.
 * @returns The infra plan, or {@link ABORTED} when a preflight retry is declined.
 * @throws {Error} Re-throws the preflight error in CI / non-interactive runs.
 * @example
 * ```ts
 * const plan = await guidedPlan(ctx, manifest, deps);
 * if (plan === ABORTED) return;
 * ```
 */
const guidedPlan = async (
  ctx: Ctx,
  manifest: ExternalManifest,
  deps: GuidedDeps
): Promise<InfraPlan | typeof ABORTED> => {
  for (;;) {
    try {
      return await planInfra(ctx, manifest);
    } catch (error) {
      if (!deps.interactive) throw error;
      const ui = createBrandConsole();
      ui.error(error instanceof Error ? error.message : String(error));
      ui.info(HINTS.provision);
      if (!(await deps.confirm("Retry?"))) return ABORTED;
    }
  }
};

/**
 * Plan + provision the infra with branded panels and interactive recovery. Each attempt RE-PLANS
 * (a resource created by a prior attempt is seen as existing and skipped — retries stay idempotent),
 * renders the plan panel (what will be created vs already exists), confirms the create gate, creates
 * the resources, then renders the result panel (created / skipped / failed). When some resources
 * FAIL it offers to retry just those (interactive) or fails fast (CI). Resolves to {@link ABORTED}
 * when the user declines the gate or a retry.
 *
 * @param ctx - The deploy plugin context.
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @param ci - Whether provisioning runs non-interactively (forwarded to each provider).
 * @param deps - Interactivity + the confirm prompt.
 * @returns The provisioning result (all created/skipped), or {@link ABORTED} when the user declined.
 * @throws {Error} Re-throws a plan error, or throws on a provision failure, in CI / non-interactive runs.
 * @example
 * ```ts
 * const provisioned = await guidedProvision(ctx, manifest, ci, deps);
 * if (provisioned === ABORTED) return;
 * ```
 */
const guidedProvision = async (
  ctx: Ctx,
  manifest: ExternalManifest,
  ci: boolean,
  deps: GuidedDeps
): Promise<ProvisionResult | typeof ABORTED> => {
  for (;;) {
    // Re-plan each attempt so a partial prior provision is reflected (already-created → skipped).
    const plan = await guidedPlan(ctx, manifest, deps);
    if (plan === ABORTED) return ABORTED;

    // Show the plan (what's to create vs already exists), then gate before creating anything.
    const ui = createBrandConsole();
    renderPlan(ui, plan);
    if (
      plan.missing.length > 0 &&
      !(await deps.confirm(
        `Create ${String(plan.missing.length)} missing resource(s) in "${plan.account}"?`
      ))
    ) {
      return ABORTED;
    }

    // Create resiliently (one bad resource never aborts the rest), then show the per-resource result.
    const result = await applyPlan(ctx, plan, ci);
    renderProvisionResult(ui, result);
    if (result.failed.length === 0) return result;

    // Some resources failed. CI has no human to guide → fail fast; otherwise offer to retry them.
    if (!deps.interactive) {
      throw new Error(
        `[moku-worker] ${String(result.failed.length)} resource(s) failed to provision.`
      );
    }
    if (!(await deps.confirm("Retry the failed resource(s)?"))) return ABORTED;
  }
};

/**
 * Build the web site first (when a hook is wired in), so its assets exist before the R2 upload and
 * `wrangler deploy`. Emits the `build · web` phase, then runs the build with interactive retry.
 *
 * @param ctx - The deploy plugin context.
 * @param webBuild - The web build hook, or undefined when none is wired (then this is a no-op).
 * @param deps - Interactivity + the confirm prompt.
 * @returns True to continue the pipeline; false when the user declined a build retry (abort).
 * @example
 * ```ts
 * if (!(await guidedWebBuild(ctx, webBuild, deps))) return emitAborted(ctx);
 * ```
 */
const guidedWebBuild = async (
  ctx: Ctx,
  webBuild: WebBuild | undefined,
  deps: GuidedDeps
): Promise<boolean> => {
  if (webBuild === undefined) return true;

  ctx.emit("deploy:phase", { phase: "build", detail: "web" });
  return (await guidedStep(() => webBuild(), HINTS.build, deps)) !== ABORTED;
};

/**
 * Upload the R2 directory when a bucket declares an upload source, with interactive retry. Emits the
 * `upload · N files` phase on success; a no-op (and emits nothing) when no bucket declares an upload.
 *
 * @param ctx - The deploy plugin context.
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @param deps - Interactivity + the confirm prompt.
 * @returns True to continue the pipeline; false when the user declined an upload retry (abort).
 * @example
 * ```ts
 * if (!(await guidedUpload(ctx, manifest, deps))) return emitAborted(ctx);
 * ```
 */
const guidedUpload = async (
  ctx: Ctx,
  manifest: ExternalManifest,
  deps: GuidedDeps
): Promise<boolean> => {
  const r2 = manifest.resources.find(
    (resource): resource is Extract<ResourceManifest, { kind: "r2" }> => resource.kind === "r2"
  );
  if (!r2?.upload) return true;

  const bucket = r2.name;
  const uploadDir = r2.upload;
  const count = await guidedStep(() => uploadDirToR2(bucket, uploadDir), HINTS.upload, deps);
  if (count === ABORTED) return false;

  ctx.emit("deploy:phase", { phase: "upload", detail: `${String(count)} files` });
  return true;
};

/**
 * The final deploy step: confirm the target (guided only), run `wrangler deploy` with interactive
 * retry, then emit deploy:complete. Returns the deployed URL, or undefined when the target gate or a
 * deploy retry is declined (so the caller renders the summary panel only on a real success).
 *
 * @param ctx - The deploy plugin context.
 * @param manifest - The assembled (or caller-supplied) deploy manifest.
 * @param stage - The resolved deploy stage (for the confirm prompt).
 * @param deps - Interactivity + the confirm prompt.
 * @returns The deployed URL once live; undefined when the user declined the gate or a retry (abort).
 * @example
 * ```ts
 * const url = await guidedDeployStep(ctx, manifest, stage, deps);
 * if (url === undefined) return emitAborted(ctx);
 * ```
 */
const guidedDeployStep = async (
  ctx: Ctx,
  manifest: ExternalManifest,
  stage: string,
  deps: GuidedDeps
): Promise<string | undefined> => {
  if (!(await deps.confirm(`Deploy "${manifest.name}" to ${stage}?`))) return undefined;

  ctx.emit("deploy:phase", { phase: "deploy" });
  const url = await guidedStep(
    () => runWrangler(["deploy", "--config", ctx.config.configFile]),
    HINTS.deploy,
    deps
  );
  if (url === ABORTED) return undefined;

  ctx.emit("deploy:complete", { url });
  return url;
};

/**
 * Apply pending D1 migrations to the REMOTE database for every configured d1 instance that ships a
 * migrations dir — the generic, deploy-owned analogue of `wrangler d1 migrations apply <binding>
 * --remote`. The wrangler config was written earlier in the pipeline, so each binding resolves. The
 * caller runs this only AFTER a successful deploy, so a deploy that never happened never migrates a
 * remote DB. CAPTURES wrangler's output (the raw TUI is hidden; {@link parseMigrationsApplied} turns
 * it into the branded panel's facts); throws on the first non-zero exit (the caller folds it into the
 * report, where the captured error is still surfaced).
 *
 * @param ctx - The deploy plugin context.
 * @returns The per-database migration outcomes (one per d1 instance that declares migrations).
 * @example
 * ```ts
 * const outcomes = await applyRemoteMigrations(ctx);
 * ```
 */
const applyRemoteMigrations = async (ctx: Ctx): Promise<MigrationOutcome[]> => {
  if (!ctx.has("d1")) return [];

  const outcomes: MigrationOutcome[] = [];
  for (const database of ctx.require(d1Plugin).deployManifest()) {
    if (database.migrations !== undefined) {
      const output = await runWrangler(["d1", "migrations", "apply", database.binding, "--remote"]);
      outcomes.push({ binding: database.binding, ...parseMigrationsApplied(output) });
    }
  }
  return outcomes;
};

/** The migration + seed outcome of the post-deploy stage, folded into the {@link DeployReport}. */
type PostDeploy = {
  /** Remote D1 migration outcome. */
  migration: DeployReport["migration"];
  /** Remote seed outcome. */
  seed: DeployReport["seed"];
  /** Branded failure messages captured (not thrown) so the report stays rich on a partial failure. */
  errors: string[];
};

/**
 * Render a post-deploy step's failure as a branded line and capture its message into `errors` —
 * folding the failure into the report instead of throwing, so a deploy that already went live still
 * yields a complete, honest report when a later remote step (migration/seed) fails.
 *
 * @param ui - The branded console to render the error through.
 * @param errors - The accumulator the captured message is pushed into.
 * @param error - The thrown error (or value) to brand and capture.
 * @returns The captured (branded) message.
 * @example
 * ```ts
 * captureFailure(ui, errors, new Error("[moku-worker] seed failed"));
 * ```
 */
const captureFailure = (
  ui: ReturnType<typeof createBrandConsole>,
  errors: string[],
  error: unknown
): string => {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(message);
  errors.push(message);
  return message;
};

/**
 * Run the post-deploy remote steps — REACHED ONLY ON A SUCCESSFUL DEPLOY (every gate in `run` returns
 * early before here), so a deploy that never happened never touches a remote DB. Applies remote D1
 * migrations (when requested), then loads the configured seed (when requested) — but skips the seed
 * if the migration it depends on failed. Each step's failure is RENDERED inline and CAPTURED in
 * `errors` (never thrown), so one failed step still yields a complete, honest report.
 *
 * @param ctx - The deploy plugin context.
 * @param want - Which post-steps the caller requested.
 * @param want.migration - Whether to apply pending remote D1 migrations.
 * @param want.seed - Whether to load the configured remote seed (and reset its KV keys).
 * @returns The migration + seed outcomes and any captured branded errors.
 * @example
 * ```ts
 * const post = await runPostDeploy(ctx, { migration: true, seed: true });
 * ```
 */
const runPostDeploy = async (
  ctx: Ctx,
  want: { migration: boolean; seed: boolean }
): Promise<PostDeploy> => {
  const ui = createBrandConsole();
  const errors: string[] = [];

  // Apply remote migrations first — the seed below depends on the schema they create. Wrangler's raw
  // migration TUI is captured (hidden); the branded panel reports exactly what applied.
  let migration: DeployReport["migration"] = "skipped";
  if (want.migration) {
    try {
      ctx.emit("deploy:phase", { phase: "migrate", detail: "remote D1" });
      const outcomes = await applyRemoteMigrations(ctx);
      migration = "applied";
      if (outcomes.length > 0) renderMigrateSummary(ui, outcomes, "remote");
    } catch (error) {
      migration = "failed";
      captureFailure(ui, errors, error);
    }
  }

  // Seed needs the schema the migration creates — skip it when that migration failed.
  let seed: DeployReport["seed"] = "skipped";
  if (want.seed && migration === "failed") {
    seed = "failed";
    captureFailure(
      ui,
      errors,
      new Error("[moku-worker] seed skipped — the remote migration it depends on failed.")
    );
  } else if (want.seed) {
    const config = ctx.config.seed;
    if (config === undefined) {
      seed = "failed";
      captureFailure(
        ui,
        errors,
        new Error(
          "[moku-worker] deploy({ seed: true }) but no seed is configured — set pluginConfigs.deploy.seed."
        )
      );
    } else {
      try {
        ctx.emit("deploy:phase", { phase: "seed", detail: config.file });
        const outcome = await runConfiguredSeed(ctx, runWrangler, config, "--remote");
        seed = "applied";
        renderSeedSummary(ui, outcome, "remote");
      } catch (error) {
        seed = "failed";
        captureFailure(ui, errors, error);
      }
    }
  }

  return { migration, seed, errors };
};

/**
 * Create the deploy api. Assembles the manifest from each resource plugin's own deployManifest(),
 * runs an infra preflight (check-before-create + id capture), generates config, uploads, and runs
 * `wrangler deploy`, emitting global deploy events along the way.
 *
 * @param ctx - Plugin context (own config + require + has + emit + global + env).
 * @returns The app.deploy api: run / dev / init / checkInfra / provisionInfra.
 * @example
 * ```ts
 * const api = createDeployApi(ctx);
 * await api.run();
 * ```
 */
export const createDeployApi = (ctx: Ctx) => ({
  /**
   * Run the full deploy pipeline: detect → preflight (check-before-create) → provision (only the
   * missing) → wrangler-config (with real ids) → upload → deploy, then — ONLY on a successful
   * deploy — the requested post-deploy remote steps (migration, seed). When opts.manifest is
   * supplied it is used verbatim (universal path).
   *
   * On a TTY the run is GUIDED end to end: each gate is confirmed, and every failure is recovered
   * interactively rather than thrown — a missing/invalid token offers a `.env.local` scaffold, and
   * the build, infra, upload, and `wrangler deploy` steps offer a retry. In CI/pipes it fails fast
   * (no prompt, the first error propagates to the branded CLI handler).
   *
   * Resolves to a {@link DeployReport}. Every abort path (a declined gate, or auth never set up)
   * returns `status: "aborted"` BEFORE the post-deploy steps, so `migration`/`seed` run only when
   * the worker actually went live — a first `deploy --seed` with no token aborts cleanly instead of
   * falling through to a raw `wrangler … --remote` auth error.
   *
   * @param opts - Optional run options.
   * @param opts.ci - CI/automated mode: never prompts, auto-confirms every gate, fails fast. When
   *   false (the default) and stdout is a TTY, the deploy is guided — each gate is confirmed and
   *   failures are recovered interactively. Falls back to ctx.config.ci when omitted.
   * @param opts.stage - Target stage; suffixes resource names (`production` = bare). Falls back to the app stage.
   * @param opts.webBuild - Build the web site first (e.g. `() => webApp.cli.build()`), before deploy.
   * @param opts.manifest - Caller-supplied manifest (bypasses deployManifest() assembly).
   * @param opts.migration - After a successful deploy, apply pending remote D1 migrations for every
   *   configured d1 instance that ships migrations. Skipped (not attempted) on an aborted deploy.
   * @param opts.seed - After a successful deploy (+ migration), load the seed configured under
   *   `pluginConfigs.deploy.seed` into the remote D1 and reset its cached KV keys. Skipped on abort.
   * @returns The deploy report (status, url, resource tally, migration/seed outcome, errors).
   * @example
   * ```ts
   * const report = await api.run({ webBuild: () => web.cli.build(), migration: true, seed: true });
   * if (!report.ok) process.exitCode = 1; // aborted or a post-step failed
   * ```
   */
  async run(opts?: {
    ci?: boolean;
    stage?: string;
    webBuild?: WebBuild;
    manifest?: ExternalManifest;
    migration?: boolean;
    seed?: boolean;
  }): Promise<DeployReport> {
    // CI — the explicit opt, else the standing config default — is automated: never prompt,
    // auto-confirm every gate, fail fast on any error. Otherwise the deploy is GUIDED whenever
    // stdout is a real TTY: each gate is confirmed and every failure becomes an interactive
    // recovery (offer the `.env.local` scaffold / retry the step) instead of a hard stop.
    const ci = opts?.ci ?? ctx.config.ci;
    // Stage drives the resource-name suffix (production = bare name); `--stage`/opts override config.
    const stage = opts?.stage ?? ctx.global.stage;
    const interactive = !ci && stdoutIsTty();
    const confirm = interactive
      ? createBrandPrompts().confirm
      : async (_question: string): Promise<boolean> => true;
    const deps: GuidedDeps = { interactive, confirm };

    // Wall-clock start — the terminal summary panel reports how long the whole deploy took.
    const startedAt = Date.now();

    // Auth preflight — verify the .env token up front. A missing/invalid token is guided (offer the
    // `.env.local` scaffold, then point at the re-run), not a silent stack trace.
    ctx.emit("deploy:phase", { phase: "auth" });
    if (!(await guidedAuth(ctx, deps))) return aborted(ctx, stage, startedAt);

    // Build the web site first (when a hook is wired in from the consumer's script).
    const webBuild = opts?.webBuild ?? ctx.config.webBuild;
    if (!(await guidedWebBuild(ctx, webBuild, deps))) return aborted(ctx, stage, startedAt);

    // Manifest from each plugin's OWN deployManifest() api — never sibling pluginConfigs (F6).
    ctx.emit("deploy:phase", { phase: "detect" });
    const manifest: ExternalManifest = opts?.manifest ?? assembleManifest(ctx, stage);

    // Preflight + provision: discover what exists, confirm before creating (guided), create the
    // rest — retrying the whole plan→create unit on failure so it stays idempotent.
    ctx.emit("deploy:phase", { phase: "provision" });
    const provisioned = await guidedProvision(ctx, manifest, ci, deps);
    if (provisioned === ABORTED) return aborted(ctx, stage, startedAt);

    // Generate/update the wrangler config from the assembled manifest (with the captured ids), plus
    // the app's `wrangler` passthrough (main / compatibility_flags / assets / …) and auto DO migrations.
    ctx.emit("deploy:phase", { phase: "wrangler-config" });
    await writeWranglerConfig(
      ctx.config.configFile,
      manifest,
      provisioned.ids,
      wranglerExtra(ctx.config)
    );

    // Upload the R2 directory when a bucket declares an upload source.
    if (!(await guidedUpload(ctx, manifest, deps))) return aborted(ctx, stage, startedAt);

    // Confirm the deploy target (guided only), then hand off to `wrangler deploy` (with retry).
    const url = await guidedDeployStep(ctx, manifest, stage, deps);
    if (url === undefined) return aborted(ctx, stage, startedAt);

    // Terminal summary panel — the deployed URL leads (the headline), then stage, the resource tally,
    // and how long the whole deploy took.
    const resources = {
      created: provisioned.created.length,
      exists: provisioned.skipped.length,
      bundled: provisioned.bundled.length,
      failed: provisioned.failed.length
    };
    renderDeploySummary(createBrandConsole(), {
      url,
      stage,
      ...resources,
      elapsedMs: Date.now() - startedAt
    });

    // Post-deploy remote steps — REACHED ONLY HERE, after a live deploy (every gate above returns
    // early). Migration + seed run against the remote DB and fold any failure into the report rather
    // than throwing, so the report is complete whether they ran, were skipped, or failed.
    const post = await runPostDeploy(ctx, {
      migration: opts?.migration === true,
      seed: opts?.seed === true
    });

    return {
      ok: post.errors.length === 0,
      status: post.errors.length === 0 ? "deployed" : "failed",
      stage,
      url,
      resources,
      migration: post.migration,
      seed: post.seed,
      elapsedMs: Date.now() - startedAt,
      errors: post.errors
    };
  },

  /**
   * Start a long-lived local dev session: cold-build the Moku site, spawn `wrangler dev
   * --live-reload`, and watch the site sources — rebuilding on change (wrangler live-reloads the
   * browser). Resolves on SIGINT.
   *
   * @param opts - Optional options.
   * @param opts.port - Local dev port (default 8787).
   * @param opts.stage - Stage for the generated config's resource names (defaults to the app stage).
   * @param opts.webBuild - Cold-build the web site (e.g. `() => webApp.cli.build()`); also the
   *   per-change rebuild when `onChange` is omitted.
   * @param opts.onChange - Incremental per-change rebuild (e.g. `changes => webApp.cli.update(changes)`).
   * @param opts.seed - Load the configured seed (`pluginConfigs.deploy.seed`) into the LOCAL D1 and
   *   reset its cached KV keys before serving — the local analogue of `deploy({ seed: true })`.
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await api.dev({ port: 8787, seed: true, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
   * ```
   */
  async dev(opts?: {
    port?: number;
    stage?: string;
    webBuild?: WebBuild;
    onChange?: OnChange;
    seed?: boolean;
  }): Promise<void> {
    // Generate wrangler.jsonc up front so first-run `wrangler dev` has a config to read. Empty ids —
    // writeWranglerConfig preserves any ids already in the file (e.g. captured by a prior deploy).
    const stage = opts?.stage ?? ctx.global.stage;
    const manifest = assembleManifest(ctx, stage);
    await writeWranglerConfig(ctx.config.configFile, manifest, {}, wranglerExtra(ctx.config));
    await runDev(ctx, opts, realDevDeps());
  },

  /**
   * Execute a SQL file against a configured D1 database via `wrangler d1 execute` — for seeding dev
   * data. Local by default (applies that database's migrations first so the file's tables exist);
   * `opts.remote` seeds Cloudflare (schema is applied by `deploy`). Generates the wrangler config up
   * front so the binding resolves even on a first run. CAPTURES wrangler's output and renders a
   * branded "Migrated" / "Seeded" summary (the raw migration/execute TUI is hidden) so the command
   * reads the same as the rest of the deploy UX; a failure still surfaces the real wrangler error.
   *
   * @param sqlFile - Path to the SQL file to execute (e.g. "db/seed.sql").
   * @param opts - Optional options.
   * @param opts.stage - Stage for the generated config's resource names (defaults to the app stage).
   * @param opts.binding - The d1 binding to target when more than one is configured (e.g. "DB").
   * @param opts.remote - Seed the remote (Cloudflare) D1 instead of the local one.
   * @returns Resolves once wrangler finishes executing the file and the summary is rendered.
   * @example
   * ```ts
   * await api.seed("db/seed.sql");                   // local default d1 (migrate, then execute)
   * await api.seed("db/seed.sql", { remote: true }); // remote d1
   * ```
   */
  async seed(
    sqlFile: string,
    opts?: { stage?: string; binding?: string; remote?: boolean }
  ): Promise<void> {
    if (!ctx.has("d1")) {
      throw new Error("[moku-worker] seed: no d1 database is configured.");
    }

    // Generate the wrangler config up front so `d1 …` can resolve the binding even on a first run
    // (idempotent — writeWranglerConfig preserves any ids already in the file).
    const stage = opts?.stage ?? ctx.global.stage;
    await writeWranglerConfig(
      ctx.config.configFile,
      assembleManifest(ctx, stage),
      {},
      wranglerExtra(ctx.config)
    );

    // Resolve the target database: the only configured one, or the instance bound to opts.binding.
    const target = resolveD1(ctx, opts?.binding);
    const scope = opts?.remote === true ? "--remote" : "--local";
    const where = opts?.remote === true ? "remote" : "local";
    const ui = createBrandConsole();

    // Local seed (default): apply this database's migrations first so the file's tables exist —
    // capturing wrangler's output to brand it. Remote seeds run against the schema `deploy` applied.
    if (scope === "--local" && target.migrations !== undefined) {
      const migrated = await runWrangler(["d1", "migrations", "apply", target.binding, "--local"]);
      renderMigrateSummary(
        ui,
        [{ binding: target.binding, ...parseMigrationsApplied(migrated) }],
        where
      );
    }

    // Execute the SQL file, then brand WHAT was loaded (best-effort counts; this path resets no KV).
    const executed = await runWrangler(["d1", "execute", target.binding, scope, "--file", sqlFile]);
    renderSeedSummary(
      ui,
      { file: sqlFile, binding: target.binding, resetKv: [], ...parseSeedStats(executed) },
      where
    );
  },

  /**
   * Scaffold a starting wrangler config (and CI files when ci is set).
   * Idempotent: an existing config file is left untouched.
   *
   * @param opts - Optional options.
   * @param opts.ci - Also scaffold CI workflow files.
   * @returns Resolves once scaffolding is written.
   * @example
   * ```ts
   * await api.init({ ci: true });
   * ```
   */
  init: async (opts?: { ci?: boolean }): Promise<void> => {
    await scaffoldWranglerAndCi(ctx.config.configFile, opts?.ci ?? ctx.config.ci);
  },

  /**
   * Read-only infra preflight: assemble the manifest, resolve the account, list what exists in
   * Cloudflare, diff, emit provision:plan, and return the plan. Writes nothing.
   *
   * @returns The infra plan (existing vs missing resources, with captured ids).
   * @example
   * ```ts
   * const plan = await api.checkInfra();
   * ```
   */
  checkInfra: (): Promise<InfraPlan> => planInfra(ctx, assembleManifest(ctx, ctx.global.stage)),

  /**
   * Create only the resources missing from the plan (skipping existing), capturing each id.
   *
   * @param plan - A plan produced by checkInfra().
   * @returns The provisioning result: created, skipped, and the merged id map.
   * @example
   * ```ts
   * const { created } = await api.provisionInfra(await api.checkInfra());
   * ```
   */
  provisionInfra: (plan: InfraPlan): Promise<ProvisionResult> =>
    applyPlan(ctx, plan, ctx.config.ci),

  /**
   * Verify the `.env` Cloudflare API token (must be active) and resolve its account; emits
   * auth:verified. Throws a branded error pointing at `auth setup` when absent/invalid/inactive.
   *
   * @returns The verified auth status (account + id).
   * @example
   * ```ts
   * const { account } = await api.verifyAuth();
   * ```
   */
  verifyAuth: (): Promise<AuthStatus> => runVerifyAuth(ctx),

  /**
   * Derive the minimum Cloudflare API token this app needs from its manifest (pure, no network).
   *
   * @returns The token requirement (full set + groups to add to the stock template).
   * @example
   * ```ts
   * const { toAdd } = api.requiredToken();
   * ```
   */
  requiredToken: (): TokenRequirement =>
    deriveRequiredToken(assembleManifest(ctx, ctx.global.stage)),

  /**
   * Derive the REDUCED CI/automation redeploy token permission groups from the manifest (pure, no
   * network). Used by the branded `auth setup` renderer to show the scoped CI token alongside the
   * full LOCAL one.
   *
   * @returns The CI token permission groups (read-mostly, manifest-scoped).
   * @example
   * ```ts
   * const groups = api.ciToken();
   * ```
   */
  ciToken: (): PermissionGroup[] => deriveCiToken(assembleManifest(ctx, ctx.global.stage)),

  /**
   * Render the `auth setup` guidance from the derived token requirement (pure, no network).
   *
   * @returns The rendered instruction text.
   * @example
   * ```ts
   * const text = api.tokenInstructions();
   * ```
   */
  tokenInstructions: (): string => renderTokenInstructions(assembleManifest(ctx, ctx.global.stage)),

  /**
   * Run an arbitrary wrangler command, streaming its output (the branded CLI escape hatch).
   *
   * @param args - The wrangler arguments.
   * @returns Resolves once wrangler exits.
   * @example
   * ```ts
   * await api.wrangler(["kv", "namespace", "list"]);
   * ```
   */
  wrangler: (args: string[]): Promise<void> => runWranglerInherit(args)
});
