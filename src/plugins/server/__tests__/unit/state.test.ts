import { describe, expect, expectTypeOf, it } from "vitest";

import { endpoint } from "../../helpers";
import { compileServerState, createServerState } from "../../state";
import type { MatchResult, ServerState } from "../../types";

// ─── Unit tests: createServerState + match() ──────────────────────────────────

const noop = () => new Response("ok");

describe("createServerState", () => {
  // ─── Initial state ─────────────────────────────────────────────────────

  it("starts with compiled = false", () => {
    const s = createServerState([]);
    expect(s.compiled).toBe(false);
  });

  it("copies endpoints into the table — table length equals input length", () => {
    const endpoints = [endpoint("/a").get(noop), endpoint("/b").post(noop)];
    const s = createServerState(endpoints);
    expect(s.table).toHaveLength(2);
  });

  it("does not mutate the input array (frozen config guard)", () => {
    const endpoints = Object.freeze([endpoint("/a").get(noop)]);
    const s = createServerState([...endpoints]);
    // table is a NEW array — modifying it doesn't touch the source
    s.table.push({
      endpoint: endpoint("/z").get(noop),
      segments: [],
      specificity: 0
    });
    expect(endpoints).toHaveLength(1);
  });

  it("table entries carry correct endpoint references", () => {
    const e = endpoint("/api").get(noop);
    const s = createServerState([e]);
    const first = s.table[0];
    expect(first).toBeDefined();
    expect(first?.endpoint).toBe(e);
  });

  // ─── Specificity scoring ────────────────────────────────────────────────

  it("literal segment scores higher than required param", () => {
    const lit = endpoint("/api/users").get(noop);
    const par = endpoint("/api/{id}").get(noop);
    const s = createServerState([lit, par]);
    const litEntry = s.table.find(e => e.endpoint === lit);
    const parEntry = s.table.find(e => e.endpoint === par);
    expect(litEntry?.specificity ?? -1).toBeGreaterThan(parEntry?.specificity ?? -2);
  });

  it("required param scores higher than optional param", () => {
    const req = endpoint("/api/{id}").get(noop);
    const opt = endpoint("/api/{id:?}").get(noop);
    const s = createServerState([req, opt]);
    const reqEntry = s.table.find(e => e.endpoint === req);
    const optEntry = s.table.find(e => e.endpoint === opt);
    expect(reqEntry?.specificity ?? -1).toBeGreaterThan(optEntry?.specificity ?? -2);
  });

  // ─── match() — basic routing ────────────────────────────────────────────

  describe("match(method, path)", () => {
    it("returns null when no endpoint matches", () => {
      const s = createServerState([endpoint("/hello").get(noop)]);
      expect(s.match("GET", "/world")).toBeNull();
    });

    it("matches an exact literal path", () => {
      const e = endpoint("/hello").get(noop);
      const s = createServerState([e]);
      const result = s.match("GET", "/hello");
      expect(result).not.toBeNull();
      expect(result?.endpoint).toBe(e);
    });

    it("returns MatchResult type for valid match", () => {
      const s = createServerState([endpoint("/x").get(noop)]);
      const result = s.match("GET", "/x");
      expectTypeOf(result).toMatchTypeOf<MatchResult | null>();
    });

    // ─── Literal beats param ──────────────────────────────────────────────

    it("literal endpoint beats required param endpoint on same-depth path", () => {
      const lit = endpoint("/api/users").get(noop);
      const par = endpoint("/api/{id}").get(noop);
      const s = createServerState([par, lit]); // reverse order to prove sorting
      const result = s.match("GET", "/api/users");
      expect(result?.endpoint).toBe(lit);
    });

    // ─── Required vs optional param ──────────────────────────────────────

    it("extracts required param from path", () => {
      const s = createServerState([endpoint("/users/{id}").get(noop)]);
      const result = s.match("GET", "/users/42");
      expect(result).not.toBeNull();
      expect(result?.params.id).toBe("42");
    });

    it("extracts optional param when present", () => {
      const s = createServerState([endpoint("/api/data/{lang:?}").get(noop)]);
      const result = s.match("GET", "/api/data/en");
      expect(result).not.toBeNull();
      expect(result?.params.lang).toBe("en");
    });

    it("optional param absent — params.x === undefined", () => {
      const s = createServerState([endpoint("/api/data/{lang:?}").get(noop)]);
      const result = s.match("GET", "/api/data");
      expect(result).not.toBeNull();
      expect(result?.params.lang).toBeUndefined();
    });

    it("required param does NOT match absent segment", () => {
      const s = createServerState([endpoint("/users/{id}").get(noop)]);
      const result = s.match("GET", "/users");
      expect(result).toBeNull();
    });

    // ─── Method matching ──────────────────────────────────────────────────

    it("method mismatch returns null", () => {
      const s = createServerState([endpoint("/test").get(noop)]);
      expect(s.match("POST", "/test")).toBeNull();
    });

    it("ALL endpoint matches any verb", () => {
      const e = endpoint("/any").all(noop);
      const s = createServerState([e]);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const result = s.match(method, "/any");
        expect(result).not.toBeNull();
        expect(result?.endpoint).toBe(e);
      }
    });

    it("method-specific endpoint beats ALL endpoint on the same path", () => {
      const specific = endpoint("/route").get(noop);
      const all = endpoint("/route").all(noop);
      const s = createServerState([all, specific]); // reverse to prove
      const result = s.match("GET", "/route");
      expect(result?.endpoint).toBe(specific);
    });

    // ─── Multi-segment paths ──────────────────────────────────────────────

    it("multi-segment literal path matches exactly", () => {
      const e = endpoint("/api/v1/health").get(noop);
      const s = createServerState([e]);
      expect(s.match("GET", "/api/v1/health")).not.toBeNull();
      expect(s.match("GET", "/api/v1")).toBeNull();
      expect(s.match("GET", "/api/v1/health/extra")).toBeNull();
    });

    it("multiple params extracted in order", () => {
      const s = createServerState([endpoint("/users/{userId}/posts/{postId}").get(noop)]);
      const result = s.match("GET", "/users/123/posts/456");
      expect(result?.params.userId).toBe("123");
      expect(result?.params.postId).toBe("456");
    });

    // ─── params type ──────────────────────────────────────────────────────

    it("params is Record<string, string | undefined>", () => {
      const s = createServerState([endpoint("/item/{id}").get(noop)]);
      const result = s.match("GET", "/item/1");
      if (result) {
        expectTypeOf(result.params).toMatchTypeOf<Record<string, string | undefined>>();
      }
    });

    // ─── Compiled flag behaviour ──────────────────────────────────────────

    it("match still works before onInit compilation (uncompiled state)", () => {
      // createServerState itself doesn't compile; the test verifies we pre-sort
      // inside match() OR that the function handles the uncompiled case gracefully
      const lit = endpoint("/a").get(noop);
      const par = endpoint("/{x}").get(noop);
      const s = createServerState([par, lit]); // wrong order
      // After createServerState the table may be in any order,
      // but match MUST still prefer literal over param
      const result = s.match("GET", "/a");
      expect(result?.endpoint).toBe(lit);
    });
  });

  // ─── ServerState type ───────────────────────────────────────────────────

  it("returns a value satisfying the ServerState interface", () => {
    const s = createServerState([]);
    expectTypeOf(s).toMatchTypeOf<ServerState>();
  });
});

