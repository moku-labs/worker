/**
 * @file deploy plugin — debounced filesystem watcher for dev.
 *
 * Watches the top-level directories implied by the config globs (recursive) and fires a debounced
 * change callback with the last changed path. Uses node:fs.watch — no extra dependency.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { existsSync, type FSWatcher, watch as fsWatch } from "node:fs";
import path from "node:path";

/**
 * Derive the set of top-level directories to watch from glob patterns.
 *
 * @param globs - Watch globs (e.g. ["src/**\/*.ts", "public/**\/*"]).
 * @returns The distinct top-level directories (e.g. ["src", "public"]).
 * @example
 * ```ts
 * watchDirectories(["src/**\/*.ts", "public/**\/*"]); // ["src", "public"]
 * ```
 */
export const watchDirectories = (globs: string[]): string[] => {
  const directories = new Set<string>();
  for (const glob of globs) {
    const globStart = glob.search(/[*?[{]/u);
    const base = globStart === -1 ? path.dirname(glob) : glob.slice(0, globStart);
    const top = base.split(/[/\\]/u).find(segment => segment !== "") ?? ".";
    directories.add(top);
  }
  return [...directories];
};

/**
 * Watch the directories implied by `globs` and fire `onChange` (debounced by `debounceMs`) with
 * the last changed path. Missing directories are skipped silently.
 *
 * @param globs - Watch globs.
 * @param debounceMs - Coalesce rapid changes into one callback within this window.
 * @param onChange - Called with the last changed path after the debounce settles.
 * @returns A handle whose close() stops all watchers and cancels any pending callback.
 * @example
 * ```ts
 * const handle = watchPaths(["src/**\/*.ts"], 120, p => rebuild(p));
 * handle.close();
 * ```
 */
export const watchPaths = (
  globs: string[],
  debounceMs: number,
  onChange: (changedPath: string) => unknown
): { close: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPath = "";

  // eslint-disable-next-line jsdoc/require-jsdoc -- inner debounce helper (closes over timer/lastPath)
  const fire = (changedPath: string): void => {
    lastPath = changedPath;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void onChange(lastPath);
    }, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  for (const directory of watchDirectories(globs)) {
    if (!existsSync(directory)) continue; // skip directories that do not exist yet
    watchers.push(
      fsWatch(directory, { recursive: true }, (_event, filename) => {
        if (filename !== null) fire(path.join(directory, filename.toString()));
      })
    );
  }

  return {
    // eslint-disable-next-line jsdoc/require-jsdoc -- inner teardown (closes over timer/watchers)
    close: (): void => {
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    }
  };
};
