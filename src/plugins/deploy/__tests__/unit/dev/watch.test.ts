/**
 * Unit tests for the dev filesystem watcher (watchDirectories is pure; watchPaths debounce via fake timers).
 */
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

describe("watchPaths", () => {
  it("debounces rapid changes into a single onChange with the last path", () => {
    vi.useFakeTimers();
    let listener: ((event: string, filename: string) => void) | undefined;
    vi.mocked(fsWatch).mockImplementation(((_dir: string, _opts: unknown, cb: typeof listener) => {
      listener = cb;
      return { close: vi.fn() };
    }) as unknown as typeof fsWatch);
    const onChange = vi.fn();

    watchPaths(["src/**/*"], 100, onChange);
    listener?.("change", "a.ts");
    listener?.("change", "b.ts");
    listener?.("change", "c.ts");
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("c.ts"));
  });
});
