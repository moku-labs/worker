/**
 * @file server plugin — pure `endpoint()` builder + chainable guard factory.
 *
 * No ctx, no lifecycle, no side effects. Runs before `createApp`. `endpoint.new(guard)`
 * derives a factory that composes guards in front of each handler at build time, so the
 * stored `Endpoint.handler` stays a normal handler and the matcher/dispatch never change.
 */
import type { Endpoint, EndpointGuard, EndpointHandler, PathParams } from "./types";

/**
 * Fluent builder whose verb methods each return a typed `Endpoint`.
 *
 * @template Path - The path template literal, used to infer each handler's
 *   typed `ctx.params` ({@link PathParams}).
 * @example
 * ```typescript
 * const e = endpoint("/api/{id}").get(({ params }) => Response.json({ id: params.id }));
 * ```
 */
export type EndpointBuilder<Path extends string> = {
  /**
   * Build a GET endpoint bound to this path.
   *
   * @param handler - The handler invoked when a GET request matches.
   * @returns A GET `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/health").get(() => new Response("ok"));
   * ```
   */
  get(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build a POST endpoint bound to this path.
   *
   * @param handler - The handler invoked when a POST request matches.
   * @returns A POST `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users").post(({ request }) => Response.json({ created: true }, { status: 201 }));
   * ```
   */
  post(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build a PUT endpoint bound to this path.
   *
   * @param handler - The handler invoked when a PUT request matches.
   * @returns A PUT `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").put(({ params }) => Response.json({ updated: params.id }));
   * ```
   */
  put(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build a PATCH endpoint bound to this path.
   *
   * @param handler - The handler invoked when a PATCH request matches.
   * @returns A PATCH `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").patch(({ params }) => Response.json({ patched: params.id }));
   * ```
   */
  patch(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build a DELETE endpoint bound to this path.
   *
   * @param handler - The handler invoked when a DELETE request matches.
   * @returns A DELETE `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").delete(() => new Response(null, { status: 204 }));
   * ```
   */
  delete(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build a HEAD endpoint bound to this path.
   *
   * @param handler - The handler invoked when a HEAD request matches.
   * @returns A HEAD `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/health").head(() => new Response(null, { status: 200 }));
   * ```
   */
  head(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build an OPTIONS endpoint bound to this path.
   *
   * @param handler - The handler invoked when an OPTIONS request matches.
   * @returns An OPTIONS `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/api").options(() => new Response(null, { headers: { Allow: "GET, POST" } }));
   * ```
   */
  options(handler: EndpointHandler<PathParams<Path>>): Endpoint;
  /**
   * Build an ALL-method endpoint bound to this path (`method: "ALL"` — matches any verb).
   *
   * @param handler - The handler invoked when any request method matches.
   * @returns An ALL-method `Endpoint`.
   * @example
   * ```typescript
   * endpoint("0 * * * *").all(async () => new Response("cron done"));
   * ```
   */
  all(handler: EndpointHandler<PathParams<Path>>): Endpoint;
};

/**
 * A callable, chainable endpoint factory: call it with a path (exactly like
 * {@link endpoint}) to get a verb {@link EndpointBuilder}, or call `.new(guard)` to
 * derive a NEW factory that runs `guard` before every handler it builds. Chain
 * `.new` to stack guards; the receiver is never mutated, so factories branch safely.
 *
 * @example
 * ```typescript
 * const authed = endpoint.new(async (ctx) => {
 *   if (!ctx.request.headers.has("authorization")) return new Response(null, { status: 401 });
 * });
 * authed("/me").get(() => Response.json({ ok: true }));
 * ```
 */
export type GuardedEndpointFactory = {
  /**
   * Bind a path and return its verb builder (identical to {@link endpoint}); any
   * guards accumulated on this factory run before the handler.
   *
   * @template Path - The path template literal, inferred from `path`.
   * @param path - Endpoint path, optionally with `{name}` / `{name:?}` params.
   * @returns A builder whose verb methods each return a typed `Endpoint`.
   * @example
   * ```typescript
   * authed("/api/{id}").get(({ params }) => Response.json({ id: params.id }));
   * ```
   */
  <Path extends string>(path: Path): EndpointBuilder<Path>;
  /**
   * Append a guard and return a NEW chainable factory carrying it. The receiver is
   * not mutated; guards run in the order added, before the handler.
   */
  new: (guard: EndpointGuard) => GuardedEndpointFactory;
};

/**
 * Compose a guard chain in front of a handler into a single `EndpointHandler`.
 * Guards run in order; the first to return a `Response` short-circuits — the handler
 * and any later guards are skipped. An EMPTY chain returns `handler` unchanged
 * (reference-identical), so an un-guarded builder is byte-identical to before. The
 * chain is `await`ed, so sync and async guards mix freely; a guard throw propagates.
 *
 * @param guards - The guards to run before the handler, in order (may be empty).
 * @param handler - The handler to run if no guard short-circuits.
 * @returns A handler that runs the guards then the handler — or `handler` itself when no guards.
 * @example
 * ```typescript
 * const h = compose([authGuard], () => new Response("ok"));
 * ```
 */
const compose = (guards: readonly EndpointGuard[], handler: EndpointHandler): EndpointHandler => {
  if (guards.length === 0) return handler;
  return async ctx => {
    for (const guard of guards) {
      const blocked = await guard(ctx);
      if (blocked) return blocked; // a returned Response short-circuits the chain
    }
    return handler(ctx);
  };
};

/**
 * Produce a guard-composed `Endpoint` value from a path, method, guards, and handler.
 *
 * @template Path - The path template literal, inferred from `path`.
 * @param path - Endpoint path string.
 * @param method - HTTP method literal or `"ALL"`.
 * @param guards - The factory's accumulated guard chain (may be empty).
 * @param handler - The function invoked when this endpoint matches.
 * @returns An `Endpoint` value object whose handler runs the guards first.
 * @example
 * ```typescript
 * makeGuardedEndpoint("/api", "GET", [], handler); // { path, method: "GET", handler }
 * ```
 */
const makeGuardedEndpoint = <Path extends string>(
  path: Path,
  method: Endpoint["method"],
  guards: readonly EndpointGuard[],
  handler: EndpointHandler<PathParams<Path>>
): Endpoint =>
  // The matcher fills `params` with exactly the names declared in `path`, so the
  // path-typed handler is sound to store under the type-erased `Endpoint.handler`;
  // `compose` then runs the guard chain in front of it.
  ({ path, method, handler: compose(guards, handler as EndpointHandler) });

/**
 * Build the verb object for a path, composing `guards` before each handler. The
 * path template flows into each handler's `ctx.params` ({@link PathParams}); the
 * guard chain is composed in via {@link makeGuardedEndpoint}.
 *
 * @template Path - The path template literal, inferred from `path`.
 * @param path - Endpoint path, optionally with `{name}` / `{name:?}` params.
 * @param guards - Guards composed before each built handler (may be empty).
 * @returns A builder whose verb methods each return a typed, guard-composed `Endpoint`.
 * @example
 * ```typescript
 * buildVerbs("/health", []).get(() => new Response("ok"));
 * ```
 */
const buildVerbs = <Path extends string>(
  path: Path,
  guards: readonly EndpointGuard[]
): EndpointBuilder<Path> => ({
  /**
   * Build a GET endpoint bound to this path.
   *
   * @param handler - The handler invoked when a GET request matches.
   * @returns A GET `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/health").get(() => new Response("ok"));
   * ```
   */
  get: handler => makeGuardedEndpoint(path, "GET", guards, handler),
  /**
   * Build a POST endpoint bound to this path.
   *
   * @param handler - The handler invoked when a POST request matches.
   * @returns A POST `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users").post(({ request }) => Response.json({ created: true }, { status: 201 }));
   * ```
   */
  post: handler => makeGuardedEndpoint(path, "POST", guards, handler),
  /**
   * Build a PUT endpoint bound to this path.
   *
   * @param handler - The handler invoked when a PUT request matches.
   * @returns A PUT `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").put(({ params }) => Response.json({ updated: params.id }));
   * ```
   */
  put: handler => makeGuardedEndpoint(path, "PUT", guards, handler),
  /**
   * Build a PATCH endpoint bound to this path.
   *
   * @param handler - The handler invoked when a PATCH request matches.
   * @returns A PATCH `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").patch(({ params }) => Response.json({ patched: params.id }));
   * ```
   */
  patch: handler => makeGuardedEndpoint(path, "PATCH", guards, handler),
  /**
   * Build a DELETE endpoint bound to this path.
   *
   * @param handler - The handler invoked when a DELETE request matches.
   * @returns A DELETE `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/users/{id}").delete(() => new Response(null, { status: 204 }));
   * ```
   */
  delete: handler => makeGuardedEndpoint(path, "DELETE", guards, handler),
  /**
   * Build a HEAD endpoint bound to this path.
   *
   * @param handler - The handler invoked when a HEAD request matches.
   * @returns A HEAD `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/health").head(() => new Response(null, { status: 200 }));
   * ```
   */
  head: handler => makeGuardedEndpoint(path, "HEAD", guards, handler),
  /**
   * Build an OPTIONS endpoint bound to this path.
   *
   * @param handler - The handler invoked when an OPTIONS request matches.
   * @returns An OPTIONS `Endpoint`.
   * @example
   * ```typescript
   * endpoint("/api").options(() => new Response(null, { headers: { Allow: "GET, POST" } }));
   * ```
   */
  options: handler => makeGuardedEndpoint(path, "OPTIONS", guards, handler),
  /**
   * Build an ALL-method endpoint bound to this path (matches any verb).
   *
   * @param handler - The handler invoked when any request method matches.
   * @returns An ALL-method `Endpoint`.
   * @example
   * ```typescript
   * endpoint("0 * * * *").all(async () => new Response("cron done"));
   * ```
   */
  all: handler => makeGuardedEndpoint(path, "ALL", guards, handler)
});

/**
 * Create a callable, chainable guarded endpoint factory over a fixed guard chain.
 * Shared by the exported {@link endpoint} (empty chain) and every `.new()` descendant;
 * each `.new` returns a fresh factory over `[...guards, guard]`, never mutating the receiver.
 *
 * @param guards - The immutable guard chain this factory runs before each handler (may be empty).
 * @returns A {@link GuardedEndpointFactory}: callable like `endpoint`, with a chaining `.new`.
 * @example
 * ```typescript
 * const authed = makeFactory([]).new(authGuard);
 * ```
 */
const makeFactory = (guards: readonly EndpointGuard[]): GuardedEndpointFactory => {
  // Widen the bare call signature to the factory type that also carries `.new`
  // (attached just below — the only member the target adds over the call signature).
  const factory = (<Path extends string>(path: Path): EndpointBuilder<Path> =>
    buildVerbs(path, guards)) as GuardedEndpointFactory;
  // `.new` is a legal property name though `new` is a reserved identifier; append the
  // guard immutably so chained factories branch without cross-contamination.
  // eslint-disable-next-line jsdoc/require-jsdoc -- structural factory-chaining closure
  factory.new = guard => makeFactory([...guards, guard]);
  return factory;
};

/**
 * Build a typed `Endpoint`, and the root of the chainable guard factory. `{name}` →
 * required param (`string`); `{name:?}` → optional param (`string | undefined`). The
 * path template flows into each handler's `ctx.params` ({@link PathParams}), so a
 * required `{id}` is typed `string` — no `?? ""` fallback needed.
 *
 * `endpoint.new(guard)` derives a NEW factory (callable exactly like `endpoint`) that
 * runs `guard` before each handler; chain `.new` to stack guards
 * ({@link GuardedEndpointFactory}). A guard returning a `Response` short-circuits;
 * returning `void` continues. With no guards the builder is byte-identical to before.
 *
 * PURE factory (spec/03 §1): no ctx, no lifecycle, no side effects; safe to run before
 * `createApp`. Each verb method (`get`, `post`, …, `all`) returns the truthful Endpoint
 * value — `method: "ALL"` is never used as a `"get"` sentinel.
 *
 * @example
 * ```typescript
 * endpoint("/api/data/{lang:?}").get(({ params }) =>
 *   Response.json({ lang: params.lang ?? "en" })
 * );
 *
 * const authed = endpoint.new(async ({ request }) =>
 *   request.headers.has("authorization") ? undefined : new Response(null, { status: 401 })
 * );
 * authed("/me").get(() => Response.json({ ok: true }));
 * ```
 */
export const endpoint: GuardedEndpointFactory = makeFactory([]);
