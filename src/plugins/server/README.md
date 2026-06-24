# server

> Standard plugin — HTTP routing + request/scheduled dispatch + the Worker-entry surface for `@moku-labs/worker`.

## Overview

The `server` plugin owns the framework's request lifecycle. It compiles a declarative list of `Endpoint`s into a specificity-sorted matcher table, dispatches each incoming `fetch` to the matched handler, and dispatches `scheduled` (cron) controllers through that same table. It is the surface a consumer's hand-assembled Worker default export reads:

- **`app.server.handle(request, env, exec)`** — routes one HTTP request, returns its `Response` (or `404`).
- **`app.server.scheduled(controller, env, exec)`** — dispatches a cron controller and **awaits** the matched handler.
- **`endpoint(path)`** — a pure builder (re-exported top-level) that produces the `Endpoint` values you put in config.

Request/response flows through the api **return value**, never through `emit` — the kernel cannot carry a value through fire-and-forget events. On each request `handle` allocates a **fresh `RequestContext` on that call's stack** carrying the per-request Cloudflare `env`; `env` is **never** stored in plugin state, so the single isolate that serves concurrent requests never leaks bindings across them.

In the dependency graph, `server` declares `depends: [bindingsPlugin]`. This guarantees `bindings` is resolved before `server` and lets endpoint handlers cross-reach sibling plugins (`kv`, `d1`, `storage`, `queues`, `durableObjects`) via `ctx.require`, which is threaded into every `RequestContext`. `server` does not call `bindings` directly — it hands the capability to handlers.

`server` is a **regular** plugin, so its api mounts on `app.server.*`. The Worker default export (`{ fetch, scheduled, queue }`) is **not** produced by any primitive — the consumer hand-assembles it from `app.server.handle` / `app.server.scheduled` after `createApp()`.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoints` | `Endpoint[]` | `[]` | Endpoints compiled into the matcher table. Each is built by `endpoint(path).<verb>(handler)`. The empty default makes the whole server config optional; an unmatched request yields `404`. |

Config is passed through `createApp({ pluginConfigs: { server: { ... } } })`. `serverPlugin` is wired into the framework automatically — you do **not** list it in `plugins`.

```typescript
import { createApp, endpoint } from "@moku-labs/worker";

export const app = createApp({
  pluginConfigs: {
    server: {
      endpoints: [
        endpoint("/health").get(() => new Response("ok")),
        endpoint("/api/data/{lang:?}").get(({ params }) =>
          Response.json({ lang: params.lang ?? "en" })
        )
      ]
    }
  }
});
```

The frozen config is immutable after `createApp`. `createServerState` copies `config.endpoints` into a fresh mutable table — it never mutates the frozen config array.

## API

The api object is mounted as `app.server`.

### `handle(request, env, exec): Promise<Response>`

```typescript
handle(request: Request, env: WorkerEnv, exec: ExecutionContext): Promise<Response>;
```

Routes one HTTP request: matches `request.method` + `URL.pathname` against the compiled table, allocates a fresh stack `RequestContext` carrying the per-request `env`, invokes the matched `EndpointHandler`, and returns its `Response`. Returns `new Response("Not Found", { status: 404 })` when no endpoint matches. `env` is threaded as an argument and **never** written to state.

Emits `request:start` → `server:matched` → `request:end` as fire-and-forget observability (see [Events](#events)); the response itself flows through the return value. Does not throw on its own — a handler that throws propagates to the caller.

```typescript
const res = await app.server.handle(
  new Request("https://example.com/api/data/fr"),
  env,
  exec
);
// res.status === 200, body { lang: "fr" }
```

### `scheduled(controller, env, exec): Promise<void>`

```typescript
scheduled(controller: ScheduledController, env: WorkerEnv, exec: ExecutionContext): Promise<void>;
```

Cron entry. Matches `controller.cron` against the same endpoint table using method `"ALL"`, builds a `RequestContext` (with `request`/`url` synthesized as `https://cron/<cron>`), and **awaits** the matched handler so Cloudflare does not kill the isolate before the work finishes. Resolves immediately if no endpoint matches the cron string. Returns `Promise<void>` — the Worker default export must `await` it. `env` is threaded, never stored.

