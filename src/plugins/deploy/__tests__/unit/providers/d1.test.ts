/**
 * Unit tests for the D1 provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionD1 } from "../../../providers/d1";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("d1 database created: DB")
}));

import { runWrangler } from "../../../runner";

describe("provisionD1", () => {
  it("calls runWrangler with d1 create args", async () => {
    await provisionD1({ kind: "d1", binding: "DB" }, false);

    expect(runWrangler).toHaveBeenCalledWith(expect.arrayContaining(["d1", "create", "DB"]));
  });

  it("resolves without throwing", async () => {
    await expect(provisionD1({ kind: "d1", binding: "DB" }, false)).resolves.toBeUndefined();
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(provisionD1({ kind: "d1", binding: "DB" }, true)).resolves.toBeUndefined();
  });

  it("handles migrations path when provided", async () => {
    await expect(
      provisionD1({ kind: "d1", binding: "DB", migrations: "./migrations" }, false)
    ).resolves.toBeUndefined();
  });
});
