/**
 * @file deploy plugin — API factory (run, dev, init).
 *
 * Pure ctx-taking factory. Assembles the deploy manifest from each resource plugin's own
 * deployManifest() api (never sibling pluginConfigs — design F6), provisions resources,
 * generates/updates the wrangler config, uploads the R2 upload dir, and runs wrangler deploy.
 * Emits only global events: deploy:phase, deploy:complete, provision:resource.
 *
 * Node-only: uses node:child_process (via runner.ts) and node:fs (via wrangler-config.ts).
 * Never called in the deployed Worker runtime.
 */
import { d1Plugin } from "../d1";
import { durableObjectsPlugin } from "../durable-objects";
import { kvPlugin } from "../kv";
import { queuesPlugin } from "../queues";
import { storagePlugin } from "../storage";
import { provisionResource } from "./providers";
import { uploadDirToR2 } from "./providers/r2";
import { runWrangler } from "./runner";
import type { Ctx, ExternalManifest, ResourceManifest } from "./types";
import { scaffoldWranglerAndCi, writeWranglerConfig } from "./wrangler-config";

/**
 * Derive a human-readable name string from a resource descriptor (used in provision:resource).
 *
 * @param resource - The resource descriptor.
 * @returns A name suitable for the provision:resource event payload.
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
 * Create the deploy api. Assembles the manifest from each resource plugin's own
 * deployManifest() (never sibling config), provisions, generates config, uploads,
 * and runs `wrangler deploy`, emitting global deploy events along the way.
 *
 * @param ctx - Plugin context (own config + require + has + emit + global).
 * @returns The app.deploy api: run / dev / init.
 * @example
 * ```ts
 * const api = createDeployApi(ctx);
 * await api.run();
 * ```
 */
export const createDeployApi = (ctx: Ctx) => ({
  /**
   * Run the full deploy pipeline: detect → provision → wrangler-config → upload → deploy.
   * When opts.manifest is supplied, it is used verbatim (universal path).
   *
   * @param opts - Optional run options.
   * @param opts.guided - Enable interactive confirmation steps (skipped when ci=true).
   * @param opts.yes - Auto-confirm all prompts.
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
    const manifest: ExternalManifest = opts?.manifest ?? {
      name: ctx.global.name,
      compatibilityDate: ctx.global.compatibilityDate,
      resources: [
        ctx.has("storage") ? ctx.require(storagePlugin).deployManifest() : undefined,
        ctx.has("kv") ? ctx.require(kvPlugin).deployManifest() : undefined,
        ctx.has("d1") ? ctx.require(d1Plugin).deployManifest() : undefined,
        ctx.has("queues") ? ctx.require(queuesPlugin).deployManifest() : undefined,
        ctx.has("durableObjects") ? ctx.require(durableObjectsPlugin).deployManifest() : undefined
      ].filter((resource): resource is NonNullable<typeof resource> => resource !== undefined)
    };

    ctx.emit("deploy:phase", { phase: "provision" });
    for (const resource of manifest.resources) {
      await provisionResource(resource, ctx.config.ci);
      ctx.emit("provision:resource", { kind: resource.kind, name: resourceName(resource) });
    }

    ctx.emit("deploy:phase", { phase: "wrangler-config" });
    await writeWranglerConfig(ctx.config.configFile, manifest);

    const r2Resource = manifest.resources.find(
      (resource): resource is Extract<ResourceManifest, { kind: "r2" }> => resource.kind === "r2"
    );
    if (r2Resource?.upload) {
      const count = await uploadDirToR2(r2Resource.bucket, r2Resource.upload);
      ctx.emit("deploy:phase", { phase: "upload", detail: `${String(count)} files` });
    }

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
  }
});
