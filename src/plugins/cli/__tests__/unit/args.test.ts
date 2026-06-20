/**
 * Unit tests for parseStageArg — pure argv parsing, no process access.
 */
import { describe, expect, it } from "vitest";

import { parseStageArg } from "../../args";

describe("parseStageArg", () => {
  it("parses the spaced form `--stage dev`", () => {
    expect(parseStageArg(["bun", "scripts/deploy.ts", "--stage", "dev"])).toBe("dev");
  });

  it("parses the inline form `--stage=dev`", () => {
    expect(parseStageArg(["bun", "scripts/deploy.ts", "--stage=dev"])).toBe("dev");
  });

  it("returns undefined when no stage flag is present", () => {
    expect(parseStageArg(["bun", "scripts/deploy.ts"])).toBeUndefined();
  });

  it("returns undefined for an empty inline value", () => {
    expect(parseStageArg(["bun", "deploy.ts", "--stage="])).toBeUndefined();
  });

  it("returns undefined for an empty spaced value", () => {
    expect(parseStageArg(["bun", "deploy.ts", "--stage", ""])).toBeUndefined();
  });

  it("returns undefined when `--stage` is the last token (no value)", () => {
    expect(parseStageArg(["bun", "deploy.ts", "--stage"])).toBeUndefined();
  });

  it("ignores unrelated flags", () => {
    expect(parseStageArg(["bun", "deploy.ts", "--port", "3000"])).toBeUndefined();
  });

  it("returns the first non-empty stage when several are present", () => {
    expect(parseStageArg(["bun", "deploy.ts", "--stage", "dev", "--stage", "prod"])).toBe("dev");
  });
});
