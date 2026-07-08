/**
 * Unit tests for the TURN provisioning adapter (standard-flow edition): the fail-open preflight
 * (`fetchTurnExisting`), the secrets-bound exists rule (`turnExists` — a hand-bound key counts, a
 * same-name secretless key does not), provision-phase creation with stale-key cleanup
 * (`provisionTurn` — loud per-step errors), the post-deploy bind (`bindTurnSecrets`), and teardown
 * (`deleteTurnKey`).
 */
/* eslint-disable unicorn/no-null -- TurnExisting.workerSecrets is `null` by contract when the
   script does not exist yet; the REST double and fixtures must produce exactly that shape. */
import { describe, expect, it } from "vitest";
import {
  bindTurnSecrets,
  deleteTurnKey,
  fetchTurnExisting,
  provisionTurn,
  type TurnExisting,
  type TurnRestDeps,
  turnExists,
  turnInstruction
} from "../../../providers/turn";
import type { ResourceManifest } from "../../../types";

/** The default-named turn resource under test. */
const RESOURCE: Extract<ResourceManifest, { kind: "turn" }> = {
  kind: "turn",
  name: "party-app-turn",
  keyIdBinding: "TURN_KEY_ID",
  apiTokenBinding: "TURN_KEY_API_TOKEN",
  verifyPath: false
};

/** One recorded REST call. */
type Call = { method: string; url: string; body?: unknown };

/**
 * A scripted Cloudflare REST double: records calls, answers by URL/method with the standard
 * `{ success, result }` envelope.
 */
function cfApi(script: {
  secrets?: string[] | "missing-script";
  keys?: Array<{ uid: string; name: string }> | "forbidden";
  create?: { uid?: string; key?: string } | "forbidden";
  put?: "ok" | "fail";
  del?: "ok" | "fail";
  subdomain?: string;
  mint?: "ok" | "dead" | "not-an-endpoint" | "network";
  envMint?: "ok" | "rejected" | "network";
}): { deps: TurnRestDeps; calls: Call[] } {
  const calls: Call[] = [];

  // Per-endpoint answerers keep the dispatch flat (one route, one function).
  const answerSecretsList = (): Response =>
    script.secrets === "missing-script"
      ? Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 })
      : Response.json({
          success: true,
          result: (script.secrets ?? []).map(name => ({ name, type: "secret_text" }))
        });
  const answerKeysList = (): Response =>
    script.keys === "forbidden"
      ? Response.json({ success: false }, { status: 403 })
      : Response.json({ success: true, result: script.keys ?? [] });
  const answerDelete = (): Response =>
    script.del === "fail"
      ? Response.json({ success: false }, { status: 500 })
      : Response.json({ success: true, result: null });
  const answerCreate = (): Response =>
    script.create === "forbidden"
      ? Response.json(
          { success: false, errors: [{ message: "lacks permission" }] },
          { status: 403 }
        )
      : Response.json({ success: true, result: script.create ?? {} }, { status: 201 });
  const answerPut = (body: { name?: string } | undefined): Response =>
    script.put === "fail"
      ? Response.json({ success: false }, { status: 500 })
      : Response.json({ success: true, result: { name: body?.name } });

  const answerEnvMint = (): Response => {
    if (script.envMint === "network") throw new Error("network down");
    if (script.envMint === "rejected") return Response.json({ success: false }, { status: 403 });
    return Response.json(
      { iceServers: { urls: ["turn:turn.cloudflare.com:3478"] } },
      { status: 201 }
    );
  };

  const answerWorkerMint = (): Response => {
    if (script.mint === "network") throw new Error("network down");
    return answerMint();
  };

  const answerMint = (): Response => {
    if (script.mint === "dead") return Response.json({ error: "mint-failed" }, { status: 502 });
    if (script.mint === "not-an-endpoint") return new Response("<html>", { status: 404 });
    return Response.json({ iceServers: [{ urls: "turn:turn.cloudflare.com:3478" }] });
  };

  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url: String(url), body });
    const at = String(url);

    if (at.includes("rtc.live.cloudflare.com")) return answerEnvMint();
    if (at.includes(".workers.dev")) return answerWorkerMint();
    if (at.includes("/workers/subdomain")) {
      return Response.json({ success: true, result: { subdomain: script.subdomain ?? "acme" } });
    }
    if (at.includes("/workers/scripts/") && method === "GET") return answerSecretsList();
    if (at.includes("/calls/turn_keys") && method === "GET") return answerKeysList();
    if (at.includes("/calls/turn_keys") && method === "DELETE") return answerDelete();
    if (at.includes("/calls/turn_keys") && method === "POST") return answerCreate();
    if (at.includes("/workers/scripts/") && method === "PUT") return answerPut(body);
    throw new Error(`unexpected call: ${method} ${at}`);
  }) as unknown as typeof fetch;

  return { deps: { accountId: "acc-42", token: "cf-token", fetchImpl }, calls };
}