```typescript
await app.server.scheduled(controller, env, exec);
```

Register a cron handler with `.all` against the cron expression as its path:

```typescript
endpoint("0 * * * *").all(async ({ env }) => {
  // hourly work; env is the per-invocation bindings object
  return new Response("cron done");
});
```

### `endpoint(path): EndpointBuilder` — helper (pure)

```typescript
import { endpoint } from "@moku-labs/worker";

endpoint<Path extends string>(path: Path): EndpointBuilder<Path>;
```

A **pure static factory** — no `ctx`, no lifecycle, no side effects; safe to call before `createApp`. Returns a builder whose verb methods each produce a typed `Endpoint`:

| Method | Produced `method` |
|---|---|
| `get(handler)` | `"GET"` |
| `post(handler)` | `"POST"` |
| `put(handler)` | `"PUT"` |
| `patch(handler)` | `"PATCH"` |
| `delete(handler)` | `"DELETE"` |
| `head(handler)` | `"HEAD"` |
| `options(handler)` | `"OPTIONS"` |
| `all(handler)` | `"ALL"` (matches any verb / used for cron) |

`handler` is an `EndpointHandler<Params>` — `(ctx: RequestContext<Params>) => Response | Promise<Response>`, where `Params` is inferred from the path template (see **Path params** below). `method: "ALL"` is a truthful value handled by the matcher, never a `"get"` sentinel.

**Path params:** `{name}` is a required param, `{name:?}` is optional — the `:?` form matches the `@moku-labs/web` router. The path template is parsed at the type level into `ctx.params`: a required `{name}` is typed `string` (no `?? ""` fallback needed), an optional `{name:?}` is typed `string | undefined`. A path assembled from a non-literal `string` widens to `Record<string, string | undefined>`. An absent optional param resolves to `undefined` at runtime.

```typescript
endpoint("/users/{id}").get(({ params }) => Response.json({ id: params.id }));
endpoint("/api/data/{lang:?}").get(({ params }) =>
  Response.json({ lang: params.lang ?? "en" })
);
```

The same builder is also reachable as `serverPlugin.endpoint(...)` on the plugin instance (it lives on `serverPlugin.helpers`); the top-level `endpoint` is the flat re-export.

### `endpoint.new(guard)` — chainable guards

`endpoint` is also a **chainable guard factory**. `endpoint.new(guard)` returns a NEW factory that is callable exactly like `endpoint` (give it a path, get the verb builder) but runs `guard` before every handler it builds. The plugin composes the guard chain into the stored handler at **build time**, so a guarded endpoint is an ordinary `Endpoint` — the matcher and dispatch are unchanged.

A **guard** is an `EndpointGuard` — it receives the same `RequestContext` the handler does and returns:

- a `Response` (or `Promise<Response>`) — **reject**: that response is returned and neither the handler nor any later guard runs;
- nothing (`void` / `Promise<void>`) — **continue** to the next guard, then the handler.

Guards may be sync or async (the chain is `await`ed, so the two mix freely), and a guard that throws propagates exactly like a throwing handler. Each `.new` appends to the chain and returns a **fresh** factory — the receiver is never mutated, so factories branch safely.

```typescript
import { createApp, endpoint, type EndpointGuard } from "@moku-labs/worker";

// Reject unauthenticated requests; otherwise fall through to the handler.
const requireAuth: EndpointGuard = async ({ request }) => {
  const session = await verifySession(request.headers.get("authorization"));
  if (!session) return new Response("Unauthorized", { status: 401 });
};

const authorized = endpoint.new(requireAuth); // bind once, reuse across routes

export const app = createApp({
  pluginConfigs: {
    server: {
      endpoints: [
        endpoint("/health").get(() => new Response("ok")), // unguarded
        authorized("/api/me").get(() => Response.json({ ok: true })), // guarded

        // Chain guards: they run in order (auth, then rate-limit) before the handler.
        authorized.new(rateLimit)("/api/messages").post(handler)
      ]
    }
  }
});
```

