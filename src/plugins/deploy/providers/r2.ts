/**
 * @file deploy plugin — R2 provisioning + asset upload adapter.
 *
 * Provides two exports:
 * - `provisionR2`: creates an R2 bucket via `wrangler r2 bucket create`.
 * - `uploadDirToR2`: walks a directory recursively and uploads each file via
 *   `wrangler r2 object put`, returning the uploaded file count.
 *
 * Node-only; never imported by the runtime Worker bundle.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runWrangler, runWranglerYes } from "../runner";
import type { ResourceManifest } from "../types";

/** An R2 resource descriptor. */
type R2Manifest = Extract<ResourceManifest, { kind: "r2" }>;

/**
 * Delete an R2 bucket via `wrangler r2 bucket delete <name>` (auto-answering the prompt — the verb
 * has no `-y` flag). Cloudflare requires the bucket to be EMPTY first, and wrangler 4.x cannot list
 * objects (`r2 object` has only get/put/delete), so a non-empty bucket cannot be emptied from here:
 * wrangler rejects the delete and this throws. The caller captures that failure (teardown stays
 * resilient) and the result panel surfaces the dashboard "Empty bucket" hint.
 *
 * @param name - The stage-qualified R2 bucket name (e.g. "tracker-files-dev").
 * @returns Resolves once wrangler reports the bucket deleted.
 * @throws {Error} When wrangler exits non-zero — notably when the bucket is not empty.
 * @example
 * ```ts
 * await deleteR2("tracker-files-dev");
 * ```
 */
export const deleteR2 = async (name: string): Promise<void> => {
  await runWranglerYes(["r2", "bucket", "delete", name]);
};

/**
 * Provision an R2 bucket via `wrangler r2 bucket create`.
 *
 * @param manifest - The R2 resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @returns Resolves once the bucket is created.
 * @example
 * ```ts
 * await provisionR2({ kind: "r2", name: "tracker-files", binding: "FILES" }, false);
 * ```
 */
export const provisionR2 = async (manifest: R2Manifest, _ci: boolean): Promise<void> => {
  await runWrangler(["r2", "bucket", "create", manifest.name]);
};

/**
 * Walk a directory recursively and return all file paths (absolute).
 *
 * @param directory - Directory path to walk.
 * @returns All file paths found under the directory.
 * @example
 * ```ts
 * const files = await walkDir("./public");
 * ```
 */
const walkDir = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory);
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry);
    const stats = await stat(fullPath);

    if (stats.isDirectory()) {
      const nested = await walkDir(fullPath);
      results.push(...nested);
    } else {
      results.push(fullPath);
    }
  }

  return results;
};

/**
 * Upload a directory to an R2 bucket and return the uploaded file count.
 * Each file is uploaded via `wrangler r2 object put <bucket>/<key> --file <path>`.
 *
 * @param bucket - The R2 bucket binding name.
 * @param directory - The directory to upload.
 * @returns The number of files uploaded.
 * @example
 * ```ts
 * const count = await uploadDirToR2("ASSETS", "./public");
 * ```
 */
export const uploadDirToR2 = async (bucket: string, directory: string): Promise<number> => {
  const files = await walkDir(directory);

  for (const filePath of files) {
    const key = path.relative(directory, filePath);
    await runWrangler(["r2", "object", "put", `${bucket}/${key}`, "--file", filePath]);
  }

  return files.length;
};
