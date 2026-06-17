/**
 * @file deploy plugin — wrangler config generation skeleton.
 */
import type { ExternalManifest } from "./types";

/**
 * Generate/update the wrangler config file from a manifest (non-destructive merge).
 *
 * @param _configFile - Path to the wrangler config file.
 * @param _manifest - The assembled deploy manifest.
 * @example
 * ```ts
 * await writeWranglerConfig("wrangler.jsonc", manifest);
 * ```
 */
export function writeWranglerConfig(
  _configFile: string,
  _manifest: ExternalManifest
): Promise<void> {
  throw new Error("not implemented");
}

/**
 * Scaffold a starting wrangler config and, when ci is set, CI workflow files.
 *
 * @param _configFile - Path to the wrangler config file.
 * @param _ci - Whether to also scaffold CI workflow files.
 * @example
 * ```ts
 * await scaffoldWranglerAndCi("wrangler.jsonc", true);
 * ```
 */
export function scaffoldWranglerAndCi(_configFile: string, _ci: boolean): Promise<void> {
  throw new Error("not implemented");
}
