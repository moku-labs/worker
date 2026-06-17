import { describe, expect, expectTypeOf, it } from "vitest";

import { endpoint } from "../../helpers";
import type { Endpoint, EndpointHandler } from "../../types";

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
