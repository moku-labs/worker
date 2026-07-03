/**
 * Unit tests for the dev filesystem watcher (watchDirectories is pure; watchPaths debounce +
 * stale-echo freshness guard via fake timers and a mocked statSync).
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchDirectories, watchPaths } from "../../../dev/watch";

vi.mock("node:fs", () => ({ watch: vi.fn(), existsSync: vi.fn(() => true), statSync: vi.fn() }));

import { watch as fsWatch, type Stats, statSync } from "node:fs";

beforeEach(() => {
  // Default: the reported paths do not exist on disk — a deletion, which the freshness guard always
  // treats as a real change, so the debounce tests below exercise delivery unimpeded.
  vi.mocked(statSync).mockImplementation(() => {
    throw new Error("ENOENT: no such file or directory");
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("watchDirectories", () => {
  it("derives the top-level directories from globs", () => {
    expect(watchDirectories(["src/**/*.ts", "public/**/*"])).toEqual(["src", "public"]);
  });

  it("dedupes globs that share a top-level directory", () => {
    expect(watchDirectories(["src/a/**", "src/b/**"])).toEqual(["src"]);
  });
});

/** Install a fake `fs.watch` and return a handle to drive its change listener. */
const fakeWatch = (): { fire: (filename: string) => void } => {
  let listener: ((event: string, filename: string) => void) | undefined;
  vi.mocked(fsWatch).mockImplementation(((_dir: string, _opts: unknown, cb: typeof listener) => {
    listener = cb;
    return { close: vi.fn() };
  }) as unknown as typeof fsWatch);
  return { fire: (filename: string) => listener?.("change", filename) };
};

describe("watchPaths", () => {
  it("debounces rapid changes into a single onChange carrying the full changed set", () => {
    vi.useFakeTimers();
    const watcher = fakeWatch();
    const onChange = vi.fn();

    watchPaths(["src/**/*"], 100, onChange);
    watcher.fire("a.ts");
    watcher.fire("b.ts");
    watcher.fire("c.ts");
    vi.advanceTimersByTime(100);

    // One coalesced rebuild that knows EVERY changed file (each joined with its watched dir).
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([
      path.join("src", "a.ts"),
      path.join("src", "b.ts"),
      path.join("src", "c.ts")
    ]);
  });

  it("dedupes repeated changes to the same path within one window", () => {
    vi.useFakeTimers();
    const watcher = fakeWatch();
    const onChange = vi.fn();

    watchPaths(["src/**/*"], 100, onChange);
    watcher.fire("a.ts");
    watcher.fire("a.ts");
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledWith([path.join("src", "a.ts")]);
  });

  it("clears the accumulated set between debounce windows", () => {
    vi.useFakeTimers();
    const watcher = fakeWatch();
    const onChange = vi.fn();

    watchPaths(["src/**/*"], 100, onChange);
    watcher.fire("a.ts");
    vi.advanceTimersByTime(100);
    watcher.fire("b.ts");
    vi.advanceTimersByTime(100);

    // The second window carries ONLY b.ts — a.ts was snapshot + cleared by the first fire.
    expect(onChange).toHaveBeenNthCalledWith(1, [path.join("src", "a.ts")]);
    expect(onChange).toHaveBeenNthCalledWith(2, [path.join("src", "b.ts")]);
  });
});

/** Fixed fake-timer epoch for the freshness-guard tests (guard thresholds derive from it). */
const T0 = 1_700_000_000_000;

/** Point the mocked statSync at a fixed inode: mtime = ctime = epochMs (untouched since then). */
const statReturns = (epochMs: number): void => {
  vi.mocked(statSync).mockReturnValue({ mtimeMs: epochMs, ctimeMs: epochMs } as unknown as Stats);
};

describe("watchPaths (stale-echo freshness guard)", () => {
  it("drops a batch whose every path predates the last delivered batch (clone echo)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const watcher = fakeWatch();
    const onChange = vi.fn();
    statReturns(T0 - 60_000); // the inode was last touched long ago and stays untouched

    watchPaths(["public/**/*"], 100, onChange);
    watcher.fire("big.mp3");
    vi.advanceTimersByTime(100);
    // First delivery passes (anything on disk beats the initial 0 threshold) and stamps it.
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.fire("big.mp3"); // the rebuild's clone echo — same path, inode untouched
    vi.advanceTimersByTime(100);

    // The echo batch predates the delivery above on every path — dropped, no second rebuild.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("delivers a batch whose path was really written after the last delivery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const watcher = fakeWatch();
    const onChange = vi.fn();
    statReturns(T0 - 60_000);

    watchPaths(["public/**/*"], 100, onChange);
    watcher.fire("big.mp3");
    vi.advanceTimersByTime(100); // delivered at T0+100 — the guard threshold
    statReturns(T0 + 150); // a real write lands after that delivery
    watcher.fire("big.mp3");
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("treats a missing path as a real change — deletions are never echoes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const watcher = fakeWatch();
    const onChange = vi.fn();
    statReturns(T0 - 60_000);

    watchPaths(["public/**/*"], 100, onChange);
    watcher.fire("big.mp3");
    vi.advanceTimersByTime(100); // delivered — threshold now ahead of the stale inode
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    watcher.fire("big.mp3"); // the file is gone now
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
