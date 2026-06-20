import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "bin/moku-worker": "src/bin/moku-worker.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: false,
  tsconfig: "tsconfig.build.json"
});