describe("fetchTurnExisting (fail-open preflight)", () => {
  it("reads the worker's secret names + the account keys by name", async () => {
    const { deps } = cfApi({
      secrets: ["TURN_KEY_ID", "OTHER"],
      keys: [{ uid: "uid-1", name: "party-app-turn" }]
    });

    const existing = await fetchTurnExisting(deps, "party-app", false);

    expect([...(existing.workerSecrets ?? [])]).toEqual(["TURN_KEY_ID", "OTHER"]);
    expect(existing.keysByName.get("party-app-turn")).toBe("uid-1");
  });

  it("a missing script resolves workerSecrets: null; a forbidden key listing resolves empty (never throws)", async () => {
    const { deps } = cfApi({ secrets: "missing-script", keys: "forbidden" });

    const existing = await fetchTurnExisting(deps, "party-app", false);

    expect(existing.workerSecrets).toBeNull();
    expect(existing.keysByName.size).toBe(0);
  });
});

/** A TurnExisting fixture: secrets bound + a listable account key set. */
const existingState = (
  names: string[],
  keys: Array<[string, string]> = [],
  keysListable = true
): TurnExisting => ({
  workerSecrets: new Set(names),
  keysByName: new Map(keys),
  keysListable,
  mintOk: null
});

describe("turnExists (name-anchored rule)", () => {
  it("exists ONLY when the DECLARED key name exists AND both secrets are bound", () => {
    expect(
      turnExists(
        RESOURCE,
        existingState(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], [["party-app-turn", "u1"]])
      )
    ).toBe(true);
  });

  it("bound secrets from a DIFFERENTLY-named (hand-created) key do NOT satisfy the declaration — the next deploy converges", () => {
    expect(
      turnExists(
        RESOURCE,
        existingState(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], [["orange-leaf-4f9c", "u9"]])
      )
    ).toBe(false);
  });

  it("a same-name key without bound secrets is a torn leftover → missing (secret unrecoverable)", () => {
    expect(turnExists(RESOURCE, existingState(["TURN_KEY_ID"], [["party-app-turn", "u1"]]))).toBe(
      false
    );
    expect(turnExists(RESOURCE, existingState([], [["party-app-turn", "u1"]]))).toBe(false);
    expect(
      turnExists(RESOURCE, {
        workerSecrets: null,
        keysByName: new Map([["party-app-turn", "u1"]]),
        keysListable: true,
        mintOk: null
      })
    ).toBe(false);
  });

  it("FALLBACK: when the key listing is unavailable (no Calls read), bound secrets alone decide", () => {
    expect(
      turnExists(RESOURCE, existingState(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], [], false))
    ).toBe(true);
    expect(turnExists(RESOURCE, existingState(["TURN_KEY_ID"], [], false))).toBe(false);
  });
});

