/**
 * Unit tests for the Queues provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionQueue } from "../../../providers/queues";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("queue created: orders")
}));

import { runWrangler } from "../../../runner";

describe("provisionQueue", () => {
  it("calls runWrangler with queues create args for each producer", async () => {
    await provisionQueue({ kind: "queue", producers: ["orders"] }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["queues", "create", "orders"])
    );
  });

  it("resolves without throwing for a single producer", async () => {
    await expect(
      provisionQueue({ kind: "queue", producers: ["orders"] }, false)
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for multiple producers", async () => {
    await expect(
      provisionQueue({ kind: "queue", producers: ["orders", "refunds"] }, false)
    ).resolves.toBeUndefined();
  });

  it("resolves without throwing for empty producers array", async () => {
    await expect(provisionQueue({ kind: "queue", producers: [] }, false)).resolves.toBeUndefined();
  });

  it("passes ci flag through", async () => {
    await expect(
      provisionQueue({ kind: "queue", producers: ["jobs"] }, true)
    ).resolves.toBeUndefined();
  });
});
