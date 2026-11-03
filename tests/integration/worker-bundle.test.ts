/**
 * @file The published package must let a Worker bundle stay free of Node built-ins.
 *
 * Bug this catches: a Worker that lists no `deployPlugin` keeps the top-level `node:*` imports of
 * the package, so Cloudflare stops it at start with `No such module "node:fs"` unless the app
 * enables `nodejs_compat`. Only a real build shows it: a single-file `dist` defeats
 * `"sideEffects": false`, while the source tree does not.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "..", "..");
const tsdown = path.join(repository, "node_modules", ".bin", "tsdown");
const WORKER_ENTRY = (distribution: string) => `
  import { createApp, d1Plugin, durableObjectsPlugin, endpoint, kvPlugin, queuesPlugin, storagePlugin } from "${distribution}/index.mjs";
  const app = createApp({
    plugins: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin],
    pluginConfigs: { server: { endpoints: [endpoint("/health").get(() => new Response("ok"))] } }
  });
  export default { fetch: (request, env, ctx) => app.server.handle(request, env, ctx) };
`;

describe("the Worker bundle", () => {
  let distribution = "";

  beforeAll(() => {
    distribution = mkdtempSync(path.join(repository, ".bundle-test-"));
    execFileSync(tsdown, ["--out-dir", distribution, "--no-dts"], {
      cwd: repository,
      stdio: "pipe"
    });
  }, 60_000);

  afterAll(() => {
    rmSync(distribution, { recursive: true, force: true });
  });

  it("has no Node built-in import when no Node plugin is listed", async () => {
    const result = await build({
      stdin: { contents: WORKER_ENTRY(distribution), resolveDir: repository },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["workerd", "worker", "import"],
      external: ["node:*"],
      logLevel: "silent"
    });
    const output = result.outputFiles[0]?.text ?? "";

    expect(output).toContain("app.server.handle");
    expect(output.match(/from "node:[^"]+"/gu) ?? []).toEqual([]);
  }, 60_000);
});
