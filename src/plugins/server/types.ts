/**
 * @file server plugin — type definitions skeleton.
 */
import type { PluginCtx, PluginInstance } from "@moku-labs/core";
import type { WorkerEnv, WorkerEvents } from "../../config";

/** HTTP method an endpoint matches; "ALL" matches any verb. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "ALL";

/** One parsed path segment: a literal, a required `{name}`, or an optional `{name:?}`. */
export type PathSegment = {
  /** The literal text, or the param name when a param. */
  readonly value: string;
  /** Whether this segment is a `{name}` / `{name:?}` parameter. */
  readonly param: boolean;
  /** Whether the param is optional (`{name:?}`). */
  readonly optional: boolean;
};

/** A declarative endpoint produced by the pure endpoint() builder. */
export type Endpoint = {
  /** Endpoint path, optionally with `{name}` / `{name:?}` params. */
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

/** Any plugin instance — mirrors core's un-exported RequireFunction constraint. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors core's unexported RequireFunction constraint; PluginInstance type-args must be `any` (not `unknown`) for variance
type AnyPlugin = PluginInstance<string, any, any, any, any>;

/**
 * Extract a plugin instance's API type. Extracts via the `_phantom.api` slot —
 * identical to core's un-exported `ExtractPluginApi`, so this `RequireFn` is
 * assignable FROM core's real `ctx.require` (whose return is `ExtractPluginApi<P>`).
 * Extracting via the `PluginInstance<…, infer A, …>` pattern would NOT unify with
 * `ExtractPluginApi<P>` for an unresolved generic `P`.
 */
type ApiOf<P> = P extends { readonly _phantom: { readonly api: infer A } } ? A : never;

/** Cross-plugin reach used inside handlers: require(plugin) returns that plugin's API. Mirrors ctx.require. */
export type RequireFn = <P extends AnyPlugin>(plugin: P) => ApiOf<P>;

/**
 * Prettify an intersection into a single flat object type for readable hovers.
 * Homomorphic mapped type — preserves each property's `?` optionality modifier.
 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Required param names in a path template, as a string union (`never` if none).
 * Walks each `{...}` segment: collects a bare `{name}`, skips an optional `{name:?}`.
 */
type RequiredParamNames<Path extends string> = Path extends `${string}{${infer Rest}`
  ? Rest extends `${infer Body}}${infer Tail}`
    ? Body extends `${string}:?`
      ? RequiredParamNames<Tail>
      : Body | RequiredParamNames<Tail>
    : never
  : never;

/**
 * Optional param names in a path template with the `:?` suffix stripped, as a
 * string union (`never` if none). Collects `{name:?}`, skips a bare `{name}`.
 */
type OptionalParamNames<Path extends string> = Path extends `${string}{${infer Rest}`
  ? Rest extends `${infer Body}}${infer Tail}`
    ? Body extends `${infer Name}:?`
      ? Name | OptionalParamNames<Tail>
      : OptionalParamNames<Tail>
    : never
  : never;

/**
 * Map a path template to its typed `params` object: a required `{name}` becomes
 * `name: string`; an optional `{name:?}` becomes `name?: string`. A non-literal
 * `string` path (e.g. one assembled at runtime) widens to the permissive
 * `Record<string, string | undefined>`.
 *
 * @example
 * ```typescript
 * type P = PathParams<"/boards/{id}/data/{lang:?}">;
 * // { id: string; lang?: string }
 * ```
 */
export type PathParams<Path extends string> = string extends Path
  ? Record<string, string | undefined>
  : Prettify<
      { [K in RequiredParamNames<Path>]: string } & { [K in OptionalParamNames<Path>]?: string }
    >;

/**
 * A request handler: receives the per-request context, returns a Response.
 *
 * @template Params - Path-params shape, inferred by the `endpoint()` builder
 *   from the path template ({@link PathParams}) — a required `{name}` is
 *   `string`, an optional `{name:?}` is `string | undefined`. Defaults to the
 *   permissive `Record<string, string | undefined>` for hand-written handler types.
 * @template Extension - Context extension contributed by the endpoint's guard chain
 *   (e.g. `{ actor: Actor }` from an authenticating guard). Defaults to the empty
 *   object (no enrichment); a guard accumulates its `Extension` onto this. See
 *   {@link EndpointGuard} + `endpoint.new`.
 */
export type EndpointHandler<
  Params = Record<string, string | undefined>,
  Extension = Record<never, never>
> = (ctx: RequestContext<Params> & Extension) => Response | Promise<Response>;

/**
 * Fresh per-request object threaded to each EndpointHandler.
 *
 * @template Params - Path-params shape for `params`, inferred from the path
 *   template by the `endpoint()` builder ({@link PathParams}). Defaults to the
 *   permissive `Record<string, string | undefined>`.
 */
export type RequestContext<Params = Record<string, string | undefined>> = {
  /** The incoming request. */
  readonly request: Request;
  /** Per-request Cloudflare bindings — threaded on the stack, NEVER stored in state. */
  readonly env: WorkerEnv;
  /** waitUntil / passThroughOnException. */
  readonly exec: ExecutionContext;
  /** Path params extracted from the matched endpoint, typed from the path template. */
  readonly params: Params;
  /** Parsed request URL. */
  readonly url: URL;
  /** Cross-plugin reach for handlers (e.g. require(bindingsPlugin)). */
  readonly require: RequireFn;
  /** Presence check for an optional plugin. */
  readonly has: (name: string) => boolean;
};

/**
 * A guard run before an endpoint's handler — the building block of an
 * `endpoint.new(guard)` chain. Receives the same per-request {@link RequestContext}
 * the handler does. A guard may:
 * - return a `Response` (or `Promise<Response>`) → **short-circuit**: that response is
 *   sent and neither the handler nor any later guard runs;
 * - return an `Extension` object → **enrich**: the object is merged into the context handed to
 *   later guards AND the handler, which then reads it as a typed field (e.g. `ctx.actor`).
 *   Inferred into the handler's ctx via `endpoint.new` — so the guard resolves a value
 *   ONCE and the handler reuses it (no re-resolve, no defensive null-check);
 * - return `undefined` / `void` → **continue** to the next guard, then the handler.
 *
 * Sync or async — the server `await`s every guard, so the two mix freely; a guard that
 * throws propagates exactly like a throwing handler (no extra try/catch).
 *
 * @template Extension - The context extension this guard contributes. Defaults to `never`, so
 *   a bare `EndpointGuard` is gate-only (`Response | void`) — exactly the prior contract.
 * @example Gate only
 * ```typescript
 * const requireAuth: EndpointGuard = async (ctx) => {
 *   if (!ctx.request.headers.has("authorization")) return new Response("Unauthorized", { status: 401 });
 * };
 * ```
 * @example Gate + enrich (the handler then reads `ctx.actor`)
 * ```typescript
 * const authed = endpoint.new(async (ctx) => {
 *   const actor = await ctx.require(authPlugin).resolveActor(ctx.request, ctx.env);
 *   if (!actor) return new Response("Unauthorized", { status: 401 });
 *   return { actor };
 * });
 * ```
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is required — a guard with a no-return body (the common "do auth, fall through" case) yields `void`/`Promise<void>`, which assigns only to a `void` union; `undefined` would reject it.
export type EndpointGuard<Extension = never> = (
  ctx: RequestContext
) => Response | void | Extension | Promise<Response | void | Extension>;

/** Per-plugin event map merged into the server context. */
export type ServerEvents = { "server:matched": { path: string; method: string } };

/** Full server plugin context (own config + state + merged events + cross-plugin reach). */
export type ServerCtx = PluginCtx<ServerConfig, ServerState, WorkerEvents & ServerEvents> & {
  /** Cross-plugin require threaded into each RequestContext. */
  require: RequireFn;
  /** Presence check for an optional plugin. */
  has: (name: string) => boolean;
};

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
