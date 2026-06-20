/**
 * Unit tests for the KV provider adapter (create + id capture).
 */
import { describe, expect, it, vi } from "vitest";

import { parseKvNamespaceId, provisionKv } from "../../../providers/kv";

vi.mock("../../../runner", () => ({
  runWrangler: vi
    .fn()
    .mockResolvedValue('{ "kv_namespaces": [ { "binding": "CACHE", "id": "ns-abc123" } ] }')
}));

import { runWrangler } from "../../../runner";

describe("provisionKv", () => {
  it("calls runWrangler with kv namespace create args (by resource name)", async () => {
    await provisionKv({ kind: "kv", name: "tracker-cache", binding: "CACHE" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["kv", "namespace", "create", "tracker-cache"])
    );
  });

  it("captures the created namespace id from wrangler output", async () => {
    await expect(
      provisionKv({ kind: "kv", name: "tracker-cache", binding: "CACHE" }, false)
    ).resolves.toEqual({
      id: "ns-abc123"
    });
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(
      provisionKv({ kind: "kv", name: "tracker-kv", binding: "KV" }, true)
    ).resolves.toEqual({
      id: "ns-abc123"
    });
  });
});

describe("parseKvNamespaceId", () => {
  it("parses the id from JSON output", () => {
    expect(parseKvNamespaceId('{ "id": "abc123" }')).toBe("abc123");
  });

  it("parses the id from TOML output", () => {
    expect(parseKvNamespaceId('binding = "CACHE"\nid = "def456"')).toBe("def456");
  });

  it("does not match a longer identifier such as kv_namespace_id", () => {
    expect(parseKvNamespaceId('kv_namespace_id = "nope"')).toBeUndefined();
  });

  it("returns undefined when no id is present", () => {
    expect(parseKvNamespaceId("no id here")).toBeUndefined();
  });
});
