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
import { d1Plugin } from "../d1";
import { durableObjectsPlugin } from "../durable-objects";
import { kvPlugin } from "../kv";
import { queuesPlugin } from "../queues";
import { storagePlugin } from "../storage";
import { requiredToken as deriveRequiredToken } from "./auth/permissions";
import { tokenInstructions as renderTokenInstructions } from "./auth/setup";
import { verifyAuth as runVerifyAuth } from "./auth/verify";
import { planInfra } from "./infra/plan";
import { provisionResource } from "./providers";
import { uploadDirToR2 } from "./providers/r2";
import { runWrangler } from "./runner";
import type {
  AuthStatus,
  Ctx,
  ExternalManifest,
  InfraPlan,
  ProvisionedRef,
  ProvisionResult,
  ResourceManifest,
  TokenRequirement
} from "./types";
import { scaffoldWranglerAndCi, writeWranglerConfig } from "./wrangler-config";

/**
 * Derive a human-readable name string from a resource descriptor (used in provision events).
 *
 * @param resource - The resource descriptor.
 * @returns A name suitable for the provision:resource / provision:skip event payload.
 * @example
 * ```ts
 * resourceName({ kind: "kv", binding: "CACHE" }); // "CACHE"
 * ```
 */
const resourceName = (resource: ResourceManifest): string => {
  switch (resource.kind) {
    case "r2": {
      return resource.bucket;
    }
    case "do": {
      return Object.values(resource.bindings).join(",");
    }
    case "queue": {
      return resource.producers.join(",");
    }
    default: {
      return resource.binding;
    }
  }
};

/**
 * Assemble the deploy manifest from each present resource plugin's OWN deployManifest() api,
 * gated by ctx.has(name) so absent plugins are skipped — never sibling pluginConfigs (F6).
 *
 * @param ctx - The deploy plugin context.
 * @returns The assembled manifest (name, compatibilityDate, resources).
 * @example
 * ```ts
 * const manifest = assembleManifest(ctx);
 * ```
 */
const assembleManifest = (ctx: Ctx): ExternalManifest => ({
  name: ctx.global.name,
  compatibilityDate: ctx.global.compatibilityDate,
  resources: [
    ctx.has("storage") ? ctx.require(storagePlugin).deployManifest() : undefined,
    ctx.has("kv") ? ctx.require(kvPlugin).deployManifest() : undefined,
    ctx.has("d1") ? ctx.require(d1Plugin).deployManifest() : undefined,
    ctx.has("queues") ? ctx.require(queuesPlugin).deployManifest() : undefined,
    ctx.has("durableObjects") ? ctx.require(durableObjectsPlugin).deployManifest() : undefined
  ].filter((resource): resource is NonNullable<typeof resource> => resource !== undefined)
});

/**
 * Act on an infra plan: skip the resources that already exist (reusing their ids), create only
 * the missing ones (capturing each new id), and announce each via provision:skip / :resource.
 *
 * @param ctx - The deploy plugin context.
 * @param plan - The infra plan from planInfra (existing vs missing).
 * @returns The provisioning result: created, skipped, and the merged binding → id map.
 * @example
 * ```ts
 * const { ids } = await applyPlan(ctx, plan);
 * ```
 */
