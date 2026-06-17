/**
 * @file server plugin — type definitions skeleton.
 */
import type { PluginCtx, PluginInstance } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";

/** HTTP method an endpoint matches; "ALL" matches any verb. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";

/** One parsed path segment: a literal, a required `{name}`, or an optional `{name?}`. */
export type PathSegment = {
  /** The literal text, or the param name when a param. */
  readonly value: string;
  /** Whether this segment is a `{name}` / `{name?}` parameter. */
  readonly param: boolean;
  /** Whether the param is optional (`{name?}`). */
  readonly optional: boolean;
};

/** A declarative endpoint produced by the pure endpoint() builder. */
export type Endpoint = {
  /** Endpoint path, optionally with `{name}` / `{name?}` params. */
  readonly path: string;
  /** HTTP method or "ALL". */
  readonly method: Method;
  /** The handler invoked on a match. */
  readonly handler: EndpointHandler;
};

/** A compiled endpoint with pre-parsed segments and a specificity score. */
export type CompiledEndpoint = {
  /** Original endpoint, returned to the dispatch site. */
  readonly endpoint: Endpoint;
  /** Pre-parsed path segments for fast matching. */
  readonly segments: ReadonlyArray<PathSegment>;
  /** Specificity score — higher = more literal segments, sorted first. */
  readonly specificity: number;
};

/** Server config — the declarative endpoint table. */
export type ServerConfig = {
  /** Endpoints compiled into the matcher table. Default []. */
  endpoints: Endpoint[];
};

/** A successful endpoint match: the endpoint plus its extracted path params. */
export type MatchResult = {
  /** The matched endpoint. */
  readonly endpoint: Endpoint;
  /** Path params extracted from the request path. */
  readonly params: Record<string, string | undefined>;
};

/** Server state — the compiled matcher table, built once at onInit. */
export type ServerState = {
  /** Endpoints sorted by specificity. Populated from config at onInit. */
  table: CompiledEndpoint[];
  /** True once onInit has compiled the table; guards double-compilation. */
  compiled: boolean;
  /**
   * Match a method + pathname against the compiled table (literal beats param,
   * method-specific beats ALL). Returns the matched endpoint + params, or null.
   *
   * @param method - The request method (or "ALL" for cron dispatch).
   * @param path - The request URL pathname (or cron string).
   * @returns The matched endpoint and its params, or null.
   */
  match(method: string, path: string): MatchResult | null;
};

/** Any plugin instance — mirrors core's RequireFunction constraint (require/has are not on PluginCtx). */
type AnyPlugin = PluginInstance<
  string,
  unknown,
  unknown,
  Record<string, unknown>,
  Record<string, unknown>
>;

/** Extract a plugin instance's API type. */
type ApiOf<P> =
  P extends PluginInstance<string, unknown, unknown, infer A, Record<string, unknown>> ? A : never;

/** Cross-plugin reach used inside handlers: require(plugin) returns that plugin's API. Mirrors ctx.require. */
export type RequireFn = <P extends AnyPlugin>(plugin: P) => ApiOf<P>;

/** A request handler: receives the per-request context, returns a Response. */
export type EndpointHandler = (ctx: RequestContext) => Response | Promise<Response>;

/** Fresh per-request object threaded to each EndpointHandler. */
export type RequestContext = {
  /** The incoming request. */
  readonly request: Request;
  /** Per-request Cloudflare bindings — threaded on the stack, NEVER stored in state. */
  readonly env: WorkerEnv;
  /** waitUntil / passThroughOnException. */
  readonly exec: ExecutionContext;
  /** Path params extracted from the matched endpoint. */
  readonly params: Record<string, string | undefined>;
  /** Parsed request URL. */
  readonly url: URL;
  /** Cross-plugin reach for handlers (e.g. require(bindingsPlugin)). */
  readonly require: RequireFn;
  /** Presence check for an optional plugin. */
  readonly has: (name: string) => boolean;
};

/** Per-plugin event map merged into the server context. */
export type ServerEvents = { "server:matched": { path: string; method: string } };

/** Full server plugin context (own config + state + merged events). */
export type ServerCtx = PluginCtx<ServerConfig, ServerState, WorkerEvents & ServerEvents>;

/** Public api surface of the server plugin. */
export type Api = {
  /**
   * Route one HTTP request and return its Response (or 404).
   *
   * @param request - The incoming request.
   * @param env - Per-request Cloudflare bindings (threaded, never stored).
   * @param exec - waitUntil / passThroughOnException.
   * @returns The handler's response, or 404 Not Found.
   */
  handle(request: Request, env: WorkerEnv, exec: ExecutionContext): Promise<Response>;
  /**
   * Cron entry. Dispatches the controller through the endpoint table and awaits it.
   *
   * @param controller - The cron controller.
   * @param env - Per-request bindings (threaded, never stored).
   * @param exec - waitUntil / passThroughOnException.
   * @returns Resolves after all matched cron work completes.
   */
  scheduled(controller: ScheduledController, env: WorkerEnv, exec: ExecutionContext): Promise<void>;
};
