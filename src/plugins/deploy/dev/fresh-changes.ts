/**
 * @file deploy plugin — dev-watcher freshness guard (drops stale change-event echoes).
 *
 * Watch backends can report a path as "changed" without its inode having changed. The canonical
 * case: on macOS/APFS, Bun copies large files via `clonefile(2)` (`fs.cp`/`copyFile`), and FSEvents
 * then reports the clone SOURCE path as changed (an `ItemCloned` echo) even though the source was
 * only read — mtime AND ctime stay put. When a rebuild copies watched files (e.g. `public/**` into
 * the site output), every rebuild echoes phantom "changes" for those sources, which would schedule
 * the next rebuild, forever — a ~1/s rebuild → wrangler-reload storm that tears down Durable
 * Objects and their in-flight WebSockets. An echo never touches the source inode, so a batch is
 * real only if some path in it actually changed on disk since the last delivered batch.
 * Node-only; never imported by the runtime Worker bundle.
 */
import { statSync } from "node:fs";

/**
 * Whether a changed-path batch contains at least one REAL change since `sinceMs`: a path whose
 * `max(mtime, ctime)` is newer, or a path that no longer exists (a deletion — stale echoes never
 * remove the source). A batch of pure echoes (all paths present, all timestamps older) returns
 * `false` and the caller drops it, breaking the feedback loop.
 *
 * @param paths - The watcher's debounced changed-path batch (as reported, relative to the app root).
 * @param sinceMs - The epoch-ms freshness threshold — when the last delivered batch fired.
 * @returns `true` when some path really changed (rebuild), `false` for echo-only batches (drop).
 * @example
 * ```ts
 * if (!hasFreshChange(batch, lastDeliveredMs)) return; // stale echo — drop the batch
 * ```
 */
export const hasFreshChange = (paths: readonly string[], sinceMs: number): boolean =>
  paths.some(changedPath => {
    try {
      const stats = statSync(changedPath);
      return Math.max(stats.mtimeMs, stats.ctimeMs) > sinceMs;
    } catch {
      return true; // stat failed — the path is gone, and a deletion is always a real change
    }
  });
