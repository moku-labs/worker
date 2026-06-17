/**
 * @file server plugin — pure `endpoint()` builder.
 *
 * No ctx, no lifecycle, no side effects. Runs before `createApp`.
 */
import type { Endpoint, EndpointHandler } from "./types";

/**
 * Fluent builder whose verb methods each return a typed `Endpoint`.
 *
 * @example
 * ```typescript
 * const e = endpoint("/api/{id}").get(handler);
 * ```
 */
export type EndpointBuilder = {
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
  get(handler: EndpointHandler): Endpoint;
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
  post(handler: EndpointHandler): Endpoint;
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
  put(handler: EndpointHandler): Endpoint;
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
  patch(handler: EndpointHandler): Endpoint;
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
  delete(handler: EndpointHandler): Endpoint;
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
  head(handler: EndpointHandler): Endpoint;
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
  options(handler: EndpointHandler): Endpoint;
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
  all(handler: EndpointHandler): Endpoint;
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
const makeEndpoint = (
  path: string,
  method: Endpoint["method"],
  handler: EndpointHandler
): Endpoint => ({ path, method, handler });

/**
 * Build a typed `Endpoint`. `{name}` → required param; `{name?}` → optional param.
 *
 * PURE factory (spec/03 §1): no ctx, no lifecycle, no side effects; safe to run
 * before `createApp`. Each verb method (`get`, `post`, …, `all`) returns the
 * truthful Endpoint value — `method: "ALL"` is never used as a `"get"` sentinel.
 *
 * @param path - Endpoint path, optionally with `{name}` / `{name?}` params.
 * @returns A builder whose verb methods each return a typed `Endpoint`.
 * @example
 * ```typescript
 * endpoint("/api/data/{lang?}").get(({ params }) =>
 *   Response.json({ lang: params.lang ?? "en" })
 * );
 * ```
 */
export const endpoint = (path: string): EndpointBuilder => ({
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
