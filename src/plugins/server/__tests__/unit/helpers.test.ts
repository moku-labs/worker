import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { GuardedEndpointFactory } from "../../helpers";
import { endpoint } from "../../helpers";
import type {
  Endpoint,
  EndpointGuard,
  EndpointHandler,
  PathParams,
  RequestContext
} from "../../types";

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
    expectTypeOf(e).toExtend<Endpoint>();
  });

  it("endpoint().all(h) return type is Endpoint", () => {
    const e = endpoint("/all").all(noopHandler);
    expectTypeOf(e).toExtend<Endpoint>();
    // 'method' literal is a subset of Method — not just string
    expectTypeOf(e.method).toExtend<
      "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL"
    >();
  });

  it("EndpointHandler returns Response | Promise<Response>", () => {
    expectTypeOf(syncHandler).toExtend<EndpointHandler>();
    expectTypeOf(asyncHandler).toExtend<EndpointHandler>();
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

// ─── endpoint.new() — chainable guard factory ────────────────────────────────

/** Minimal per-request context for invoking a built handler directly. */
const makeCtx = (request: Request = new Request("https://example.com/x")): RequestContext => ({
  request,
  env: {},
  exec: {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined
  } as unknown as ExecutionContext,
  params: {},
  url: new URL(request.url),
  require: (() => undefined) as unknown as RequestContext["require"],
  has: () => false
});

/** Guard that allows the request through (returns nothing). */
const allow: EndpointGuard = () => undefined;

/** Guard that rejects with a 401 (returns a Response). */
const reject: EndpointGuard = () => new Response("nope", { status: 401 });

/** Async guard that rejects with a 401. */
const asyncReject: EndpointGuard = async () => new Response("async-no", { status: 401 });

/** Async guard that allows the request through. */
const asyncAllow: EndpointGuard = async () => undefined;

/** Guard that throws synchronously. */
const boom: EndpointGuard = () => {
  throw new Error("boom");
};

describe("endpoint.new() — guard chain", () => {
  // ─── Runtime behaviour ───────────────────────────────────────────────────

  it("no guards — stores the handler verbatim (base is byte-identical)", () => {
    const e = endpoint("/x").get(noopHandler);
    expect(e.handler).toBe(noopHandler);
  });

  it("allow (void) — the handler runs", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const e = endpoint.new(allow)("/x").get(handler);
    const res = await e.handler(makeCtx());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("reject (Response) — short-circuits; the handler never runs", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const e = endpoint.new(reject)("/x").get(handler);
    const res = await e.handler(makeCtx());
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("runs guards in registration order; the first Response wins", async () => {
    const calls: string[] = [];
    const g1: EndpointGuard = () => {
      calls.push("g1");
    };
    const g2: EndpointGuard = () => {
      calls.push("g2");
      return new Response("stop", { status: 403 });
    };
    const g3: EndpointGuard = () => {
      calls.push("g3");
    };
    const handler = vi.fn(() => new Response("ok"));
    const e = endpoint.new(g1).new(g2).new(g3)("/x").get(handler);
    const res = await e.handler(makeCtx());
    expect(calls).toEqual(["g1", "g2"]); // g3 is skipped after g2 short-circuits
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  it("awaits async guards — async reject short-circuits", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const e = endpoint.new(asyncReject)("/x").get(handler);
    const res = await e.handler(makeCtx());
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("awaits async guards — async allow continues to the handler", async () => {
    const handler = vi.fn(() => new Response("ok"));
    const e = endpoint.new(asyncAllow)("/x").get(handler);
    await e.handler(makeCtx());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a guard that throws propagates (no swallowing)", async () => {
    const e = endpoint.new(boom)("/x").get(noopHandler);
    await expect(e.handler(makeCtx())).rejects.toThrow("boom");
  });

  it(".new is immutable — derived factories branch independently", async () => {
    const calls: string[] = [];
    const gA: EndpointGuard = () => {
      calls.push("A");
    };
    const gB: EndpointGuard = () => {
      calls.push("B");
    };
    const base = endpoint.new(gA);
    const branch = base.new(gB);

    await base("/x").get(noopHandler).handler(makeCtx());
    expect(calls).toEqual(["A"]); // base runs only gA

    calls.length = 0;
    await branch("/x").get(noopHandler).handler(makeCtx());
    expect(calls).toEqual(["A", "B"]); // branch runs gA then gB
  });

  it("guards receive the same ctx object the handler does", async () => {
    let guardCtx: RequestContext | undefined;
    let handlerCtx: RequestContext | undefined;
    const spyGuard: EndpointGuard = ctx => {
      guardCtx = ctx;
    };
    const e = endpoint
      .new(spyGuard)("/x")
      .get(ctx => {
        handlerCtx = ctx;
        return new Response("ok");
      });
    const ctx = makeCtx();
    await e.handler(ctx);
    expect(guardCtx).toBe(ctx);
    expect(handlerCtx).toBe(ctx);
  });

  // ─── Type-level assertions ───────────────────────────────────────────────

  it("endpoint.new(g) is callable and returns a chainable factory", () => {
    expectTypeOf(endpoint.new).toBeFunction();
    expectTypeOf(endpoint.new(allow)).toExtend<GuardedEndpointFactory>();
    expectTypeOf(endpoint.new(allow).new).toBeFunction();
  });

  it("a guarded factory preserves the path-typed handler param (the fix survives)", () => {
    expectTypeOf(endpoint.new(allow)("/api/boards/{id}/cards").post)
      .parameter(0)
      .toEqualTypeOf<EndpointHandler<{ id: string }>>();
  });
});
