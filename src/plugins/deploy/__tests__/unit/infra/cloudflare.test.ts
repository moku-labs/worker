/**
 * Unit tests for the Cloudflare REST discovery client (global fetch stubbed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { listExisting, resolveAccount } from "../../../infra/cloudflare";

/** Build a minimal fake Response carrying a JSON body. */
const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: () => Promise.resolve(body) }) as unknown as Response;

/** Map a Cloudflare list URL to a representative success body (one existing resource per kind). */
const listBodyFor = (url: string): unknown => {
  if (url.includes("/storage/kv/namespaces")) {
    return { success: true, result: [{ id: "ns1", title: "SESSIONS" }] };
  }
  if (url.includes("/d1/database")) {
    return { success: true, result: [{ uuid: "db-uuid", name: "DB" }] };
  }
  if (url.includes("/r2/buckets")) {
    return { success: true, result: { buckets: [{ name: "assets" }] } };
  }
  return { success: true, result: [{ queue_name: "orders" }] };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAccount", () => {
  it("returns the first accessible account id and name", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ success: true, result: [{ id: "acc-123", name: "Play Co" }] })
        )
    );

    await expect(resolveAccount("token")).resolves.toEqual({ id: "acc-123", name: "Play Co" });
  });

  it("throws a branded error when no account is accessible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] })));

    await expect(resolveAccount("token")).rejects.toThrow("[moku-worker]");
  });

  it("throws with the API error message when the request reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ success: false, errors: [{ message: "Invalid token" }] }, false, 403)
        )
    );

    await expect(resolveAccount("token")).rejects.toThrow("Invalid token");
  });
});

describe("listExisting", () => {
  it("indexes kv/d1/r2/queue by identity (kv/d1 carry ids)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => Promise.resolve(jsonResponse(listBodyFor(url))))
    );

    const existing = await listExisting("token", "acc-123");

    expect(existing.kv.get("SESSIONS")).toBe("ns1");
    expect(existing.d1.get("DB")).toBe("db-uuid");
    expect(existing.r2.has("assets")).toBe(true);
    expect(existing.queue.has("orders")).toBe(true);
  });

  it("sends the bearer token in the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listExisting("my-token", "acc-123");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-token");
  });
});
