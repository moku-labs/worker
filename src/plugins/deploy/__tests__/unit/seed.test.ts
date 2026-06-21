/**
 * Unit tests for the seed/migration output parsers — the pure helpers that turn wrangler's captured
 * stdout into the facts the branded "Migrated" / "Seeded" panels report (so the raw TUI stays hidden).
 */
import { describe, expect, it } from "vitest";

import { parseMigrationsApplied, parseSeedStats } from "../../seed";

describe("parseSeedStats", () => {
  it("parses both the command count and the rows-written total from wrangler output", () => {
    const out = "🚣 Executed 18 commands in 0.5ms (10 rows read, 30 rows written)";
    expect(parseSeedStats(out)).toEqual({ statements: 18, rowsWritten: 30 });
  });

  it("handles singular forms ('1 command executed' / '1 row written')", () => {
    expect(parseSeedStats("1 command executed\n1 row written")).toEqual({
      statements: 1,
      rowsWritten: 1
    });
  });

  it("omits each field that is absent (empty / unrecognized output yields {})", () => {
    expect(parseSeedStats("")).toEqual({});
    expect(parseSeedStats("✨ Success")).toEqual({});
    expect(parseSeedStats("🚣 5 commands executed")).toEqual({ statements: 5 });
  });
});

describe("parseMigrationsApplied", () => {
  it("reports up-to-date when wrangler found nothing pending", () => {
    expect(parseMigrationsApplied("✅ No migrations to apply!")).toEqual({
      applied: [],
      upToDate: true
    });
  });

  it("collects the applied migration filenames in order", () => {
    const out = [
      "🌀 Loading 2 migrations...",
      "┌──────────────────────┐",
      "│ 0003_add_boards.sql  │",
      "│ 0004_add_index.sql   │",
      "└──────────────────────┘",
      "✅ 2 migrations applied"
    ].join("\n");

    expect(parseMigrationsApplied(out)).toEqual({
      applied: ["0003_add_boards.sql", "0004_add_index.sql"],
      upToDate: false
    });
  });

  it("de-duplicates a filename that appears more than once in the output", () => {
    const out = "Applying 0001_init.sql\nApplied 0001_init.sql ✓";
    expect(parseMigrationsApplied(out)).toEqual({ applied: ["0001_init.sql"], upToDate: false });
  });

  it("degrades to no names (not up-to-date) on an unrecognized but successful output", () => {
    expect(parseMigrationsApplied("done")).toEqual({ applied: [], upToDate: false });
  });
});
