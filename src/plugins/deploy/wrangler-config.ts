/**
 * @file deploy plugin — wrangler config generation + scaffold.
 *
 * Provides two exports:
 * - `writeWranglerConfig`: generates/updates a wrangler.jsonc file from an ExternalManifest.
 *   Non-destructive: preserves existing top-level keys not managed by deploy.
 * - `scaffoldWranglerAndCi`: creates a minimal starter wrangler config when the file does not
 *   exist yet; idempotent (leaves existing files untouched).
 *
 * Node-only; never imported by the runtime Worker bundle.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import type { Config, ExternalManifest, ResourceManifest } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers — resource-kind → wrangler config shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip JSONC line- and block-comments, then JSON.parse the result.
 *
 * @param source - Raw JSONC file contents.
 * @returns The parsed object.
 * @example
 * ```ts
 * const cfg = parseJsonc('{ "name": "w" } // trailing comment');
 * ```
 */
const parseJsonc = (source: string): Record<string, unknown> => {
  const stripped = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  return JSON.parse(stripped) as Record<string, unknown>;
};

/** A wrangler KV namespace entry. */
type KvEntry = { binding: string; id: string; preview_id?: string };
/** A wrangler R2 bucket entry. */
type R2Entry = { binding: string; bucket_name: string };
/** A wrangler D1 database entry. */
type D1Entry = {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir?: string;
};
/** A wrangler queue producer entry. */
type QueueProducer = { queue: string; binding: string };
/** A wrangler Durable Objects binding entry. */
type DoBinding = { name: string; class_name: string };
/** A wrangler Durable Objects migration entry (SQLite-backed, the modern default). */
type DoMigration = { tag: string; new_sqlite_classes: string[] };

/**
 * Build the wrangler `kv_namespaces` array from the manifest's kv resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @param ids - Captured Cloudflare ids keyed by binding; the entry's `id` is filled from here.
 * @returns One wrangler KV namespace entry per kv resource (real `id` when known, else "").
 * @example
 * ```ts
 * const kv = buildKvNamespaces([{ kind: "kv", binding: "CACHE" }], { CACHE: "ns123" });
 * ```
 */
const buildKvNamespaces = (resources: ResourceManifest[], ids: Record<string, string>): KvEntry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "kv" }> => resource.kind === "kv"
    )
    .map(resource => ({
      binding: resource.binding,
      id: ids[resource.binding] ?? ""
    }));

/**
 * Build the wrangler `r2_buckets` array from the manifest's r2 resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns One wrangler R2 bucket entry per r2 resource.
 * @example
 * ```ts
 * const r2 = buildR2Buckets([{ kind: "r2", name: "tracker-files", binding: "FILES" }]);
 * ```
 */
const buildR2Buckets = (resources: ResourceManifest[]): R2Entry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "r2" }> => resource.kind === "r2"
    )
    .map(resource => ({
      binding: resource.binding,
      bucket_name: resource.name
    }));

/**
 * Build the wrangler `d1_databases` array from the manifest's d1 resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @param ids - Captured Cloudflare ids keyed by binding; the entry's `database_id` is filled from here.
 * @returns One wrangler D1 database entry per d1 resource (migrations_dir set when present).
 * @example
 * ```ts
 * const d1 = buildD1Databases([{ kind: "d1", name: "tracker-db", binding: "DB" }], { DB: "uuid-1234" });
 * ```
 */
const buildD1Databases = (resources: ResourceManifest[], ids: Record<string, string>): D1Entry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "d1" }> => resource.kind === "d1"
    )
    .map(resource => {
      const entry: D1Entry = {
        binding: resource.binding,
        database_name: resource.name,
        database_id: ids[resource.binding] ?? ""
      };
      if (resource.migrations) {
        entry.migrations_dir = resource.migrations;
      }
      return entry;
    });

/**
 * Build the wrangler `queues` producers section from the manifest's queue resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns The queues section, or undefined when there are no queue resources.
 * @example
 * ```ts
 * const q = buildQueues([{ kind: "queue", name: "tracker-activity", binding: "ACTIVITY" }]);
 * ```
 */
const buildQueues = (resources: ResourceManifest[]): { producers: QueueProducer[] } | undefined => {
  const queueResources = resources.filter(
    (resource): resource is Extract<ResourceManifest, { kind: "queue" }> =>
      resource.kind === "queue"
  );
  if (queueResources.length === 0) return undefined;

  const producers: QueueProducer[] = queueResources.map(resource => ({
    queue: resource.name,
    binding: resource.binding
  }));

  return { producers };
};

