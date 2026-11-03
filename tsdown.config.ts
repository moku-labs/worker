import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  // One output file per source module, so `"sideEffects": false` works: a Worker that does not list
  // `deployPlugin` or `cliPlugin` drops their `node:*` graph from its bundle.
  unbundle: true,
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  tsconfig: "tsconfig.build.json"
});
