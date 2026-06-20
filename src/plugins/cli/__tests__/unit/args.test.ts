/**
 * Unit tests for parsePortArg — pure argv parsing, no process access.
 */
import { describe, expect, it } from "vitest";

import { parsePortArg } from "../../args";

describe("parsePortArg", () => {
  it("parses the spaced form `--port 3000`", () => {
    expect(parsePortArg(["bun", "scripts/dev.ts", "--port", "3000"])).toBe(3000);
  });

  it("parses the inline form `--port=3000`", () => {
    expect(parsePortArg(["bun", "scripts/dev.ts", "--port=3000"])).toBe(3000);
  });

  it("parses the short flags `-p 4000` and `-p=4000`", () => {
    expect(parsePortArg(["bun", "dev.ts", "-p", "4000"])).toBe(4000);
    expect(parsePortArg(["bun", "dev.ts", "-p=4000"])).toBe(4000);
  });

  it("returns undefined when no port flag is present", () => {
    expect(parsePortArg(["bun", "scripts/dev.ts"])).toBeUndefined();
  });

  it("returns undefined for a non-numeric value", () => {
    expect(parsePortArg(["bun", "dev.ts", "--port", "abc"])).toBeUndefined();
  });

  it("returns undefined for a non-integer value", () => {
    expect(parsePortArg(["bun", "dev.ts", "--port", "30.5"])).toBeUndefined();
  });

  it("returns undefined for an out-of-range port", () => {
    expect(parsePortArg(["bun", "dev.ts", "--port", "0"])).toBeUndefined();
    expect(parsePortArg(["bun", "dev.ts", "--port", "70000"])).toBeUndefined();
  });

  it("returns undefined when `--port` is the last token (no value)", () => {
    expect(parsePortArg(["bun", "dev.ts", "--port"])).toBeUndefined();
  });

  it("ignores unrelated flags", () => {
    expect(parsePortArg(["bun", "dev.ts", "--config", "wrangler.jsonc"])).toBeUndefined();
  });

  it("returns the first valid port when several are present", () => {
    expect(parsePortArg(["bun", "dev.ts", "--port", "3000", "--port", "4000"])).toBe(3000);
  });
});
