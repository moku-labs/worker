/**
 * @file deploy plugin — dev site-rebuild resolution.
 *
 * Resolves HOW to rebuild the Moku web site on change: the in-process `buildSite` hook (preferred,
 * fast, typed) → a `buildCommand` shell string → an auto-detected `scripts/build.ts`. When nothing
 * is configured, dev serves the worker only and says so. Subprocesses inherit the parent env by
 * default. Node-only; never imported by the runtime Worker bundle.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { Ctx } from "../types";

/** Convention build script auto-detected when no buildSite/buildCommand is configured. */
const AUTO_DETECT = "scripts/build.ts";

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
 * Rebuild the Moku web site using the configured strategy (hook → command → auto-detect).
 *
 * @param ctx - The deploy plugin context (config + emit).
 * @returns The rebuilt file count (0 for the shell path, where it is unknown).
 * @throws {Error} When the resolved shell build fails.
 * @example
 * ```ts
 * const { files } = await buildSite(ctx);
 * ```
 */
export const buildSite = async (ctx: Ctx): Promise<{ files: number }> => {
  if (ctx.config.buildSite !== undefined) {
    return ctx.config.buildSite();
  }

  const command =
    ctx.config.buildCommand || (existsSync(AUTO_DETECT) ? `bun run ${AUTO_DETECT}` : "");
  if (command === "") {
    ctx.emit("dev:error", {
      message: "No site build configured (set buildSite or buildCommand); serving worker only."
    });
    return { files: 0 };
  }

  await runShellBuild(command);
  return { files: 0 };
};
