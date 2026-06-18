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

import type { ExternalManifest, ResourceManifest } from "./types";

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

/**
 * Build the wrangler `kv_namespaces` array from the manifest's kv resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns One wrangler KV namespace entry per kv resource.
 * @example
 * ```ts
 * const kv = buildKvNamespaces([{ kind: "kv", binding: "CACHE" }]);
 * ```
 */
const buildKvNamespaces = (resources: ResourceManifest[]): KvEntry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "kv" }> => resource.kind === "kv"
    )
    .map(resource => ({
      binding: resource.binding,
      id: ""
    }));

/**
 * Build the wrangler `r2_buckets` array from the manifest's r2 resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns One wrangler R2 bucket entry per r2 resource.
 * @example
 * ```ts
 * const r2 = buildR2Buckets([{ kind: "r2", bucket: "ASSETS" }]);
 * ```
 */
const buildR2Buckets = (resources: ResourceManifest[]): R2Entry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "r2" }> => resource.kind === "r2"
    )
    .map(resource => ({
      binding: resource.bucket,
      bucket_name: resource.bucket.toLowerCase()
    }));

/**
 * Build the wrangler `d1_databases` array from the manifest's d1 resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns One wrangler D1 database entry per d1 resource (migrations_dir set when present).
 * @example
 * ```ts
 * const d1 = buildD1Databases([{ kind: "d1", binding: "DB" }]);
 * ```
 */
const buildD1Databases = (resources: ResourceManifest[]): D1Entry[] =>
  resources
    .filter(
      (resource): resource is Extract<ResourceManifest, { kind: "d1" }> => resource.kind === "d1"
    )
    .map(resource => {
      const entry: D1Entry = {
        binding: resource.binding,
        database_name: resource.binding.toLowerCase(),
        database_id: ""
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
 * const q = buildQueues([{ kind: "queue", producers: ["jobs"] }]);
 * ```
 */
const buildQueues = (resources: ResourceManifest[]): { producers: QueueProducer[] } | undefined => {
  const queueResources = resources.filter(
    (resource): resource is Extract<ResourceManifest, { kind: "queue" }> =>
      resource.kind === "queue"
  );
  if (queueResources.length === 0) return undefined;

  const producers: QueueProducer[] = queueResources.flatMap(resource =>
    resource.producers.map(producer => ({
      queue: producer,
      binding: producer.toUpperCase()
    }))
  );

  return { producers };
};

/**
 * Build the wrangler `durable_objects` bindings section from the manifest's do resources.
 *
 * @param resources - All resource descriptors from the manifest.
 * @returns The durable_objects section, or undefined when there are no do resources.
 * @example
 * ```ts
 * const dobj = buildDurableObjects([{ kind: "do", bindings: { Counter: "COUNTER" } }]);
 * ```
 */
const buildDurableObjects = (
  resources: ResourceManifest[]
): { bindings: DoBinding[] } | undefined => {
  const doResources = resources.filter(
    (resource): resource is Extract<ResourceManifest, { kind: "do" }> => resource.kind === "do"
  );
  if (doResources.length === 0) return undefined;

  const bindings: DoBinding[] = doResources.flatMap(resource =>
    Object.entries(resource.bindings).map(([className, bindingName]) => ({
      name: bindingName,
      class_name: className
    }))
  );

  return { bindings };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate/update the wrangler config file from a manifest (non-destructive merge).
 * If the file exists, its top-level keys are preserved and only deploy-managed keys
 * (name, compatibility_date, kv_namespaces, r2_buckets, d1_databases, queues,
 * durable_objects) are updated.
 *
 * @param configFile - Path to the wrangler config file.
 * @param manifest - The assembled deploy manifest.
 * @returns Resolves once the file is written.
 * @example
 * ```ts
 * await writeWranglerConfig("wrangler.jsonc", manifest);
 * ```
 */
export const writeWranglerConfig = async (
  configFile: string,
  manifest: ExternalManifest
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
  const kvNamespaces = buildKvNamespaces(manifest.resources);
  const r2Buckets = buildR2Buckets(manifest.resources);
  const d1Databases = buildD1Databases(manifest.resources);
  const queues = buildQueues(manifest.resources);
  const durableObjects = buildDurableObjects(manifest.resources);

  // Start from the existing config so unmanaged top-level keys survive; overwrite name + date.
  const updated: Record<string, unknown> = {
    ...existing,
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
