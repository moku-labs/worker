/**
 * Unit tests for the dev filesystem watcher (watchDirectories is pure; watchPaths debounce via fake timers).
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { watchDirectories, watchPaths } from "../../../dev/watch";

vi.mock("node:fs", () => ({ watch: vi.fn(), existsSync: vi.fn(() => true) }));

import { watch as fsWatch } from "node:fs";

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