describe("provisionTurn (standard provision phase)", () => {
  it("creates the key and yields uid + the once-returned credentials for the post-deploy bind", async () => {
    const { deps, calls } = cfApi({ create: { uid: "key-uid", key: "key-secret" } });

    const outcome = await provisionTurn(
      RESOURCE,
      { workerSecrets: new Set(), keysByName: new Map(), keysListable: true, mintOk: null },
      deps
    );

    expect(outcome).toEqual({
      id: "key-uid",
      secrets: { TURN_KEY_ID: "key-uid", TURN_KEY_API_TOKEN: "key-secret" }
    });
    const create = calls.find(call => call.method === "POST");
    expect(create?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-42/calls/turn_keys"
    );
    expect(create?.body).toEqual({ name: "party-app-turn" });
  });

  it("deletes a stale same-name key first (its secret is unrecoverable — keys never accumulate)", async () => {
    const { deps, calls } = cfApi({ create: { uid: "new-uid", key: "new-secret" } });

    await provisionTurn(
      RESOURCE,
      {
        workerSecrets: new Set(),
        keysByName: new Map([["party-app-turn", "stale-uid"]]),
        keysListable: true,
        mintOk: null
      },
      deps
    );

    const del = calls.find(call => call.method === "DELETE");
    expect(del?.url).toContain("/calls/turn_keys/stale-uid");
    expect(calls.findIndex(c => c.method === "DELETE")).toBeLessThan(
      calls.findIndex(c => c.method === "POST")
    );
  });

  it("throws PER-STEP with the HTTP status on failure (create turn_keys → 403)", async () => {
    const { deps } = cfApi({ create: "forbidden" });

    await expect(
      provisionTurn(
        RESOURCE,
        { workerSecrets: new Set(), keysByName: new Map(), keysListable: true, mintOk: null },
        deps
      )
    ).rejects.toThrow(/create turn_keys → HTTP 403 \(lacks permission\)/);
  });

  it("throws on a malformed create response (no uid/key)", async () => {
    const { deps } = cfApi({ create: { uid: "id-only" } });

    await expect(
      provisionTurn(
        RESOURCE,
        { workerSecrets: new Set(), keysByName: new Map(), keysListable: true, mintOk: null },
        deps
      )
    ).rejects.toThrow(/malformed response/);
  });
});

describe("bindTurnSecrets (post-deploy bind)", () => {
  it("PUTs each secret onto the deployed script", async () => {
    const { deps, calls } = cfApi({ put: "ok" });

    await bindTurnSecrets("party-app", { TURN_KEY_ID: "u", TURN_KEY_API_TOKEN: "s" }, deps);

    const puts = calls.filter(call => call.method === "PUT");
    expect(puts.map(call => call.body)).toEqual([
      { name: "TURN_KEY_ID", text: "u", type: "secret_text" },
      { name: "TURN_KEY_API_TOKEN", text: "s", type: "secret_text" }
    ]);
    expect(puts.every(call => call.url.includes("/workers/scripts/party-app/secrets"))).toBe(true);
  });

  it("throws per-secret with the step label on failure", async () => {
    const { deps } = cfApi({ put: "fail" });

    await expect(bindTurnSecrets("party-app", { TURN_KEY_ID: "u" }, deps)).rejects.toThrow(
      /bind secret TURN_KEY_ID → HTTP 500/
    );
  });
});

describe("functional verification (verifyPath — needs no Calls scope)", () => {
  it("a live mint marks mintOk true, and turnExists honors the fallback with it", async () => {
    const { deps, calls } = cfApi({
      secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"],
      keys: "forbidden",
      mint: "ok"
    });

    const existing = await fetchTurnExisting(deps, "party-app", "/api/ice");

    expect(existing.mintOk).toBe(true);
    expect(calls.some(call => call.url === "https://party-app.acme.workers.dev/api/ice")).toBe(
      true
    );
    expect(turnExists(RESOURCE, existing)).toBe(true);
  });

  it("a DEAD key (502 mint) is DECISIVE: mintOk false → missing, even with secrets bound", async () => {
    const { deps } = cfApi({
      secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"],
      keys: "forbidden",
      mint: "dead"
    });

    const existing = await fetchTurnExisting(deps, "party-app", "/api/ice");

    expect(existing.mintOk).toBe(false);
    expect(turnExists(RESOURCE, existing)).toBe(false); // → the deploy converges (recreate)
  });

  it("unverifiable cases resolve mintOk null and are never punished (404 endpoint, network error, disabled)", async () => {
    const notEndpoint = await fetchTurnExisting(
      cfApi({
        secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"],
        keys: "forbidden",
        mint: "not-an-endpoint"
      }).deps,
      "party-app",
      "/api/ice"
    );
    expect(notEndpoint.mintOk).toBeNull();
    expect(turnExists(RESOURCE, notEndpoint)).toBe(true); // falls back to bound secrets

    const network = await fetchTurnExisting(
      cfApi({ secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], keys: "forbidden", mint: "network" })
        .deps,
      "party-app",
      "/api/ice"
    );
    expect(network.mintOk).toBeNull();

    const disabled = await fetchTurnExisting(
      cfApi({ secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], keys: "forbidden" }).deps,
      "party-app",
      false
    );
    expect(disabled.mintOk).toBeNull();
  });

  it("no prior deploy (script missing) skips verification entirely", async () => {
    const { deps, calls } = cfApi({ secrets: "missing-script", keys: "forbidden", mint: "ok" });

    const existing = await fetchTurnExisting(deps, "party-app", "/api/ice");

    expect(existing.mintOk).toBeNull();
    expect(calls.some(call => call.url.includes(".workers.dev"))).toBe(false);
  });
});

