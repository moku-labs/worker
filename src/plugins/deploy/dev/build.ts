/**
 * @file deploy plugin — dev site-rebuild resolution.
 *
 * Resolves HOW to rebuild the Moku web site on change: the in-process `webBuild` hook (preferred,
 * fast, typed — passed call-time from the consumer's script or set as a config default) → a
 * `buildCommand` shell string → an auto-detected `scripts/build.ts`. When nothing is configured,
 * dev serves the worker only and says so. Subprocesses inherit the parent env by default.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { Ctx, WebBuild } from "../types";

/** Convention build script auto-detected when no webBuild/buildCommand is configured. */
const AUTO_DETECT = "scripts/build.ts";

/**
 * Opportunistically read a numeric `files` count off an arbitrary web build result. A real web
 * build returns its own summary shape (the worker framework cannot know it), so anything without a
 * numeric `files` field reports 0.
 *
 * @param result - The resolved value of a {@link WebBuild} hook (any shape).
 * @returns The `files` count when present and numeric, else 0.
 * @example
 * ```ts
 * fileCountOf({ files: 12 }); // 12
 * fileCountOf({ outDir: "dist", pageCount: 4 }); // 0
 * ```
 */
export const fileCountOf = (result: unknown): number => {
  if (typeof result === "object" && result !== null && "files" in result) {
    const { files } = result as { files: unknown };
    return typeof files === "number" ? files : 0;
  }
  return 0;
};

/**
 * Run a shell build command, resolving on a zero exit and rejecting otherwise.
 *
 * @param command - The shell command to run (the consumer's own configured build).
 * @returns Resolves once the command exits successfully.
 * @throws {Error} When the command fails to start or exits non-zero.
 * @example
 * ```ts
 * await runShellBuild("bun run scripts/build.ts");
 * ```
 */
const runShellBuild = (command: string): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/os-command -- buildCommand is the consumer's own configured build, not external input
    const child = spawn(command, { shell: true, stdio: "inherit" });

    child.on("error", error => {
      reject(new Error(`[moku-worker] site build failed to start.\n  ${error.message}`));
    });
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[moku-worker] site build exited with code ${String(code)}.`));
    });
  });
};

/**
 * Rebuild the Moku web site using the resolved strategy: the call-time `webBuild` hook (the
 * script-driven path), else the `webBuild` config default, else the `buildCommand` shell string,
 * else an auto-detected `scripts/build.ts`. A hook's result is normalized to a `{ files }` count
 * (0 when the hook reports none, and for the shell path where it is unknown).
 *
 * @param ctx - The deploy plugin context (config + emit).
 * @param webBuild - Optional call-time web build hook (takes precedence over `ctx.config.webBuild`).
 * @returns The rebuilt file count (0 for the shell path / a countless hook).
 * @throws {Error} When the resolved shell build fails.
 * @example
 * ```ts
 * const { files } = await buildSite(ctx, () => web.cli.build());
 * ```
 */
export const buildSite = async (ctx: Ctx, webBuild?: WebBuild): Promise<{ files: number }> => {
  const hook = webBuild ?? ctx.config.webBuild;
  if (hook !== undefined) {
    return { files: fileCountOf(await hook()) };
  }

  const command =
    ctx.config.buildCommand || (existsSync(AUTO_DETECT) ? `bun run ${AUTO_DETECT}` : "");
  if (command === "") {
    ctx.emit("dev:error", {
      message: "No site build configured (pass webBuild or set buildCommand); serving worker only."
    });
    return { files: 0 };
  }

  await runShellBuild(command);
  return { files: 0 };
};
