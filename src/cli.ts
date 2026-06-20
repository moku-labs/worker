/**
 * @file Back-compat alias for the node-only deploy tooling (`@moku-labs/worker/cli`).
 *
 * `cliPlugin`/`deployPlugin` now ship from the package root (`@moku-labs/worker`) too; this entry
 * is kept so existing `import … from "@moku-labs/worker/cli"` call sites keep working. Prefer the
 * root import in new code.
 */

export { cliPlugin } from "./plugins/cli";
export { deployPlugin } from "./plugins/deploy";
export type { ExternalManifest, ResourceManifest } from "./plugins/deploy/types";
