/**
 * @file server plugin — pure `endpoint()` builder.
 *
 * No ctx, no lifecycle, no side effects. Runs before `createApp`.
 */
import type { Endpoint, EndpointHandler, PathParams } from "./types";

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
 * Produce an `Endpoint` value from a path, method, and handler.
 *
 * @param path - Endpoint path string.
 * @param method - HTTP method literal or `"ALL"`.
 * @param handler - The function invoked when this endpoint matches.
 * @returns An `Endpoint` value object.
 * @example
 * ```typescript
 * makeEndpoint("/api", "GET", handler); // { path: "/api", method: "GET", handler }
 * ```
 */
const makeEndpoint = <Path extends string>(
  path: Path,
  method: Endpoint["method"],
  handler: EndpointHandler<PathParams<Path>>
): Endpoint =>
  // The matcher fills `params` with exactly the names declared in `path`, so the
  // path-typed handler is sound to store under the type-erased `Endpoint.handler`.
  ({ path, method, handler: handler as EndpointHandler });

/**
 * Build a typed `Endpoint`. `{name}` → required param (`string`); `{name:?}` →
 * optional param (`string | undefined`). The path template flows into each
 * handler's `ctx.params` ({@link PathParams}), so a required `{id}` is typed
 * `string` — no `?? ""` fallback needed.
 *
 * PURE factory (spec/03 §1): no ctx, no lifecycle, no side effects; safe to run
 * before `createApp`. Each verb method (`get`, `post`, …, `all`) returns the
 * truthful Endpoint value — `method: "ALL"` is never used as a `"get"` sentinel.
 *
 * @template Path - The path template literal, inferred from `path`.
 * @param path - Endpoint path, optionally with `{name}` / `{name:?}` params.
 * @returns A builder whose verb methods each return a typed `Endpoint`.
 * @example
 * ```typescript
 * endpoint("/api/data/{lang:?}").get(({ params }) =>
 *   Response.json({ lang: params.lang ?? "en" })
 * );
 * ```
 */
export const endpoint = <Path extends string>(path: Path): EndpointBuilder<Path> => ({
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
  get: handler => makeEndpoint(path, "GET", handler),
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
  post: handler => makeEndpoint(path, "POST", handler),
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
  put: handler => makeEndpoint(path, "PUT", handler),
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
  patch: handler => makeEndpoint(path, "PATCH", handler),
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
  delete: handler => makeEndpoint(path, "DELETE", handler),
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
  head: handler => makeEndpoint(path, "HEAD", handler),
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
  options: handler => makeEndpoint(path, "OPTIONS", handler),
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
  all: handler => makeEndpoint(path, "ALL", handler)
});