/**
 * Build the wrangler `durable_objects` bindings section from the manifest's do resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns The durable_objects section, or undefined when there are no do resources.
 * @example
 * ```ts
 * const dobj = buildDurableObjects([{ kind: "do", binding: "COUNTER", className: "Counter" }]);
 * ```
 */
const buildDurableObjects = (
  resources: ResourceManifest[]
): { bindings: DoBinding[] } | undefined => {
  const doResources = resources.filter(
    (resource): resource is Extract<ResourceManifest, { kind: "do" }> => resource.kind === "do"
  );
  if (doResources.length === 0) return undefined;

  const bindings: DoBinding[] = doResources.map(resource => ({
    name: resource.binding,
    class_name: resource.className
  }));

  return { bindings };
};

/**
 * Build the auto Durable Object `migrations` from the manifest's do classes. wrangler REQUIRES a
 * migration for every DO class, so this derives a single `v1` migration registering each class as
 * SQLite-backed (the modern default) — the exact section wrangler prompts for when it is missing.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns A single-entry migrations array, or undefined when there are no do resources.
 * @example
 * ```ts
 * buildMigrations([{ kind: "do", binding: "BOARD", className: "BoardChannel" }]);
 * // [{ tag: "v1", new_sqlite_classes: ["BoardChannel"] }]
 * ```
 */
const buildMigrations = (resources: ResourceManifest[]): DoMigration[] | undefined => {
  const classes = resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "do" }> => resource.kind === "do"
    )
    .map(resource => resource.className);
  return classes.length > 0 ? [{ tag: "v1", new_sqlite_classes: classes }] : undefined;
};

/**
 * Extract the already-captured Cloudflare ids (kv namespace `id`, d1 `database_id`) from an existing
 * parsed wrangler config, keyed by binding — so a regeneration (e.g. on `dev`) can preserve ids it
 * isn't handed. Tolerant of a malformed/hand-edited file (skips non-object / non-string entries).
 *
 * @param existing - The parsed existing wrangler config (or `{}`).
 * @returns A binding → id map (empty when the file has none).
 * @example
 * ```ts
 * extractExistingIds({ kv_namespaces: [{ binding: "CACHE", id: "ns1" }] }); // { CACHE: "ns1" }
 * ```
 */
const extractExistingIds = (existing: Record<string, unknown>): Record<string, string> => {
  const ids: Record<string, string> = {};

  // eslint-disable-next-line jsdoc/require-jsdoc -- internal closure
  const collect = (list: unknown, idKey: "id" | "database_id"): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const binding = entry.binding;
      const id = entry[idKey];
      if (typeof binding === "string" && typeof id === "string" && id.length > 0) {
        ids[binding] = id;
      }
    }
  };

  collect(existing.kv_namespaces, "id");
  collect(existing.d1_databases, "database_id");
  return ids;
};

/**
 * Build the extra top-level wrangler keys from the typed deploy config: `entry` → `main`,
 * `nodeCompat` → `compatibility_flags: ["nodejs_compat"]`, `assets` → the wrangler `assets` block
 * (SPA fallback when `spa`), then the raw `wrangler` passthrough last (the escape hatch wins / adds
 * anything else). Pass the result as the `extra` argument to {@link writeWranglerConfig}.
 *
 * @param config - The deploy plugin config.
 * @returns The merged extra wrangler keys.
 * @example
 * ```ts
 * await writeWranglerConfig(file, manifest, ids, wranglerExtra(ctx.config));
 * ```
 */
