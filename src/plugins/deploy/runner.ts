/**
 * @file deploy plugin — wrangler subprocess wrapper (node:child_process).
 *
 * Spawns `wrangler` with the given args and resolves the deployed URL
 * (extracted from stdout for `wrangler deploy`), or the full stdout for other verbs.
 * This module is node-only; never imported by the runtime Worker bundle.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Extract the deployed URL from `wrangler deploy` stdout.
 * Wrangler prints a line like: "Published my-worker (1.23 sec)  https://..."
 * or "Deployed my-worker (1.23 sec) https://...".
 *
 * @param output - The combined stdout from wrangler deploy.
 * @returns The deployed URL, or empty string when not found.
 * @example
 * ```ts
 * extractDeployedUrl("Deployed my-worker (0.5 sec) https://my-worker.workers.dev");
 * // "https://my-worker.workers.dev"
 * ```
 */
const extractDeployedUrl = (output: string): string => {
  // Match "https://<anything>.workers.dev" or any https URL on a line
  const match = /https:\/\/[^\s]+\.workers\.dev[^\s]*/u.exec(output);
  return match?.[0] ?? "";
};

/**
 * Capture a spawned wrangler child's piped stdout/stderr and resolve once it exits: the deployed URL
 * for the `deploy` verb, the full stdout for every other verb. Shared by {@link runWrangler} and
 * {@link runWranglerYes} (which differ only in whether stdin is auto-answered), so the accumulate +
 * decode + non-zero-exit handling lives in exactly one place.
 *
 * @param child - The spawned wrangler process (stdout/stderr piped; stdin piped or ignored).
 * @param args - The wrangler arguments the child was spawned with (used to detect the deploy verb).
 * @returns Resolves with the deployed URL (deploy verb) or full stdout (other verbs).
 * @throws {Error} When wrangler cannot be spawned or exits with a non-zero code.
 * @example
 * ```ts
 * return captureWrangler(spawn("wrangler", args, opts), args);
 * ```
 */
const captureWrangler = (
  child: ChildProcessByStdio<Writable | null, Readable, Readable>,
  args: string[]
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    // Accumulate stdout/stderr as raw Buffer chunks — decoded once on close.
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    // Stream stdout/stderr chunks into their buffers as they arrive.
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    // Reject if wrangler can't be spawned at all (missing binary, EACCES, …).
    child.on("error", err => {
      reject(new Error(`[worker] Failed to spawn wrangler.\n  ${err.message}`));
    });

    // On close: decode the buffers, then reject on a non-zero exit or resolve
    // (deploy verb → parsed URL, any other verb → full stdout).
    child.on("close", code => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");

      if (code !== 0) {
        reject(
          new Error(`[worker] wrangler exited with code ${String(code)}.\n  ${stderr || stdout}`)
        );
        return;
      }

      const isDeploy = args[0] === "deploy";
      resolve(isDeploy ? extractDeployedUrl(stdout) : stdout);
    });
  });

/**
 * Spawn `wrangler` with the given args and resolve the output string.
 * For `wrangler deploy`, the resolved value is the deployed URL parsed from stdout.
 * For all other verbs (dev, kv namespace create, etc.), the resolved value is stdout.
 *
 * @param args - Wrangler CLI arguments (e.g. ["deploy", "--config", "wrangler.jsonc"]).
 * @returns Resolves with the deployed URL (deploy verb) or full stdout (other verbs).
 * @throws {Error} When wrangler exits with a non-zero code.
 * @example
 * ```ts
 * const url = await runWrangler(["deploy", "--config", "wrangler.jsonc"]);
 * await runWrangler(["kv", "namespace", "create", "CACHE"]);
 * ```
 */
export const runWrangler = (args: string[]): Promise<string> => {
  // Spawn the wrangler CLI with piped stdout/stderr (captured) and stdin ignored — the default verbs
  // never read stdin. wrangler is a trusted dev/peer dependency resolved from node_modules/.bin.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
  const child = spawn("wrangler", args, {
    env: { ...process.env }, // @env-allow — passthrough to the spawned wrangler subprocess (not app config)
    stdio: ["ignore", "pipe", "pipe"]
  });
  return captureWrangler(child, args);
};

/**
 * Spawn `wrangler` with the given args, auto-answering its confirmation prompt by writing `y` to
 * stdin. Used for the destructive verbs whose prompt has no `--skip-confirmation`/`-y` flag —
 * `wrangler delete`, `wrangler queues delete`, and `wrangler r2 bucket delete` — so a teardown that
 * already double-confirmed with the user never blocks on a second per-resource prompt.
 *
 * @param args - Wrangler CLI arguments (e.g. ["queues", "delete", "jobs"]).
 * @returns Resolves with wrangler's full stdout once it exits.
 * @throws {Error} When wrangler cannot be spawned or exits with a non-zero code.
 * @example
 * ```ts
 * await runWranglerYes(["r2", "bucket", "delete", "tracker-files-dev"]);
 * ```
 */
export const runWranglerYes = (args: string[]): Promise<string> => {
  // stdin is piped (not ignored) so the "y" answer reaches wrangler's confirmation prompt, then
  // closed so wrangler stops waiting for further input.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
  const child = spawn("wrangler", args, {
    env: { ...process.env }, // @env-allow — passthrough to the spawned wrangler subprocess (not app config)
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("y\n");
  return captureWrangler(child, args);
};

/**
 * Spawn `wrangler` with the given args, writing `input` to its stdin and closing it — used by
 * `wrangler secret bulk`, which reads its name → value JSON from stdin when no file argument is
 * given (so secret VALUES never touch argv or a temp file).
 *
 * @param args - Wrangler CLI arguments (e.g. ["secret", "bulk", "--config", "wrangler.jsonc"]).
 * @param input - The full stdin payload (e.g. the secrets JSON).
 * @returns Resolves with wrangler's full stdout once it exits.
 * @throws {Error} When wrangler cannot be spawned or exits with a non-zero code.
 * @example
 * ```ts
 * await runWranglerStdin(["secret", "bulk", "--config", "wrangler.jsonc"], JSON.stringify(values));
 * ```
 */
export const runWranglerStdin = (args: string[], input: string): Promise<string> => {
  // stdin is piped so the payload reaches wrangler, then closed so it stops waiting for input.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
  const child = spawn("wrangler", args, {
    env: { ...process.env }, // @env-allow — passthrough to the spawned wrangler subprocess (not app config)
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(input);
  return captureWrangler(child, args);
};

/**
 * Spawn `wrangler` with the given args, inheriting stdio so its output streams live to the user's
 * terminal (used by the generic passthrough and long-lived commands like `tail`).
 *
 * @param args - Wrangler CLI arguments (e.g. ["kv", "namespace", "list"]).
 * @returns Resolves once wrangler exits successfully.
 * @throws {Error} When wrangler cannot be spawned or exits non-zero.
 * @example
 * ```ts
 * await runWranglerInherit(["kv", "namespace", "list"]);
 * ```
 */
export const runWranglerInherit = (args: string[]): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- wrangler is a pinned peer dep resolved from node_modules/.bin
    const child = spawn("wrangler", args, { stdio: "inherit" });

    child.on("error", error => {
      reject(new Error(`[worker] Failed to spawn wrangler.\n  ${error.message}`));
    });
    child.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[worker] wrangler exited with code ${String(code)}.`));
    });
  });
};
