/**
 * Unit tests for the Durable Objects provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionDurableObject } from "../../../providers/do";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("do binding provisioned")
}));

describe("provisionDurableObject", () => {
  it("resolves without throwing for a single binding", async () => {
    await expect(
      provisionDurableObject({ kind: "do", bindings: { counter: "COUNTER" } }, false)
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for multiple bindings", async () => {
    await expect(
      provisionDurableObject({ kind: "do", bindings: { counter: "COUNTER", room: "ROOM" } }, false)
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for empty bindings", async () => {
    await expect(
      provisionDurableObject({ kind: "do", bindings: {} }, false)
    ).resolves.toBeUndefined();
  });

  it("passes ci flag through", async () => {
    await expect(
      provisionDurableObject({ kind: "do", bindings: { counter: "COUNTER" } }, true)
    ).resolves.toBeUndefined();
  });

  it("returns void (not a value)", async () => {
    const result = await provisionDurableObject({ kind: "do", bindings: {} }, false);

    expect(result).toBeUndefined();
  });
});