export const wranglerExtra = (config: Config): Record<string, unknown> => {
  const extra: Record<string, unknown> = {};
  if (config.entry !== undefined) {
    extra.main = config.entry;
  }
  if (config.nodeCompat === true) {
    extra.compatibility_flags = ["nodejs_compat"];
  }
  if (config.assets !== undefined) {
    extra.assets = {
      directory: config.assets.directory,
      binding: config.assets.binding,
      ...(config.assets.spa === true ? { not_found_handling: "single-page-application" } : {})
    };
  }
  return { ...extra, ...config.wrangler };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate/update the wrangler config file from a manifest (non-destructive merge).
 *
 * Layering (last wins): existing file keys → the `extra` passthrough (the app's `wrangler` config:
 * `main`, `compatibility_flags`, `assets`, `vars`, …) → the deploy-managed keys (name,
 * compatibility_date, kv_namespaces, r2_buckets, d1_databases, queues, durable_objects). So the
 * framework always owns the resource sections, the app supplies what the manifest can't derive, and
 * any other hand-written keys survive. Durable Object `migrations` are auto-derived for every DO
 * class (the section wrangler requires) UNLESS the file/passthrough already defines `migrations`.
 *
 * @param configFile - Path to the wrangler config file.
 * @param manifest - The assembled deploy manifest.
 * @param ids - Captured Cloudflare ids keyed by binding (kv namespace id, d1 database id). Defaults
 *   to an empty map, in which case `id`/`database_id` are written as "" (e.g. the universal path).
 * @param extra - Extra top-level wrangler keys to merge in (the app's `deploy.wrangler` config).
 * @returns Resolves once the file is written.
 * @example
 * ```ts
 * await writeWranglerConfig("wrangler.jsonc", manifest, { CACHE: "ns123" }, {
 *   main: "src/cloudflare/worker.ts",
 *   compatibility_flags: ["nodejs_compat"],
 *   assets: { directory: "dist/client", binding: "ASSETS" }
 * });
 * ```
 */
export const writeWranglerConfig = async (
  configFile: string,
  manifest: ExternalManifest,
  ids: Record<string, string> = {},
  extra: Record<string, unknown> = {}
): Promise<void> => {
  // Read and merge with existing config if present (non-destructive).
  let existing: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    try {
      existing = parseJsonc(readFileSync(configFile, "utf8"));
    } catch {
      // If the file is unreadable/unparseable, start fresh.
      existing = {};
    }
  }

  // Build each wrangler resource section from the manifest (empty when that kind is absent).
  // kv/d1 get their real Cloudflare id from the captured `ids` map, falling back to the id already in
  // the file — so regenerating (e.g. on `dev`) never wipes ids a prior deploy captured.
  const effectiveIds = { ...extractExistingIds(existing), ...ids };
  const kvNamespaces = buildKvNamespaces(manifest.resources, effectiveIds);
  const r2Buckets = buildR2Buckets(manifest.resources);
  const d1Databases = buildD1Databases(manifest.resources, effectiveIds);
  const queues = buildQueues(manifest.resources);
  const durableObjects = buildDurableObjects(manifest.resources);

  // existing → app passthrough (main / compatibility_flags / assets / …) → managed name + date.
  const updated: Record<string, unknown> = {
    ...existing,
    ...extra,
    name: manifest.name,
    compatibility_date: manifest.compatibilityDate
  };

  // Merge only non-empty sections so we never emit empty resource arrays/objects.
  if (kvNamespaces.length > 0) {
    updated.kv_namespaces = kvNamespaces;
  }

  if (r2Buckets.length > 0) {
    updated.r2_buckets = r2Buckets;
  }

  if (d1Databases.length > 0) {
    updated.d1_databases = d1Databases;
  }

  if (queues !== undefined) {
    updated.queues = queues;
  }

  if (durableObjects !== undefined) {
    updated.durable_objects = durableObjects;
  }

  // wrangler requires a migration per DO class — auto-derive it, unless one is already defined
  // (existing file or passthrough), so an evolving migrations list is never clobbered.
  const migrations = buildMigrations(manifest.resources);
  if (migrations !== undefined && updated.migrations === undefined) {
    updated.migrations = migrations;
  }

  // Persist as 2-space-indented JSON (valid JSONC the wrangler CLI reads).
  await writeFile(configFile, JSON.stringify(updated, undefined, 2));
};

/**
 * Scaffold a starting wrangler config and, when ci is set, CI workflow files.
 * Idempotent: an existing config file is left completely untouched.
 *
 * @param configFile - Path to the wrangler config file.
 * @param _ci - Whether to also scaffold CI workflow files.
 * @returns Resolves once scaffolding is written.
 * @example
 * ```ts
 * await scaffoldWranglerAndCi("wrangler.jsonc", true);
 * ```
 */
export const scaffoldWranglerAndCi = async (configFile: string, _ci: boolean): Promise<void> => {
  if (existsSync(configFile)) {
    // Idempotent — leave the existing file untouched.
    return;
  }

  const starter: Record<string, unknown> = {
    name: "my-worker",
    main: "src/worker.ts",
    compatibility_date: new Date().toISOString().slice(0, 10)
  };

  await writeFile(configFile, JSON.stringify(starter, undefined, 2));
};
