/**
 * Unit tests for the KV provider adapter.
 */
import { describe, expect, it, vi } from "vitest";

import { provisionKv } from "../../../providers/kv";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue('kv_namespace_id = "abc123"')
}));

import { runWrangler } from "../../../runner";

describe("provisionKv", () => {
  it("calls runWrangler with kv namespace create args", async () => {
    await provisionKv({ kind: "kv", binding: "CACHE" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["kv", "namespace", "create", "CACHE"])
    );
  });

  it("resolves without throwing", async () => {
    await expect(provisionKv({ kind: "kv", binding: "SESSIONS" }, false)).resolves.toBeUndefined();
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(provisionKv({ kind: "kv", binding: "KV" }, true)).resolves.toBeUndefined();
  });
});
