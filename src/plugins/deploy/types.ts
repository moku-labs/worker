/**
 * @file deploy plugin — type definitions skeleton.
 */
import type { PluginCtx } from "@moku-labs/core";
import type { WorkerEvents } from "../../config";

/** deploy plugin configuration. Flat; complete defaults so omission never yields undefined. */
export type Config = {
  /** Wrangler config file generated/updated and read by `wrangler deploy`. Default "wrangler.jsonc". */
  configFile: string;
  /** Non-interactive mode. Default false. */
  ci: boolean;
};

/** Discriminated union of resource descriptors returned by each plugin's deployManifest(). */
export type ResourceManifest =
  | { kind: "r2"; bucket: string; upload?: string }
  | { kind: "kv"; binding: string }
  | { kind: "d1"; binding: string; migrations?: string }
  | { kind: "queue"; producers: string[] }
  | { kind: "do"; bindings: Record<string, string> };

/** The whole deploy manifest the pipeline consumes (assembled, or caller-supplied for the universal path). */
export type ExternalManifest = {
  /** Worker name. */
  name: string;
  /** Cloudflare compatibility date. */
  compatibilityDate: string;
  /** Resource descriptors to provision. */
  resources: ResourceManifest[];
};

/** Public api surface of the deploy plugin. */
export type Api = {
  /**
   * Run the full deploy pipeline (detect -> provision -> config -> upload -> deploy).
   *
   * @param opts - Optional guided/yes flags or a caller-supplied universal manifest.
   * @param opts.guided - Walk through each step interactively.
   * @param opts.yes - Skip confirmation prompts (non-interactive).
   * @param opts.manifest - Caller-supplied universal manifest (bypasses auto-detection).
   * @returns Resolves once the deploy completes.
   */
  run(opts?: { guided?: boolean; yes?: boolean; manifest?: ExternalManifest }): Promise<void>;
  /**
   * Start a local Cloudflare dev session via `wrangler dev`.
   *
   * @param opts - Optional port override.
   * @param opts.port - Local dev port to bind.
   * @returns Resolves when the dev session ends.
   */
  dev(opts?: { port?: number }): Promise<void>;
  /**
   * Scaffold a starting wrangler config (and CI files when ci is set).
   *
   * @param opts - Optional ci flag.
   * @param opts.ci - Also scaffold CI workflow files.
   * @returns Resolves once scaffolding is written.
   */
  init(opts?: { ci?: boolean }): Promise<void>;
};

/** Internal context type — own config first, no state, global events only. */
export type Ctx = PluginCtx<Config, Record<string, never>, WorkerEvents>;
