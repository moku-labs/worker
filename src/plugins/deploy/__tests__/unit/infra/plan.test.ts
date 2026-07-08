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
      manifest([{ kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }])
    );

    expect(plan.missing).toEqual([{ kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }]);
    expect(plan.exists).toEqual([]);
  });

  it("classifies an existing kv resource (matched by name) as existing and captures its id", async () => {
    const existing = emptyExisting();
    existing.kv.set("tracker-sessions", "ns-123");
    vi.mocked(listExisting).mockResolvedValue(existing);

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }])
    );

    expect(plan.exists).toEqual([
      { resource: { kind: "kv", name: "tracker-sessions", binding: "SESSIONS" }, id: "ns-123" }
    ]);
    expect(plan.missing).toEqual([]);
  });

  it("partitions durable objects into `ships` — never exists/missing (they ship with the Worker)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "do", binding: "COUNTER", className: "Counter" }])
    );

    // The DO is never "to create" (it deploys with the Worker) and never "exists" (the planner never
    // queried the account for it) — it gets its own `ships` bucket.
    expect(plan.missing).toEqual([]);
    expect(plan.exists).toEqual([]);
    expect(plan.ships).toEqual([{ kind: "do", binding: "COUNTER", className: "Counter" }]);
  });

  it("treats a queue as existing only when its name already exists", async () => {
    const existing = emptyExisting();
    vi.mocked(listExisting).mockResolvedValue(existing);

    const partial = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "queue", name: "orders", binding: "ORDERS" }])
    );
    expect(partial.missing).toHaveLength(1);

    existing.queue.add("orders");
    const full = await planInfra(
      makeCtx("acc-123"),
      manifest([{ kind: "queue", name: "orders", binding: "ORDERS" }])
    );
    expect(full.exists).toHaveLength(1);
  });

  it("emits provision:plan with the counts (incl. ships) and account", async () => {
    const existing = emptyExisting();
    existing.kv.set("cache-a", "id-a");
    vi.mocked(listExisting).mockResolvedValue(existing);
    const ctx = makeCtx("acc-123");

    await planInfra(
      ctx,
      manifest([
        { kind: "kv", name: "cache-a", binding: "A" },
        { kind: "kv", name: "cache-b", binding: "B" },
        { kind: "do", binding: "COUNTER", className: "Counter" }
      ])
    );

    expect(ctx.emit).toHaveBeenCalledWith("provision:plan", {
      exists: 1,
      missing: 1,
      ships: 1,
      account: "acc-123"
    });
  });

  it("resolves the account when CLOUDFLARE_ACCOUNT_ID is not pinned", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(makeCtx(), manifest([]));

    expect(plan).toMatchObject({ account: "Play Co", accountId: "acc-123" });
  });

  it("lists only the kinds the manifest declares (DO excluded — it ships with the script)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    await planInfra(
      makeCtx("acc-123"),
      manifest([
        { kind: "kv", name: "tracker-sessions", binding: "SESSIONS" },
        { kind: "d1", name: "tracker-db", binding: "DB" },
        { kind: "do", binding: "COUNTER", className: "Counter" }
      ])
    );

    expect(listExisting).toHaveBeenCalledWith("test-token", "acc-123", new Set(["kv", "d1"]));
  });

  it("excludes turn resources from the plan entirely (never listed, never in any bucket)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([
        { kind: "kv", name: "cache", binding: "KV" },
        {
          kind: "turn",
          name: "app-turn",
          keyIdBinding: "TURN_KEY_ID",
          apiTokenBinding: "TURN_KEY_API_TOKEN"
        }
      ])
    );

    // TURN keys are ensured in the built-in post-deploy phase — the account listing can't judge
    // them (the key secret is unrecoverable), so the plan neither lists nor provisions them.
    expect(listExisting).toHaveBeenCalledWith("test-token", "acc-123", new Set(["kv"]));
    expect(plan.missing).toEqual([{ kind: "kv", name: "cache", binding: "KV" }]);
    expect(plan.exists).toEqual([]);
    expect(plan.ships).toEqual([]);
  });
});