const applyPlan = async (ctx: Ctx, plan: InfraPlan): Promise<ProvisionResult> => {
  const ids: Record<string, string> = {};

  // Reuse the ids of resources that already exist; announce each as skipped.
  for (const ref of plan.exists) {
    if (ref.id !== undefined && (ref.resource.kind === "kv" || ref.resource.kind === "d1")) {
      ids[ref.resource.binding] = ref.id;
    }
    ctx.emit("provision:skip", { kind: ref.resource.kind, name: resourceName(ref.resource) });
  }

  // Create only the missing resources; capture each new id (kv/d1).
  const created: ProvisionedRef[] = [];
  for (const resource of plan.missing) {
    const { id } = await provisionResource(resource, ctx.config.ci);

    if (id !== undefined && (resource.kind === "kv" || resource.kind === "d1")) {
      ids[resource.binding] = id;
    }

    created.push(id === undefined ? { resource } : { resource, id });
    ctx.emit("provision:resource", { kind: resource.kind, name: resourceName(resource) });
  }

  return { created, skipped: plan.exists, ids };
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
   * missing) → wrangler-config (with real ids) → upload → deploy. When opts.manifest is supplied
   * it is used verbatim (universal path).
   *
   * @param opts - Optional run options.
   * @param opts.guided - Enable interactive confirmation steps (wired in a later phase).
   * @param opts.yes - Auto-confirm all prompts (wired in a later phase).
   * @param opts.manifest - Caller-supplied manifest (bypasses deployManifest() assembly).
   * @returns Resolves once the deploy completes.
   * @example
   * ```ts
   * await api.run({ guided: true });
   * await api.run({ manifest: { name: "w", compatibilityDate: "2026-06-17", resources: [] } });
   * ```
   */
  async run(opts?: {
    guided?: boolean;
    yes?: boolean;
    manifest?: ExternalManifest;
  }): Promise<void> {
    ctx.emit("deploy:phase", { phase: "detect" });

    // Manifest from each plugin's OWN deployManifest() api — never sibling pluginConfigs (F6).
    const manifest: ExternalManifest = opts?.manifest ?? assembleManifest(ctx);

    // Preflight: discover what already exists, then create only the missing (idempotent).
    ctx.emit("deploy:phase", { phase: "provision" });
    const plan = await planInfra(ctx, manifest);
    const { ids } = await applyPlan(ctx, plan);

    // Generate/update the wrangler config from the assembled manifest (with the captured ids).
    ctx.emit("deploy:phase", { phase: "wrangler-config" });
    await writeWranglerConfig(ctx.config.configFile, manifest, ids);

    // Upload the R2 directory when a bucket declares an upload source.
    const r2Resource = manifest.resources.find(
      (resource): resource is Extract<ResourceManifest, { kind: "r2" }> => resource.kind === "r2"
    );
    if (r2Resource?.upload) {
      const count = await uploadDirToR2(r2Resource.bucket, r2Resource.upload);
      ctx.emit("deploy:phase", { phase: "upload", detail: `${String(count)} files` });
    }

    // Hand off to `wrangler deploy` and report the deployed URL.
    ctx.emit("deploy:phase", { phase: "deploy" });
    const url = await runWrangler(["deploy", "--config", ctx.config.configFile]);
    ctx.emit("deploy:complete", { url });
  },

  /**
   * Start a local Cloudflare dev session via `wrangler dev`.
   *
   * @param opts - Optional options.
   * @param opts.port - Local dev port (default 8787).
   * @returns Resolves when the dev session ends.
   * @example
   * ```ts
   * await api.dev({ port: 8787 });
   * ```
   */
  dev: async (opts?: { port?: number }): Promise<void> => {
    await runWrangler([
      "dev",
      "--port",
      String(opts?.port ?? 8787),
      "--config",
      ctx.config.configFile
    ]);
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
  checkInfra: (): Promise<InfraPlan> => planInfra(ctx, assembleManifest(ctx)),

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
  provisionInfra: (plan: InfraPlan): Promise<ProvisionResult> => applyPlan(ctx, plan),

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
  requiredToken: (): TokenRequirement => deriveRequiredToken(assembleManifest(ctx)),

  /**
   * Render the `auth setup` guidance from the derived token requirement (pure, no network).
   *
   * @returns The rendered instruction text.
   * @example
   * ```ts
   * const text = api.tokenInstructions();
   * ```
   */
  tokenInstructions: (): string =>
    renderTokenInstructions(deriveRequiredToken(assembleManifest(ctx)))
});
