/**
 * Unit tests for the infra preflight planner (Cloudflare client mocked).
 */
/* eslint-disable unicorn/no-null -- TurnExisting.workerSecrets is `null` by contract when the
   script does not exist yet; the mocks must produce exactly that shape. */
import { describe, expect, it, vi } from "vitest";

import type { Ctx, ExternalManifest } from "../../../types";

vi.mock("../../../infra/cloudflare", () => ({
  listExisting: vi.fn(),
  resolveAccount: vi.fn().mockResolvedValue({ id: "acc-123", name: "Play Co" })
}));

// The turn preflight is REST-bound; mock the fetch, keep the pure `turnExists` rule real.
vi.mock("../../../providers/turn", async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchTurnExisting: vi
      .fn()
      .mockResolvedValue({ workerSecrets: null, keysByName: new Map<string, string>() })
  };
});

import { listExisting } from "../../../infra/cloudflare";
import { planInfra } from "../../../infra/plan";
import { fetchTurnExisting } from "../../../providers/turn";

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

  it("judges a turn resource by the WORKER'S BOUND SECRETS — both bound → exists (id captured when a same-name key is found)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());
    vi.mocked(fetchTurnExisting).mockResolvedValueOnce({
      workerSecrets: new Set(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"]),
      keysByName: new Map([["app-turn", "uid-9"]])
    });

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([
        {
          kind: "turn",
          name: "app-turn",
          keyIdBinding: "TURN_KEY_ID",
          apiTokenBinding: "TURN_KEY_API_TOKEN"
        }
      ])
    );

    expect(plan.exists).toEqual([
      {
        resource: {
          kind: "turn",
          name: "app-turn",
          keyIdBinding: "TURN_KEY_ID",
          apiTokenBinding: "TURN_KEY_API_TOKEN"
        },
        id: "uid-9"
      }
    ]);
    expect(plan.missing).toEqual([]);
    // A hand-bound key (secrets bound, no same-name key) also counts — but carries no id.
  });

  it("a turn resource with unbound secrets is MISSING — even when a same-name key exists (its secret is unrecoverable)", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());
    vi.mocked(fetchTurnExisting).mockResolvedValueOnce({
      workerSecrets: new Set(["TURN_KEY_ID"]), // half-bound (torn run)
      keysByName: new Map([["app-turn", "uid-9"]])
    });

    const plan = await planInfra(
      makeCtx("acc-123"),
      manifest([
        {
          kind: "turn",
          name: "app-turn",
          keyIdBinding: "TURN_KEY_ID",
          apiTokenBinding: "TURN_KEY_API_TOKEN"
        }
      ])
    );

    expect(plan.missing).toHaveLength(1);
    expect(plan.exists).toEqual([]);
    // The plan carries the turn preflight so the provision step can delete the stale key.
    expect(plan.turn?.keysByName.get("app-turn")).toBe("uid-9");
  });

  it("turn never rides the account LISTING (no Calls scope needed to plan) and skips the fetch when none is declared", async () => {
    vi.mocked(listExisting).mockResolvedValue(emptyExisting());

    await planInfra(
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
    expect(listExisting).toHaveBeenCalledWith("test-token", "acc-123", new Set(["kv"]));
    expect(fetchTurnExisting).toHaveBeenCalledWith(
      { accountId: "acc-123", token: "test-token" },
      "w"
    );

    vi.mocked(fetchTurnExisting).mockClear();
    await planInfra(makeCtx("acc-123"), manifest([{ kind: "kv", name: "cache", binding: "KV" }]));
    expect(fetchTurnExisting).not.toHaveBeenCalled();
  });
});