Guards run **inside** the matched handler, so the request-lifecycle events are unchanged: `request:start` and `server:matched` fire before the guards, and `request:end` fires after with the final status — including the short-circuit status when a guard rejects.

> A guard only authorizes or rejects: it receives the immutable `RequestContext` and cannot attach typed data to it. Work the handler also needs is derived in the handler (or fetched via `ctx.require`).

### `RequestContext`

The fresh per-request object threaded to every `EndpointHandler`:

| Property | Type | Description |
|---|---|---|
| `request` | `Request` | The incoming Cloudflare `Request`. For cron, a synthesized `https://cron/<cron>` request. |
| `env` | `WorkerEnv` | Per-request Cloudflare bindings. Threaded on the stack, **never** stored in state. |
| `exec` | `ExecutionContext` | `waitUntil` / `passThroughOnException`. |
| `params` | `Params` (typed from the path) | Path params from the matched endpoint: required `{name}` → `string`, optional `{name:?}` → `string \| undefined`. Defaults to `Record<string, string \| undefined>`. |
| `url` | `URL` | Parsed request URL. |
| `require` | `RequireFn` | Cross-plugin reach: `require(plugin)` returns that plugin's api. Mirrors `ctx.require`. |
| `has` | `(name: string) => boolean` | Presence check for an optional plugin by name. |

## Events

`server` is the **producer** of all three request-lifecycle events — it listens to none. All emits are observability only and are fire-and-forget.

| Event | Scope | Payload | When |
|---|---|---|---|
| `request:start` | global (`WorkerEvents`) | `{ method: string; path: string; requestId: string }` | At the very start of `handle`, before matching. `requestId` is a fresh `crypto.randomUUID()`. |
| `server:matched` | per-plugin (`ServerEvents`) | `{ path: string; method: string }` | Immediately after a request matches an endpoint, before the handler runs. Not emitted on a `404`. |
| `request:end` | global (`WorkerEvents`) | `{ method: string; path: string; status: number; ms: number }` | After the handler returns, with the final response status and elapsed milliseconds. |

`server:matched` is the plugin's **own** event, declared via the `register.map<ServerEvents>` callback. Because events are declared before the api factory, `ServerEvents` is inferred into `ctx`, so `ctx.emit("server:matched", { path, method })` is fully typed. `request:start` / `request:end` are global, declared once in `src/config.ts`, and visible to every plugin.

The payload type is exported as `Server.ServerEvents` from the barrel:

```typescript
import type { Server } from "@moku-labs/worker";

type Matched = Server.ServerEvents["server:matched"]; // { path: string; method: string }
```

## Usage

A realistic end-to-end consumer Worker. `createApp` is synchronous, built once per isolate at module load, and frozen.

```typescript
// app.ts
import { createApp, endpoint } from "@moku-labs/worker";

export const app = createApp({
  config: { name: "my-api", stage: "production", compatibilityDate: "2026-06-17" },
  pluginConfigs: {
    server: {
      endpoints: [
        endpoint("/").get(() => new Response("ok")),

        // Required param: /users/42 -> params.id === "42"
        endpoint("/users/{id}").get(({ params }) =>
          Response.json({ id: params.id })
        ),

        // Optional param: /api/data and /api/data/fr both match
        endpoint("/api/data/{lang:?}").get(({ params }) =>
          Response.json({ lang: params.lang ?? "en" })
        ),

        // Body handling
        endpoint("/users").post(async ({ request }) => {
          const body = await request.json();
          return Response.json({ created: body }, { status: 201 });
        }),

        // Hourly cron — registered with .all against the cron expression
        endpoint("0 * * * *").all(async () => new Response("cron done"))
      ]
    }
  }
});
```

```typescript
// worker.ts — the Worker default export is hand-assembled; no primitive exports it.
// fetch / scheduled are Cloudflare runtime callbacks (not Moku lifecycle phases);
// each threads the per-invocation env on the stack.
import { app } from "./app";

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.handle(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.scheduled(controller, env, ctx)
} satisfies ExportedHandler;
```

