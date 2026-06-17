/**
 * @file Node-only deploy tooling entry ("./cli"). Imported by scripts/*.ts, never by the Worker.
 */

export { cliPlugin } from "./plugins/cli";
export { deployPlugin } from "./plugins/deploy";
export type { ExternalManifest, ResourceManifest } from "./plugins/deploy/types";
