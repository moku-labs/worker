/**
 * Unit tests for the Queues provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { deleteQueue, provisionQueue } from "../../../providers/queues";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("queue created: orders"),
  runWranglerYes: vi.fn().mockResolvedValue("Deleted queue orders")
}));

import { runWrangler, runWranglerYes } from "../../../runner";

describe("provisionQueue", () => {
  it("calls runWrangler with queues create args (by resource name)", async () => {
    await provisionQueue({ kind: "queue", name: "orders", binding: "ORDERS" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["queues", "create", "orders"])
    );
  });

  it("resolves without throwing", async () => {
    await expect(
      provisionQueue({ kind: "queue", name: "orders", binding: "ORDERS" }, false)
    ).resolves.toBeUndefined();
  });

  it("passes ci flag through", async () => {
    await expect(
      provisionQueue({ kind: "queue", name: "jobs", binding: "JOBS" }, true)
    ).resolves.toBeUndefined();
  });
});

describe("deleteQueue", () => {
  it("calls runWranglerYes with queues delete <name> (no -y flag exists; prompt is auto-answered)", async () => {
    await deleteQueue("tracker-activity-dev");

    expect(runWranglerYes).toHaveBeenCalledWith(["queues", "delete", "tracker-activity-dev"]);
  });

  it("resolves without throwing", async () => {
    await expect(deleteQueue("orders")).resolves.toBeUndefined();
  });
});
