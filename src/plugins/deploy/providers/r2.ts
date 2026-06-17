/**
 * @file deploy plugin — R2 provisioning + asset upload adapter skeleton.
 */
import type { ResourceManifest } from "../types";

/** An R2 resource descriptor. */
type R2Manifest = Extract<ResourceManifest, { kind: "r2" }>;

/**
 * Provision an R2 bucket via `wrangler r2 bucket create`.
 *
 * @param _manifest - The R2 resource descriptor.
 * @param _ci - Whether running non-interactively.
 * @example
 * ```ts
 * await provisionR2({ kind: "r2", bucket: "ASSETS" }, false);
 * ```
 */
export function provisionR2(_manifest: R2Manifest, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Upload a directory to an R2 bucket and return the uploaded file count.
 *
 * @param _bucket - The R2 bucket binding name.
 * @param _dir - The directory to upload.
 * @example
 * ```ts
 * const count = await uploadDirToR2("ASSETS", "./public");
 * ```
 */
export function uploadDirToR2(_bucket: string, _dir: string): Promise<number> {
  throw new Error("not implemented");
}
