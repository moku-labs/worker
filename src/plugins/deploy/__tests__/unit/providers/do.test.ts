/**
 * Unit tests for the Durable Objects provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionDurableObject } from "../../../providers/do";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("do binding provisioned")
}));

describe("provisionDurableObject", () => {
  it("resolves without throwing for a single instance", async () => {
    await expect(
      provisionDurableObject({ kind: "do", binding: "COUNTER", className: "Counter" }, false)
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for another instance", async () => {
    await expect(
      provisionDurableObject({ kind: "do", binding: "ROOM", className: "Room" }, false)
    ).resolves.toBeUndefined();
  });

  it("passes ci flag through", async () => {
    await expect(
      provisionDurableObject({ kind: "do", binding: "COUNTER", className: "Counter" }, true)
    ).resolves.toBeUndefined();
  });

  it("returns void (not a value)", async () => {
    const result = await provisionDurableObject(
      { kind: "do", binding: "COUNTER", className: "Counter" },
      false
    );

    expect(result).toBeUndefined();
  });
});
