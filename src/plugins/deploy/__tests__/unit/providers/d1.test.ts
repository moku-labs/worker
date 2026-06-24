/**
 * Unit tests for the D1 provider adapter (create + id capture + migrations).
 */
import { describe, expect, it, vi } from "vitest";

import { deleteD1, parseD1DatabaseId, provisionD1 } from "../../../providers/d1";

vi.mock("../../../runner", () => ({
  runWrangler: vi
    .fn()
    .mockResolvedValue(
      '{ "d1_databases": [ { "binding": "DB", "database_name": "db", "database_id": "uuid-1234" } ] }'
    )
}));

import { runWrangler } from "../../../runner";

describe("provisionD1", () => {
  it("calls runWrangler with d1 create args (by resource name)", async () => {
    await provisionD1({ kind: "d1", name: "tracker-db", binding: "DB" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["d1", "create", "tracker-db"])
    );
  });

  it("captures the created database id from wrangler output", async () => {
    await expect(
      provisionD1({ kind: "d1", name: "tracker-db", binding: "DB" }, false)
    ).resolves.toEqual({
      id: "uuid-1234"
    });
  });

  it("applies migrations (by resource name) when a migrations dir is provided", async () => {
    await provisionD1(
      { kind: "d1", name: "tracker-db", binding: "DB", migrations: "./migrations" },
      false
    );

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["d1", "migrations", "apply", "tracker-db", "--local"])
    );
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(
      provisionD1({ kind: "d1", name: "tracker-db", binding: "DB" }, true)
    ).resolves.toEqual({
      id: "uuid-1234"
    });
  });
});

describe("deleteD1", () => {
  it("calls runWrangler with d1 delete <name> -y", async () => {
    await deleteD1("tracker-db-dev");

    expect(runWrangler).toHaveBeenCalledWith(["d1", "delete", "tracker-db-dev", "-y"]);
  });

  it("resolves without throwing", async () => {
    await expect(deleteD1("tracker-db")).resolves.toBeUndefined();
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