describe("escape hatch — env-provided key pair (.env.local)", () => {
  const PAIR = { keyId: "env-key-uid", apiToken: "env-key-secret" };

  it("validates the pair by ACTUALLY MINTING against rtc.live (its own confirmation)", async () => {
    const { deps, calls } = cfApi({ secrets: [], keys: "forbidden", envMint: "ok" });

    const existing = await fetchTurnExisting(deps, "party-app", false, PAIR);

    expect(existing.envKey).toEqual({ ...PAIR, mintOk: true });
    const mintCall = calls.find(call => call.url.includes("rtc.live.cloudflare.com"));
    expect(mintCall?.url).toContain("/turn/keys/env-key-uid/credentials/generate");
  });

  it("a rejected pair validates false; a network failure stays unverifiable (null)", async () => {
    const rejected = await fetchTurnExisting(
      cfApi({ secrets: [], keys: "forbidden", envMint: "rejected" }).deps,
      "party-app",
      false,
      PAIR
    );
    expect(rejected.envKey?.mintOk).toBe(false);

    const network = await fetchTurnExisting(
      cfApi({ secrets: [], keys: "forbidden", envMint: "network" }).deps,
      "party-app",
      false,
      PAIR
    );
    expect(network.envKey?.mintOk).toBeNull();
  });

  it("env mode: exists ONLY when the deployed endpoint mints live; else missing → re-bind converges", () => {
    const base = existingState(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"], [], false);
    const envKey = { ...PAIR, mintOk: true as boolean | null };

    expect(turnExists(RESOURCE, { ...base, mintOk: true, envKey })).toBe(true);
    expect(turnExists(RESOURCE, { ...base, mintOk: null, envKey })).toBe(false); // unverified → converge
    expect(turnExists(RESOURCE, { ...base, mintOk: false, envKey })).toBe(false); // dead → converge
    expect(turnExists(RESOURCE, { ...existingState([], [], false), mintOk: null, envKey })).toBe(
      false
    ); // unbound → converge
  });

  it("provision adopts the env pair — NO Cloudflare account API calls, no uid (teardown never deletes a user key)", async () => {
    const { deps, calls } = cfApi({});
    const existing = {
      ...existingState([], [], false),
      envKey: { ...PAIR, mintOk: true as boolean | null }
    };

    const outcome = await provisionTurn(RESOURCE, existing, deps);

    expect(outcome).toEqual({
      secrets: { TURN_KEY_ID: "env-key-uid", TURN_KEY_API_TOKEN: "env-key-secret" }
    });
    expect(outcome.id).toBeUndefined();
    expect(calls.filter(call => call.url.includes("api.cloudflare.com"))).toEqual([]);
  });

  it("a pair that failed its mint throws the precise env error (→ degraded warning)", async () => {
    const { deps } = cfApi({});
    const existing = {
      ...existingState([], [], false),
      envKey: { ...PAIR, mintOk: false as boolean | null }
    };

    await expect(provisionTurn(RESOURCE, existing, deps)).rejects.toThrow(
      /env TURN credentials rejected — TURN_KEY_ID\/TURN_KEY_API_TOKEN in \.env\.local failed a live mint/
    );
  });
});

describe("deleteTurnKey (teardown)", () => {
  it("deletes by uid", async () => {
    const { deps, calls } = cfApi({ del: "ok" });

    await deleteTurnKey("key-uid", deps);

    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/calls/turn_keys/key-uid");
  });

  it("throws with the status on failure", async () => {
    const { deps } = cfApi({ del: "fail" });
    await expect(deleteTurnKey("key-uid", deps)).rejects.toThrow(/delete turn_keys → HTTP 500/);
  });
});

describe("turnInstruction", () => {
  it("carries both the automatic (scope) and manual (secret names) paths in one line", () => {
    const line = turnInstruction(RESOURCE);
    expect(line).toContain("Cloudflare Calls: Edit");
    expect(line).toContain("wrangler secret put TURN_KEY_ID");
    expect(line).toContain("wrangler secret put TURN_KEY_API_TOKEN");
  });
});
