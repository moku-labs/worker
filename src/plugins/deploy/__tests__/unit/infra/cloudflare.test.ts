/**
 * Unit tests for the Cloudflare REST discovery client (global fetch stubbed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ListableKind,
  listExisting,
  resolveAccount,
  verifyToken
} from "../../../infra/cloudflare";

/** All four listable kinds — the default scope for the "lists everything" cases. */
const ALL_KINDS = new Set<ListableKind>(["kv", "d1", "r2", "queue"]);

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

    await expect(resolveAccount("token")).rejects.toThrow("[worker]");
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

describe("verifyToken", () => {
  it("returns the status for an active token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: true, result: { id: "t1", status: "active" } }))
    );

    await expect(verifyToken("tok")).resolves.toEqual({ status: "active" });
  });

  it("throws a branded error when the token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ success: false, errors: [{ message: "Invalid API Token" }] }, false, 401)
        )
    );

    await expect(verifyToken("bad")).rejects.toThrow("[worker]");
  });
});

describe("listExisting", () => {
  it("indexes kv/d1/r2/queue by identity (kv/d1 carry ids)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => Promise.resolve(jsonResponse(listBodyFor(url))))
    );

    const existing = await listExisting("token", "acc-123", ALL_KINDS);

    expect(existing.kv.get("SESSIONS")).toBe("ns1");
    expect(existing.d1.get("DB")).toBe("db-uuid");
    expect(existing.r2.has("assets")).toBe(true);
    expect(existing.queue.has("orders")).toBe(true);
  });

  it("queries only the declared kinds — an absent kind is never fetched", async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(jsonResponse(listBodyFor(url))));
    vi.stubGlobal("fetch", fetchMock);

    const existing = await listExisting("token", "acc-123", new Set<ListableKind>(["kv"]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0] as string).toContain("/storage/kv/namespaces");
    expect(existing.kv.get("SESSIONS")).toBe("ns1");
    expect(existing.d1.size).toBe(0);
    expect(existing.r2.size).toBe(0);
    expect(existing.queue.size).toBe(0);
  });

  it("sends the bearer token in the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await listExisting("my-token", "acc-123", new Set<ListableKind>(["kv"]));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-token");
  });
});