// ─── compileServerState — path validation ────────────────────────────────────

describe("compileServerState", () => {
  it("compiles a valid table and sets compiled = true", () => {
    const s = createServerState([endpoint("/api/{id}").get(noop)]);
    expect(() => compileServerState(s)).not.toThrow();
    expect(s.compiled).toBe(true);
  });

  it("accepts the {name:?} optional syntax", () => {
    const s = createServerState([endpoint("/api/data/{lang:?}").get(noop)]);
    expect(() => compileServerState(s)).not.toThrow();
  });

  it("rejects the retired {name?} optional syntax with a {name:?} migration hint", () => {
    // `{id?}` no longer parses as optional — flag it loudly instead of registering
    // a param literally named "id?".
    const s = createServerState([endpoint("/api/{id?}").get(noop)]);
    expect(() => compileServerState(s)).toThrowError(/old optional-param syntax[\s\S]*\{id:\?\}/);
  });

  it("rejects duplicate {param} names in a path", () => {
    const s = createServerState([endpoint("/a/{id}/b/{id}").get(noop)]);
    expect(() => compileServerState(s)).toThrowError(/duplicate param/);
  });

  it("is idempotent — a second call is a no-op once compiled", () => {
    const s = createServerState([endpoint("/api/{id}").get(noop)]);
    compileServerState(s);
    expect(() => compileServerState(s)).not.toThrow();
    expect(s.compiled).toBe(true);
  });
});
