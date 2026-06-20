/**
 * Unit tests for the moku-worker bin app discovery (existsSync stubbed).
 */
import { describe, expect, it, vi } from "vitest";

import { resolveConfigPath } from "../../load";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

import { existsSync } from "node:fs";

describe("resolveConfigPath", () => {
  it("uses an explicit path when provided", () => {
    expect(resolveConfigPath("/app", "custom/x.ts")).toBe("/app/custom/x.ts");
  });

  it("picks the first existing candidate", () => {
    vi.mocked(existsSync).mockImplementation(candidate =>
      String(candidate).endsWith("moku.config.mjs")
    );

    expect(resolveConfigPath("/app")).toBe("/app/moku.config.mjs");
  });

  it("falls back to moku.config.ts when none exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(resolveConfigPath("/app")).toBe("/app/moku.config.ts");
  });
});
