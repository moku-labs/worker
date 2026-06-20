/**
 * @file deploy plugin — `.env.local` scaffolder (node:fs).
 *
 * Writes a ready-to-fill `.env.local` so the guided deploy can hand the user a real file to paste
 * their Cloudflare token into — NEVER clobbering an existing one (it may already hold real secrets).
 * Node-only; never imported by the runtime Worker bundle.
 */
import { access, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Create `<dir>/.env.local` with the given contents, unless it already exists. Existing files are
 * left untouched (they may hold real secrets) — the caller tells the user to fill that one in.
 *
 * @param dir - Directory to create the file in (usually `process.cwd()`).
 * @param content - The file contents to write when absent (e.g. `envLocalScaffold(manifest)`).
 * @returns Whether the file was created (false when it already existed) and its path.
 * @example
 * ```ts
 * const { created, path } = await ensureEnvLocal(process.cwd(), envLocalScaffold(manifest));
 * ```
 */
export const ensureEnvLocal = async (
  dir: string,
  content: string
): Promise<{ created: boolean; path: string }> => {
  const filePath = path.join(dir, ".env.local");

  // Probe first — never overwrite an existing .env.local (it may already hold real secrets).
  try {
    await access(filePath);
    return { created: false, path: filePath };
  } catch {
    await writeFile(filePath, content, "utf8");
    return { created: true, path: filePath };
  }
};
