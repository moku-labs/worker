/**
 * @file server plugin — API factory (`handle`, `scheduled`).
 *
 * Builds the `app.server.*` surface the consumer's Worker default export reads.
 * All request-response flow goes through the return value of these methods —
 * never through `emit` (F8; spec/07 §1, §3; spec/11 §2.7).
 *
 * Per-request `env` is allocated on the call stack of `handle`/`scheduled`
 * inside a fresh `RequestContext` and is NEVER stored on state (SB4; spec/08 §6).
 */
import type { WorkerEnv } from "../../config";
import type { Api, RequestContext, ServerCtx } from "./types";

/**
 * Builds the `app.server.*` surface the consumer's Worker default export reads.
 *
 * @param ctx - Plugin context: config, compiled state table, emit, require, has.
 * @returns The server API object with `handle` and `scheduled` methods.
 * @example
 * ```typescript
 * // Wired in index.ts as: api: ctx => createServerApi(ctx)
 * const serverApi = createServerApi(ctx);
 * const response = await serverApi.handle(request, env, exec);
 * ```
 */
export const createServerApi = (ctx: ServerCtx): Api => {
  /**
   * Route one HTTP request and return its `Response` (or 404 Not Found).
   *
   * Allocates a fresh `RequestContext` on the call stack carrying the
   * per-request `env` — never stored on state (SB4). Response flows through
   * the return value, not `emit` (F8; spec/07 §1).
   *
   * @param request - The incoming Cloudflare `Request`.
   * @param env - Per-request Cloudflare bindings; threaded on the stack, never stored.
   * @param exec - `ExecutionContext` for `waitUntil` / `passThroughOnException`.
   * @returns The matched handler's `Response`, or `404 Not Found`.
   * @example
   * ```typescript
   * const res = await serverApi.handle(new Request("https://example.com/"), env, exec);
   * ```
   */
  const handle = async (
    request: Request,
    env: WorkerEnv,
    exec: ExecutionContext
  ): Promise<Response> => {
    // Parse the URL and announce request start before any routing work.
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const startTime = Date.now();
    ctx.emit("request:start", { method: request.method, path: url.pathname, requestId });

    // Route against the compiled table; a miss is a 404 with no further events.
    const match = ctx.state.match(request.method, url.pathname);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    // Matched: announce it, then build the fresh per-request context — env on the stack, never state (SB4).
    ctx.emit("server:matched", { path: url.pathname, method: request.method });
    const rc: RequestContext = {
      request,
      env,
      exec,
      params: match.params,
      url,
      require: ctx.require,
      has: ctx.has
    };

    // Dispatch to the handler, then announce completion with status + elapsed ms.
    const response = await match.endpoint.handler(rc);
    ctx.emit("request:end", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      ms: Date.now() - startTime
    });

    return response;
  };

  /**
   * Cron entry. Dispatches the `ScheduledController` through the same endpoint
   * table as `handle` and **awaits** the matched handler so Cloudflare does not
   * kill the isolate before the work finishes.
   *
   * Awaited API method — not `emit` — because the Worker must `await` cron work
   * (F8; spec/07 §3). The `env` is threaded on the stack, never stored on state (SB4).
   *
   * @param controller - Cloudflare `ScheduledController` (`cron`, `scheduledTime`).
   * @param env - Per-request Cloudflare bindings; threaded, never stored.
   * @param exec - `ExecutionContext` for `waitUntil` / `passThroughOnException`.
   * @returns Resolves after all matched cron work completes (or immediately if no match).
   * @example
   * ```typescript
   * await serverApi.scheduled(controller, env, exec);
   * ```
   */
  const scheduled = async (
    controller: ScheduledController,
    env: WorkerEnv,
    exec: ExecutionContext
  ): Promise<void> => {
    const match = ctx.state.match("ALL", controller.cron);
    if (!match) return;

    const cronUrl = new URL(`https://cron/${controller.cron}`);
    const rc: RequestContext = {
      request: new Request(cronUrl.href),
      env,
      exec,
      params: match.params,
      url: cronUrl,
      require: ctx.require,
      has: ctx.has
    };

    await match.endpoint.handler(rc);
  };

  return { handle, scheduled };
};
