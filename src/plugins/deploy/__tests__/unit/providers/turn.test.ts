/**
 * Unit tests for the TURN-key provisioning adapter (`ensureTurnKey`): idempotent skip when both
 * secrets are bound, the create-key → bind-secrets happy path over the Cloudflare REST API, and
 * every fail-open rung (no token / scope-rejected create / malformed body / thrown fetch / a failed
 * secret bind) — each must `note()` exactly ONE actionable line, resolve "degraded", and NEVER
 * throw (the deploy continues).
 */
import { describe, expect, it } from "vitest";
import { ensureTurnKey, type TurnDeps } from "../../../providers/turn";
import type { ResourceManifest } from "../../../types";

/** The default-named turn resource under test. */
const RESOURCE: Extract<ResourceManifest, { kind: "turn" }> = {
  kind: "turn",
  name: "party-app-turn",
  keyIdBinding: "TURN_KEY_ID",
  apiTokenBinding: "TURN_KEY_API_TOKEN"
};

/** One recorded REST call. */
type Call = { method: string; url: string; body?: unknown };

/**
 * A scripted Cloudflare REST double: records calls, answers by URL/method, and returns the standard
 * `{ success, result }` envelope.
 */
function cfApi(script: {
  secrets?: string[] | "fail";
  create?: { uid?: string; key?: string } | "forbidden" | "throw";
  put?: "ok" | "fail";
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url: String(url), body });

    if (String(url).includes("/workers/scripts/") && method === "GET") {
      if (script.secrets === "fail") return Response.json({ success: false }, { status: 403 });
      const names = (script.secrets ?? []).map(name => ({ name, type: "secret_text" }));
      return Response.json({ success: true, result: names });
    }
    if (String(url).includes("/calls/turn_keys")) {
      if (script.create === "throw") throw new Error("network down");
      if (script.create === "forbidden") {
        return Response.json(
          { success: false, errors: [{ message: "lacks permission" }] },
          { status: 403 }
        );
      }
      return Response.json({ success: true, result: script.create ?? {} }, { status: 201 });
    }
    if (String(url).includes("/workers/scripts/") && method === "PUT") {
      if (script.put === "fail") return Response.json({ success: false }, { status: 500 });
      return Response.json({ success: true, result: { name: body?.name } });
    }
    throw new Error(`unexpected call: ${method} ${String(url)}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Build the deps bundle over a scripted API + a captured note sink. */
function makeDeps(
  fetchImpl: typeof fetch,
  apiToken: string | undefined = "cf-token"
): { deps: TurnDeps; notes: string[] } {
  const notes: string[] = [];
  return {
    deps: {
      accountId: "acc-42",
      scriptName: "party-app",
      apiToken,
      note: message => {
        notes.push(message);
      },
      fetchImpl
    },
    notes
  };
}

describe("ensureTurnKey", () => {
  it("skips read-only when both secrets are already bound (idempotent redeploys)", async () => {
    const { fetchImpl, calls } = cfApi({ secrets: ["TURN_KEY_ID", "TURN_KEY_API_TOKEN", "OTHER"] });
    const { deps, notes } = makeDeps(fetchImpl);

    expect(await ensureTurnKey(RESOURCE, deps)).toBe("exists");
    expect(calls).toHaveLength(1); // the secrets listing only — no create, no puts
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("already provisioned");
  });

  it("creates the key against the account and binds BOTH secrets (the happy path)", async () => {
    const { fetchImpl, calls } = cfApi({
      secrets: [],
      create: { uid: "key-uid", key: "key-secret" }
    });
    const { deps, notes } = makeDeps(fetchImpl);

    expect(await ensureTurnKey(RESOURCE, deps)).toBe("provisioned");

    const create = calls.find(call => call.url.includes("/calls/turn_keys"));
    expect(create?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-42/calls/turn_keys"
    );
    expect(create?.body).toEqual({ name: "party-app-turn" });

    const puts = calls.filter(call => call.method === "PUT");
    expect(puts.map(call => call.body)).toEqual([
      { name: "TURN_KEY_ID", text: "key-uid", type: "secret_text" },
      { name: "TURN_KEY_API_TOKEN", text: "key-secret", type: "secret_text" }
    ]);
    expect(puts.every(call => call.url.includes("/workers/scripts/party-app/secrets"))).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("provisioned");
  });

  it("a half-bound pair is re-ensured with a fresh key (a torn earlier run heals)", async () => {
    const { fetchImpl, calls } = cfApi({
      secrets: ["TURN_KEY_ID"],
      create: { uid: "new-uid", key: "new-secret" }
    });
    const { deps } = makeDeps(fetchImpl);

    expect(await ensureTurnKey(RESOURCE, deps)).toBe("provisioned");
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(2);
  });

  it("no API token → one instruction line, zero API calls, degraded (fail-open)", async () => {
    const { fetchImpl, calls } = cfApi({});
    // Empty string = the "unset env var" shape the pipeline hands through (a default-parameter
    // `undefined` would silently re-default to the test token).
    const { deps, notes } = makeDeps(fetchImpl, "");

    expect(await ensureTurnKey(RESOURCE, deps)).toBe("degraded");
    expect(calls).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Calls: Edit");
    expect(notes[0]).toContain("wrangler secret put TURN_KEY_ID");
  });

  it("scope-rejected create, malformed body, thrown fetch, failed listing — each degrades with ONE line", async () => {
    const cases = [
      cfApi({ secrets: [], create: "forbidden" }),
      cfApi({ secrets: [], create: { uid: "id-only" } }),
      cfApi({ secrets: [], create: "throw" }),
      cfApi({ secrets: "fail" })
    ];

    for (const { fetchImpl } of cases) {
      const { deps, notes } = makeDeps(fetchImpl);
      await expect(ensureTurnKey(RESOURCE, deps)).resolves.toBe("degraded");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("not provisioned");
    }
  });

  it("a failed secret bind degrades (the fresh-key re-ensure covers the tear on the next deploy)", async () => {
    const { fetchImpl } = cfApi({
      secrets: [],
      create: { uid: "key-uid", key: "key-secret" },
      put: "fail"
    });
    const { deps, notes } = makeDeps(fetchImpl);

    expect(await ensureTurnKey(RESOURCE, deps)).toBe("degraded");
    expect(notes).toHaveLength(1);
  });

  it("binds under renamed secret bindings when the instance overrides them", async () => {
    const resource = { ...RESOURCE, keyIdBinding: "MY_KEY", apiTokenBinding: "MY_TOKEN" };
    const { fetchImpl, calls } = cfApi({
      secrets: [],
      create: { uid: "key-uid", key: "key-secret" }
    });
    const { deps } = makeDeps(fetchImpl);

    await ensureTurnKey(resource, deps);
    expect(calls.filter(call => call.method === "PUT").map(call => call.body)).toEqual([
      { name: "MY_KEY", text: "key-uid", type: "secret_text" },
      { name: "MY_TOKEN", text: "key-secret", type: "secret_text" }
    ]);
  });
});
