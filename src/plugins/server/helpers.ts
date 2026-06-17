/**
 * @file server plugin — pure endpoint() builder skeleton.
 */
import type { Endpoint, EndpointHandler } from "./types";

/** Fluent builder whose verb methods each return a typed Endpoint. */
export type EndpointBuilder = {
  /** Build a GET endpoint. */
  get(handler: EndpointHandler): Endpoint;
  /** Build a POST endpoint. */
  post(handler: EndpointHandler): Endpoint;
  /** Build a PUT endpoint. */
  put(handler: EndpointHandler): Endpoint;
  /** Build a PATCH endpoint. */
  patch(handler: EndpointHandler): Endpoint;
  /** Build a DELETE endpoint. */
  delete(handler: EndpointHandler): Endpoint;
  /** Build a HEAD endpoint. */
  head(handler: EndpointHandler): Endpoint;
  /** Build an OPTIONS endpoint. */
  options(handler: EndpointHandler): Endpoint;
  /** Build an ALL-method endpoint. */
  all(handler: EndpointHandler): Endpoint;
};

/**
 * Build a typed Endpoint. `{name}` required, `{name?}` optional. PURE factory:
 * no ctx, no lifecycle, no side effects; runs before createApp.
 *
 * @param _path - Endpoint path, optionally with `{name}` / `{name?}` params.
 * @example
 * ```ts
 * endpoint("/api/data/{lang?}").get(({ params }) => Response.json({ lang: params.lang }));
 * ```
 */
export function endpoint(_path: string): EndpointBuilder {
  throw new Error("not implemented");
}
