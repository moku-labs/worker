/**
 * Unit tests for the D1 provider adapter (create + id capture + migrations).
 */
import { describe, expect, it, vi } from "vitest";

import { parseD1DatabaseId, provisionD1 } from "../../../providers/d1";

vi.mock("../../../runner", () => ({
  runWrangler: vi
    .fn()
    .mockResolvedValue(
      '{ "d1_databases": [ { "binding": "DB", "database_name": "db", "database_id": "uuid-1234" } ] }'
    )
}));

import { runWrangler } from "../../../runner";

describe("provisionD1", () => {
  it("calls runWrangler with d1 create args", async () => {
    await provisionD1({ kind: "d1", binding: "DB" }, false);

    expect(runWrangler).toHaveBeenCalledWith(expect.arrayContaining(["d1", "create", "DB"]));
  });

  it("captures the created database id from wrangler output", async () => {
    await expect(provisionD1({ kind: "d1", binding: "DB" }, false)).resolves.toEqual({
      id: "uuid-1234"
    });
  });

  it("applies migrations when a migrations dir is provided", async () => {
    await provisionD1({ kind: "d1", binding: "DB", migrations: "./migrations" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["d1", "migrations", "apply", "DB", "--local"])
    );
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(provisionD1({ kind: "d1", binding: "DB" }, true)).resolves.toEqual({
      id: "uuid-1234"
    });
  });
});

describe("parseD1DatabaseId", () => {
  it("parses the database id from JSON output", () => {
    expect(parseD1DatabaseId('{ "database_id": "uuid-1234" }')).toBe("uuid-1234");
  });

  it("parses the database id from TOML output", () => {
    expect(parseD1DatabaseId('database_id = "uuid-9999"')).toBe("uuid-9999");
  });

  it("returns undefined when no database id is present", () => {
    expect(parseD1DatabaseId("Successfully created DB")).toBeUndefined();
  });
});
