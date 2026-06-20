/**
 * Unit tests for `.env` token verification + account resolution (Cloudflare client mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../../types";

vi.mock("../../../infra/cloudflare", () => ({
  verifyToken: vi.fn(),
  resolveAccount: vi.fn().mockResolvedValue({ id: "acc-1", name: "Play Co" })
}));

import { verifyAuth } from "../../../auth/verify";
import { resolveAccount, verifyToken } from "../../../infra/cloudflare";

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a mock deploy ctx with just the env + emit surface verifyAuth uses. */
const makeCtx = (token?: string, accountId?: string): Ctx =>
  ({
    emit: vi.fn(),
    env: {
      get: (key: string) => {
        if (key === "CLOUDFLARE_API_TOKEN") return token;
        if (key === "CLOUDFLARE_ACCOUNT_ID") return accountId;
        return undefined;
      },
      require: () => token ?? "",
      has: () => true,
      getPublic: () => ({}),
      getPublicMap: () => new Map<string, string>()
    }
  }) as unknown as Ctx;

describe("verifyAuth", () => {
  it("throws a branded error pointing at `auth setup` when the token is missing", async () => {
    await expect(verifyAuth(makeCtx(undefined))).rejects.toThrow("auth setup");
  });

  it("throws when the token is invalid (verifyToken rejects)", async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error("401"));

    await expect(verifyAuth(makeCtx("bad"))).rejects.toThrow("invalid or expired");
  });

  it("throws when the token is not active", async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ status: "disabled" });

    await expect(verifyAuth(makeCtx("tok"))).rejects.toThrow("not active");
  });

  it("resolves the account and emits auth:verified for an active token", async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ status: "active" });
    const ctx = makeCtx("tok");

    const status = await verifyAuth(ctx);

    expect(status).toMatchObject({ ok: true, account: "Play Co", accountId: "acc-1" });
    expect(ctx.emit).toHaveBeenCalledWith("auth:verified", {
      account: "Play Co",
      accountId: "acc-1",
      scopes: []
    });
  });

  it("uses a pinned CLOUDFLARE_ACCOUNT_ID without calling resolveAccount", async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ status: "active" });

    const status = await verifyAuth(makeCtx("tok", "pinned-acc"));

    expect(status.accountId).toBe("pinned-acc");
    expect(resolveAccount).not.toHaveBeenCalled();
  });
});
