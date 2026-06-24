/**
 * Unit tests for the Worker deletion adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { deleteWorker } from "../../../providers/worker";

vi.mock("../../../runner", () => ({
  runWranglerYes: vi.fn().mockResolvedValue("Successfully deleted tracker-worker-dev")
}));

import { runWranglerYes } from "../../../runner";

describe("deleteWorker", () => {
  it("calls runWranglerYes with delete <name> --force (prompt is auto-answered)", async () => {
    await deleteWorker("tracker-worker-dev");

    expect(runWranglerYes).toHaveBeenCalledWith(["delete", "tracker-worker-dev", "--force"]);
  });

  it("resolves without throwing", async () => {
    await expect(deleteWorker("tracker-worker")).resolves.toBeUndefined();
  });
});
