import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { WorkerEnv } from "../../../../config";
import { coreConfig, createCore } from "../../../../config";
import { bindingsPlugin } from "../../../bindings";
import { endpoint } from "../../helpers";
import { serverPlugin } from "../../index";
import type { Endpoint, EndpointHandler } from "../../types";

/** Simple handler used for type-level test (hoisted — no closure). */
const typeTestHandler: EndpointHandler = () => new Response("ok");

// ─── Integration tests: full server plugin via createApp ─────────────────────
//
// We use `createCore(coreConfig, { plugins: [...] })` to produce a fresh
// `createApp` that contains ONLY the plugins specified, avoiding the duplicate-
// name error that would occur if we used the top-level framework `createApp`
// (which already includes bindingsPlugin + serverPlugin as defaults).

/**
 * Create a fresh `createApp` with exactly bindingsPlugin + serverPlugin.
 * This models the spec's Layer-3 consumer perspective (spec/15 §4, SB2).
 */
const makeCreateApp = () =>
  createCore(coreConfig, { plugins: [bindingsPlugin, serverPlugin] }).createApp;

/** Minimal stub for ExecutionContext. */
const makeExec = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn()
  }) as unknown as ExecutionContext;

/** Basic test-app factory. */
const createTestApp = (additionalEndpoints: Endpoint[] = []) => {
  const createApp = makeCreateApp();
  return createApp({
    pluginConfigs: {
      server: {
        endpoints: [
          endpoint("/health").get(() => new Response("ok", { status: 200 })),
          endpoint("/api/data/{lang?}").get(({ params }) =>
            Response.json({ lang: params.lang ?? "en" })
          ),
          endpoint("/users/{userId}").get(
            ({ params }) => new Response(`user=${params.userId}`, { status: 200 })
          ),
          ...additionalEndpoints
        ]
      }
    }
  });
};

