/**
 * Unit tests for the infra preflight planner (Cloudflare client mocked).
 */
import { describe, expect, it, vi } from "vitest";

import type { Ctx, ExternalManifest } from "../../../types";

vi.mock("../../../infra/cloudflare", () => ({
  listExisting: vi.fn(),
  resolveAccount: vi.fn().mockResolvedValue({ id: "acc-123", name: "Play Co" })
}));

import { listExisting } from "../../../infra/cloudflare";
import { planInfra } from "../../../infra/plan";

/** An empty existing-resources index. */
const emptyExisting = () => ({
  kv: new Map<string, string>(),
  d1: new Map<string, string>(),
  r2: new Set<string>(),
  queue: new Set<string>()
});

/** Build a mock deploy ctx with just the env + emit surface planInfra uses. */
const makeCtx = (accountId?: string): Ctx =>
  ({
    emit: vi.fn(),
    env: {
      get: (key: string) => (key === "CLOUDFLARE_ACCOUNT_ID" ? accountId : undefined),
      require: () => "test-token",
      has: () => true,
      getPublic: () => ({}),
      getPublicMap: () => new Map<string, string>()
    }
  }) as unknown as Ctx;

const manifest = (resources: ExternalManifest["resources"]): ExternalManifest => ({
  name: "w",
  compatibilityDate: "2026-06-17",
  resources
});

describe("planInfra", () => {
  it("classifies a missing kv resource as missing", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "kv", binding: "SESSIONS" }])
    );

    expect(plan.missing).toEqual([{ kind: "kv", binding: "SESSIONS" }]);
    expect(plan.exists).toEqual([]);
  });

  it("classifies an existing kv resource as existing and captures its id", async () => {
    const existing = emptyExisting();
    existing.kv.set("SESSIONS", "ns-123");
    vi.mocked(listExisting).mockResolvedValue(existing);

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "kv", binding: "SESSIONS" }])
    );

    expect(plan.exists).toEqual([{ resource: { kind: "kv", binding: "SESSIONS" }, id: "ns-123" }]);
    expect(plan.missing).toEqual([]);
  });

  it("treats durable objects as always missing (config-only, no pre-create)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "do", bindings: { counter: "COUNTER" } }])
    );

    expect(plan.missing).toEqual([{ kind: "do", bindings: { counter: "COUNTER" } }]);
  });

  it("treats a queue as existing only when every producer already exists", async () => {
    const existing = emptyExisting();
    existing.queue.add("orders");
    vi.mocked(listExisting).mockResolvedValue(existing);

    const partial = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "queue", producers: ["orders", "refunds"] }])
    );
    expect(partial.missing).toHaveLength(1);

    existing.queue.add("refunds");
    const full = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "queue", producers: ["orders", "refunds"] }])
    );
    expect(full.exists).toHaveLength(1);
  });

  it("emits provision:plan with the counts and account", async () => {
    const existing = emptyExisting();
    existing.kv.set("A", "id-a");
    vi.mocked(listExisting).mockResolvedValue(existing);
    const ctx = makeCtx("acc-123");

    await planInfra(
      ctx,
      manifest([
        { kind: "kv", binding: "A" },
        { kind: "kv", binding: "B" }
      ])
    );

    expect(ctx.emit).toHaveBeenCalledWith("provision:plan", {
      exists: 1,
      missing: 1,
      account: "acc-123"
    });
  });

  it("resolves the account when CLOUDFLARE_ACCOUNT_ID is not pinned", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(makeCtx(), manifest([]));

    expect(plan).toMatchObject({ account: "Play Co", accountId: "acc-123" });
  });
});