### Matching rules

The matcher resolves each request to its best endpoint, highest priority first:

1. **Specificity** — more literal segments win (literal `= 2`, required `{name}` `= 1`, optional `{name:?}` `= 0`; summed per path).
2. **Method-specific beats `ALL`** on the same path, as a tie-break.
3. A required `{name}` outscores an optional `{name:?}`.
4. An optional `{name:?}` lets the trailing segment be absent.

Paths are split on `/` and empty segments dropped, so trailing slashes do not change matching. Method comparison is exact and case-sensitive against `request.method`.

## Integration

`server` composes with the binding family by **threading `ctx.require` into every `RequestContext`**, so handlers reach sibling plugin apis with the live request `env`:

```typescript
// app.ts
import { createApp, endpoint, kvPlugin } from "@moku-labs/worker";

export const app = createApp({
  plugins: [kvPlugin],
  pluginConfigs: {
    kv: { binding: "MY_KV" },
    server: {
      endpoints: [
        endpoint("/cache/{key}").get(async ({ params, env, require, has }) => {
          // Optional-plugin branch
          if (!has("kv")) return new Response("kv not configured", { status: 501 });

          // Cross-plugin reach: require(kvPlugin) returns kv's api; env is the request bindings
          const value = await require(kvPlugin).get(env, params.key ?? "");
          return value === null
            ? new Response("miss", { status: 404 })
            : new Response(value);
        })
      ]
    }
  }
});
```

The `depends: [bindingsPlugin]` edge guarantees `bindings` (and therefore any binding plugin that chains off it) is resolved before `server` runs, so `require` from a handler is always safe.

## Design notes

- **Env-per-request threading.** `env` is passed as a call argument to `handle` / `scheduled` and lives only on the call stack inside the `RequestContext`. It is never a field on `ServerState`. One isolate serves concurrent requests; capturing `env` isolate-wide would leak bindings across requests.
- **Response via return value, not `emit`.** Request/response and any awaited cron work flow through the api return value. The kernel cannot carry a value through fire-and-forget events, so `handle`/`scheduled` are api methods — the events are observability only.
- **One-time compilation at `onInit`.** State is the only mutable surface. `createServerState` builds an uncompiled table (`compiled: false`); `onInit` runs `compileServerState`, which sorts the table by specificity and validates that no path contains duplicate `{param}` names. A duplicate throws a `[worker]`-prefixed `Error`. `compiled` guards against a re-entrant init. `match` re-sorts a copy on every call, so it is safe even before `onInit`.
- **Own-event inference.** `server:matched` is declared via the `register.map<ServerEvents>` callback placed **before** the api factory, so the event map is inferred into `ctx` and `ctx.emit("server:matched", …)` is type-checked. Global `request:*` events come from `WorkerEvents`.
- **`RequestContext` is the handler's whole world.** Handlers receive only the per-request context (`request`, `env`, `exec`, `params`, `url`, `require`, `has`) — never the plugin `ctx` or state — keeping them isolated from isolate-wide mutable state.
- **No `onStart` / `onStop`.** Workers are request-scoped: there is no long-lived server to listen on and no resource to tear down. All request setup happens per-request on the stack inside `handle`.
- **No heavy router dependency.** Routing and matching are hand-rolled (no Hono / itty-router); the only ambient types come from the Workers runtime (`Request`, `Response`, `URL`, `ExecutionContext`, `ScheduledController`).

## Exports

| Name | Kind | From |
|---|---|---|
| `serverPlugin` | plugin instance | `@moku-labs/worker` |
| `endpoint` | helper | `@moku-labs/worker` |
| `Server` | type namespace | `@moku-labs/worker` (`Server.RequestContext`, `Server.Endpoint`, `Server.EndpointHandler`, `Server.EndpointGuard`, `Server.ServerConfig`, `Server.ServerEvents`, …) |
| `Endpoint`, `EndpointHandler`, `RequestContext`, `EndpointGuard`, `GuardedEndpointFactory` | types | also re-exported directly from the plugin barrel |
