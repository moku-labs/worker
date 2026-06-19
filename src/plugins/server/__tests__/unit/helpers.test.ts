import { describe, expect, expectTypeOf, it } from "vitest";

import { endpoint } from "../../helpers";
import type { Endpoint, EndpointHandler, PathParams } from "../../types";

// ─── Unit tests: endpoint() pure builder ─────────────────────────────────────

const noopHandler: EndpointHandler = () => new Response("ok");

/** Handler used to verify that handler references are preserved. */
const distinctHandler: EndpointHandler = () => new Response("x");

/** Sync handler for type assertion test. */
const syncHandler: EndpointHandler = () => new Response("sync");

/** Async handler for type assertion test. */
const asyncHandler: EndpointHandler = async () => new Response("async");

describe("endpoint() pure builder", () => {
  // ─── Per-verb production ─────────────────────────────────────────────────

  it("GET — returns an Endpoint with method GET", () => {
    const e = endpoint("/test").get(noopHandler);
    expect(e.method).toBe("GET");
    expect(e.path).toBe("/test");
    expect(e.handler).toBe(noopHandler);
  });

  it("POST — returns an Endpoint with method POST", () => {
    const e = endpoint("/test").post(noopHandler);
    expect(e.method).toBe("POST");
  });

  it("PUT — returns an Endpoint with method PUT", () => {
    const e = endpoint("/test").put(noopHandler);
    expect(e.method).toBe("PUT");
  });

  it("PATCH — returns an Endpoint with method PATCH", () => {
    const e = endpoint("/test").patch(noopHandler);
    expect(e.method).toBe("PATCH");
  });

  it("DELETE — returns an Endpoint with method DELETE", () => {
    const e = endpoint("/test").delete(noopHandler);
    expect(e.method).toBe("DELETE");
  });

  it("HEAD — returns an Endpoint with method HEAD", () => {
    const e = endpoint("/test").head(noopHandler);
    expect(e.method).toBe("HEAD");
  });

  it("OPTIONS — returns an Endpoint with method OPTIONS", () => {
    const e = endpoint("/test").options(noopHandler);
    expect(e.method).toBe("OPTIONS");
  });

  it("ALL — returns an Endpoint with method ALL (not a 'get' sentinel)", () => {
    const e = endpoint("/test").all(noopHandler);
    expect(e.method).toBe("ALL");
  });

  // ─── Purity (no side effects, no shared state) ───────────────────────────

  it("builder is pure — calling on the same path twice yields independent objects", () => {
    const builder = endpoint("/x");
    const e1 = builder.get(noopHandler);
    const e2 = builder.post(noopHandler);
    expect(e1).not.toBe(e2);
    expect(e1.method).toBe("GET");
    expect(e2.method).toBe("POST");
  });

  it("distinct paths produce distinct endpoints — no shared reference", () => {
    const e1 = endpoint("/a").get(noopHandler);
    const e2 = endpoint("/b").get(noopHandler);
    expect(e1.path).toBe("/a");
    expect(e2.path).toBe("/b");
    expect(e1).not.toBe(e2);
  });

  it("stores the handler reference — no copying or wrapping", () => {
    const e = endpoint("/h").get(distinctHandler);
    expect(e.handler).toBe(distinctHandler);
  });

  // ─── Type-level assertions ───────────────────────────────────────────────

  it("endpoint().get(h) return type is Endpoint", () => {
    const e = endpoint("/typed").get(noopHandler);
    expectTypeOf(e).toMatchTypeOf<Endpoint>();
  });

  it("endpoint().all(h) return type is Endpoint", () => {
    const e = endpoint("/all").all(noopHandler);
    expectTypeOf(e).toMatchTypeOf<Endpoint>();
    // 'method' literal is a subset of Method — not just string
    expectTypeOf(e.method).toMatchTypeOf<
      "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL"
    >();
  });

  it("EndpointHandler returns Response | Promise<Response>", () => {
    expectTypeOf(syncHandler).toMatchTypeOf<EndpointHandler>();
    expectTypeOf(asyncHandler).toMatchTypeOf<EndpointHandler>();
  });
});

// ─── Typed path params (PathParams<Path>) ────────────────────────────────────
//
// The reported bug: a required `{id}` surfaced on `ctx.params` as
// `string | undefined`, forcing handlers to write `ctx.params.id ?? ""`. The
// path template now flows into `params`: required `{name}` → `string`, optional
// `{name:?}` → `string | undefined`.

describe("PathParams<Path> — path-template → params shape", () => {
  it("required {id} resolves to { id: string } — never string | undefined", () => {
    expectTypeOf<PathParams<"/api/boards/{id}/cards">>().toEqualTypeOf<{ id: string }>();
  });

  it("optional {lang:?} resolves to an optional { lang?: string }", () => {
    expectTypeOf<PathParams<"/api/data/{lang:?}">>().toEqualTypeOf<{ lang?: string }>();
  });

  it("multiple required params each resolve to string", () => {
    expectTypeOf<PathParams<"/users/{userId}/posts/{postId}">>().toEqualTypeOf<{
      userId: string;
      postId: string;
    }>();
  });

  it("mixed optional + required params resolve together", () => {
    expectTypeOf<PathParams<"/{lang:?}/{slug}">>().toEqualTypeOf<{ slug: string; lang?: string }>();
  });

  it("a param-less path exposes no param keys", () => {
    expectTypeOf<keyof PathParams<"/health">>().toEqualTypeOf<never>();
  });

  it("a non-literal string path widens to Record<string, string | undefined>", () => {
    expectTypeOf<PathParams<string>>().toEqualTypeOf<Record<string, string | undefined>>();
  });
});

describe("endpoint() threads the path type into the handler", () => {
  it("required {id} — builder hands the handler ctx.params.id: string (the fix)", () => {
    expectTypeOf(endpoint("/api/boards/{id}/cards").post)
      .parameter(0)
      .toEqualTypeOf<EndpointHandler<{ id: string }>>();
  });

  it("optional {lang:?} — builder hands the handler ctx.params.lang?: string", () => {
    expectTypeOf(endpoint("/api/data/{lang:?}").get)
      .parameter(0)
      .toEqualTypeOf<EndpointHandler<{ lang?: string }>>();
  });

  it("a runtime-built (non-literal) path keeps the permissive handler type", () => {
    const dynamicPath: string = "/api/dynamic";
    expectTypeOf(endpoint(dynamicPath).get)
      .parameter(0)
      .toEqualTypeOf<EndpointHandler<Record<string, string | undefined>>>();
  });
});
