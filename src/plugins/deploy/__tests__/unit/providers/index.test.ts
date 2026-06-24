/**
 * Unit tests for the provider deletion dispatcher (destroyResource → per-kind delete adapter).
 */
import { describe, expect, it, vi } from "vitest";

import { destroyResource } from "../../../providers";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue(""),
  runWranglerYes: vi.fn().mockResolvedValue("")
}));

import { runWrangler, runWranglerYes } from "../../../runner";

describe("destroyResource", () => {
  it("routes a KV ref to a namespace delete by its captured id", async () => {
    await destroyResource({
      resource: { kind: "kv", name: "cache-dev", binding: "CACHE" },
      id: "ns-1"
    });

    expect(runWrangler).toHaveBeenCalledWith([
      "kv",
      "namespace",
      "delete",
      "--namespace-id",
      "ns-1",
      "-y"
    ]);
  });

  it("throws when a KV ref carries no captured namespace id", async () => {
    await expect(
      destroyResource({ resource: { kind: "kv", name: "cache-dev", binding: "CACHE" } })
    ).rejects.toThrow(/no namespace id/iu);
  });

  it("routes a D1 ref to d1 delete by name", async () => {
    await destroyResource({ resource: { kind: "d1", name: "db-dev", binding: "DB" } });

    expect(runWrangler).toHaveBeenCalledWith(["d1", "delete", "db-dev", "-y"]);
  });

  it("routes an R2 ref to r2 bucket delete (auto-confirmed)", async () => {
    await destroyResource({ resource: { kind: "r2", name: "files-dev", binding: "FILES" } });

    expect(runWranglerYes).toHaveBeenCalledWith(["r2", "bucket", "delete", "files-dev"]);
  });

  it("routes a queue ref to queues delete (auto-confirmed)", async () => {
    await destroyResource({ resource: { kind: "queue", name: "jobs-dev", binding: "JOBS" } });

    expect(runWranglerYes).toHaveBeenCalledWith(["queues", "delete", "jobs-dev"]);
  });

  it("throws for a Durable Object ref (removed with the Worker, not individually)", async () => {
    await expect(
      destroyResource({ resource: { kind: "do", binding: "ROOM", className: "Room" } })
    ).rejects.toThrow(/removed with the Worker/iu);
  });
});