describe("server plugin (integration)", () => {
  // ─── Dependency validation ──────────────────────────────────────────────

  it("throws when bindingsPlugin is omitted from plugins (unresolved dependency)", () => {
    // A createApp that has ONLY serverPlugin — bindings is missing
    const { createApp: createAppNoBindings } = createCore(coreConfig, {
      plugins: [serverPlugin]
    });
    expect(() => createAppNoBindings({ pluginConfigs: { server: { endpoints: [] } } })).toThrow();
  });

  it("does NOT throw when bindingsPlugin is included", () => {
    expect(() => createTestApp()).not.toThrow();
  });

  // ─── onInit compilation ──────────────────────────────────────────────────

  it("onInit compiles the table — server api is accessible after createApp", () => {
    const app = createTestApp();
    expect(app.server).toBeDefined();
    expect(typeof app.server.handle).toBe("function");
  });

  it("compiled table routes a GET request to /health", async () => {
    const app = createTestApp();
    const res = await app.server.handle(new Request("https://example.com/health"), {}, makeExec());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // ─── Path-param routing ──────────────────────────────────────────────────

  it("routes with required param — extracts userId correctly", async () => {
    const app = createTestApp();
    const res = await app.server.handle(
      new Request("https://example.com/users/42"),
      {},
      makeExec()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("user=42");
  });

  it("routes with optional param present — extracts lang", async () => {
    const app = createTestApp();
    const res = await app.server.handle(
      new Request("https://example.com/api/data/fr"),
      {},
      makeExec()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lang: string };
    expect(body.lang).toBe("fr");
  });

  it("routes with optional param absent — lang falls back to default", async () => {
    const app = createTestApp();
    const res = await app.server.handle(
      new Request("https://example.com/api/data"),
      {},
      makeExec()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lang: string };
    expect(body.lang).toBe("en");
  });

  // ─── 404 for unmatched routes ────────────────────────────────────────────

  it("returns 404 for an unregistered path", async () => {
    const app = createTestApp();
    const res = await app.server.handle(new Request("https://example.com/nope"), {}, makeExec());
    expect(res.status).toBe(404);
  });

  // ─── env access inside handlers (SB4 — stack-threaded, never in state) ──

  it("handler reads env from RequestContext", async () => {
    const createApp = makeCreateApp();
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/env-check").get(
              ({ env }) => new Response(String(env.REGION), { status: 200 })
            )
          ]
        }
      }
    });
    const env: WorkerEnv = { REGION: "eu-west-1" };
    const res = await app.server.handle(
      new Request("https://example.com/env-check"),
      env,
      makeExec()
    );
    expect(await res.text()).toBe("eu-west-1");
  });

  // ─── SB4 — concurrent env isolation ─────────────────────────────────────

  it("two concurrent handle calls observe their own env objects — no bleed", async () => {
    const observed: WorkerEnv[] = [];
    const createApp = makeCreateApp();
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/spy").get(async ({ env }) => {
              await Promise.resolve(); // yield to let both requests interleave
              observed.push(env);
              return new Response("ok");
            })
          ]
        }
      }
    });

    const env1: WorkerEnv = { REQUEST_ID: "req-1" };
    const env2: WorkerEnv = { REQUEST_ID: "req-2" };

    await Promise.all([
      app.server.handle(new Request("https://example.com/spy"), env1, makeExec()),
      app.server.handle(new Request("https://example.com/spy"), env2, makeExec())
    ]);

    expect(observed).toHaveLength(2);
    const ids = observed.map(e => e.REQUEST_ID);
    expect(ids).toContain("req-1");
    expect(ids).toContain("req-2");
    // The two env objects are distinct references — no bleed
    expect(observed[0]).not.toBe(observed[1]);
  });

  // ─── require() threaded to handlers ─────────────────────────────────────

  it("handler can call require(bindingsPlugin) from RequestContext", async () => {
    let bindingsApiRef: unknown;
    const createApp = makeCreateApp();
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/req-test").get(({ require: req }) => {
              bindingsApiRef = req(bindingsPlugin);
              return new Response("ok");
            })
          ]
        }
      }
    });
    await app.server.handle(new Request("https://example.com/req-test"), {}, makeExec());
    expect(bindingsApiRef).toBeDefined();
    expect(typeof (bindingsApiRef as { require?: unknown }).require).toBe("function");
  });

  // ─── scheduled (cron dispatch) ───────────────────────────────────────────

  it("scheduled — does nothing when no cron endpoint matches", async () => {
    const app = createTestApp();
    const controller = {
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
      noRetry: vi.fn()
    } as unknown as ScheduledController;
    await expect(app.server.scheduled(controller, {}, makeExec())).resolves.toBeUndefined();
  });

  it("scheduled — awaits the matched cron handler end-to-end", async () => {
    let cronCalled = false;
    const cronExpr = "0 0 * * *";

    const createApp = makeCreateApp();
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint(cronExpr).all(async () => {
              await Promise.resolve();
              cronCalled = true;
              return new Response("cron");
            })
          ]
        }
      }
    });

    const controller = {
      cron: cronExpr,
      scheduledTime: Date.now(),
      noRetry: vi.fn()
    } as unknown as ScheduledController;

    await app.server.scheduled(controller, {}, makeExec());
    expect(cronCalled).toBe(true);
  });

  // ─── Type-level tests ─────────────────────────────────────────────────────

  it("app.server.handle has correct signature", () => {
    const app = createTestApp();
    expectTypeOf(app.server.handle).toMatchTypeOf<
      (req: Request, env: WorkerEnv, exec: ExecutionContext) => Promise<Response>
    >();
  });

  it("app.server.scheduled has correct signature", () => {
    const app = createTestApp();
    expectTypeOf(app.server.scheduled).toMatchTypeOf<
      (c: ScheduledController, env: WorkerEnv, exec: ExecutionContext) => Promise<void>
    >();
  });

  it("endpoint('/x').get(h) returns an Endpoint", () => {
    const e = endpoint("/x").get(typeTestHandler);
    expectTypeOf(e).toMatchTypeOf<{
      path: string;
      method: string;
      handler: typeof typeTestHandler;
    }>();
  });

  it("RequestContext.params is Record<string, string | undefined>", async () => {
    let capturedParams: Record<string, string | undefined> | undefined;
    const createApp = makeCreateApp();
    const app = createApp({
      pluginConfigs: {
        server: {
          endpoints: [
            endpoint("/p/{id}").get(({ params }) => {
              capturedParams = params;
              return new Response("ok");
            })
          ]
        }
      }
    });
    await app.server.handle(new Request("https://example.com/p/1"), {}, makeExec());
    expect(capturedParams).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: capturedParams is asserted defined on the line above
    expectTypeOf(capturedParams!).toMatchTypeOf<Record<string, string | undefined>>();
  });
});
