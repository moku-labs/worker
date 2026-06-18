# durable-objects

> Standard plugin — resolves Cloudflare Durable Object stubs off a request-supplied `env`, ships the `defineDurableObject` base-class helper, and surfaces its own deploy metadata.

## Overview

The `durableObjects` plugin does two distinct jobs and ships one helper.

1. **Runtime stub access** — `get(env, logicalName, idName)` resolves a `DurableObjectNamespace` off the per-request `env` (mapping a logical name to the configured Cloudflare binding name via `config.bindings`), derives a stable id with `idFromName(idName)`, and returns the addressed `DurableObjectStub`.
2. **Build metadata** — `deployManifest()` returns `{ kind: "do", bindings }`, this plugin's **own** deploy metadata, read by the `deploy` plugin via `ctx.require(durableObjectsPlugin)` (never by reading sibling `pluginConfigs`).
3. **`defineDurableObject(name)` helper** — a pure factory that returns a **base class** the consumer `extends` and exports from `worker.ts`. A Moku plugin can only produce values/APIs, never a top-level exported class, so the plugin never generates the class — the consumer owns it; the plugin manages config, bindings, and stubs.

It is a **regular** plugin (`createPlugin("durableObjects", …)`), not a core plugin, because it must `depends: [bindingsPlugin]` and call `ctx.require(bindingsPlugin)` to resolve a namespace off the request `env` — which a core plugin cannot do. `env` is **never stored** in plugin state: one Cloudflare isolate serves concurrent requests, so `env` is threaded as a call argument so concurrent invocations never collide.

The runtime plugin instance, the `defineDurableObject` helper, and the `DurableObjects` type namespace are all importable from `@moku-labs/worker`. The Cloudflare DO types (`DurableObjectNamespace`, `DurableObjectStub`, `DurableObjectState`, `DurableObjectId`) are ambient globals from `@cloudflare/workers-types` — used unqualified, never imported.

```typescript
import { createApp, defineDurableObject, durableObjectsPlugin } from "@moku-labs/worker";
import type { DurableObjects } from "@moku-labs/worker";
```

## Configuration

Flat config (shallow merge for regular plugins). A consumer overriding `bindings` replaces the **whole** map, not a nested key. The default is complete (`{}`) so omission never yields `undefined`, and the resolved config is frozen after `createApp` — the api reads `ctx.config.bindings` but never mutates it.

| Field | Type | Default | Description |
|---|---|---|---|
| `bindings` | `Record<string, string>` | `{}` | Maps a **logical** name (used in code, e.g. `"counter"`) to the Cloudflare DO binding name (declared in wrangler config / present on the per-request `env`, e.g. `"COUNTER"`). Consumed by `get()` to resolve the namespace and surfaced verbatim by `deployManifest()`. A logical name absent from this map falls back to itself. |

Config is supplied under the `durableObjects` key of `pluginConfigs`. The plugin `depends: [bindingsPlugin]`, but `bindings` is a framework default (auto-wired by `createApp`), so the edge is always satisfied without the consumer listing `bindingsPlugin`.

```typescript
import { createApp, durableObjectsPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [durableObjectsPlugin],
  pluginConfigs: {
    durableObjects: { bindings: { counter: "COUNTER" } }
  }
});
```

## API

Built by `createDoApi(ctx)` and mounted on `app.durableObjects` (regular plugins mount on `app.<name>`). Handlers reach it via the threaded `require(durableObjectsPlugin)`. The runtime method takes the per-request `env` (`WorkerEnv`) as its first argument — env is threaded, never stored.

### `get(env, logicalName, idName)`

```typescript
get(env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub
```

Resolves the `DurableObjectNamespace` for `logicalName` off the per-request `env` (mapping `logicalName` to `config.bindings[logicalName]`, falling back to `logicalName` itself when unmapped), derives a deterministic id with `namespace.idFromName(idName)`, and returns the addressed `DurableObjectStub`.

- **Synchronous** — returns a stub directly, not a `Promise`. The stub is the handle on which the caller then invokes `.fetch(...)`.
- The namespace is resolved via `ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, binding)` — the spec-correct cross-plugin pull.
- **Throws** (via the bindings resolver) a `[moku-worker]`-prefixed `Error` when the binding is not present on `env`.

```typescript
// In a server endpoint handler — pull the api the spec way, pass the request env:
endpoint("/count/{room}").get(({ params, env, require }) =>
  require(durableObjectsPlugin).get(env, "counter", params.room!).fetch("https://do/")
);

// Direct consumer access (rare, outside a handler — still needs a request env):
const stub = app.durableObjects.get(env, "counter", "room-42");
const res = await stub.fetch("https://do/increment");
```

### `deployManifest()`

```typescript
deployManifest(): DeployManifest // { kind: "do"; bindings: Record<string, string> }
```

Returns this plugin's **own** deploy metadata. Takes no `env` — it is build-time metadata, not a runtime DO operation. Pure synchronous read of `ctx.config.bindings`. The `deploy` plugin reads it via `ctx.require(durableObjectsPlugin).deployManifest()`; it never reads sibling `pluginConfigs` (a plugin sees only `ctx.global` plus its own `ctx.config`, and `require` returns a plugin's api, not its config).

```typescript
const manifest = app.durableObjects.deployManifest();
// → { kind: "do", bindings: { counter: "COUNTER" } }
```

## `defineDurableObject` helper

```typescript
defineDurableObject(name: string): DurableObjectBaseConstructor & { readonly doName: string }
```

A **pure static factory** mounted on `durableObjectsPlugin.helpers` and re-exported at the package top level as `defineDurableObject`. It runs **before** `createApp`, takes no `ctx`, has no side effects, and returns a **base class** the consumer `extends` and exports from `worker.ts`. The plugin never generates the final exported class — the consumer owns that class; the plugin only manages config, bindings, and stubs.

What the returned base class provides:

- A constructor with Cloudflare's required `DurableObject` signature: `(ctx: DurableObjectState, env: WorkerEnv)`. It stores them as readonly `this.ctx` (the `DurableObjectState` — Cloudflare's per-object storage/alarm context) and `this.env` (the per-request bindings). `this.env` mirrors the env passed at construction time and is never cached across requests.
- A static `doName` property capturing `name` for diagnostics and binding correlation.

The consumer's subclass implements `fetch` (and optionally `alarm`). The helper is **pure** — it constructs no instances and reads no plugin state; it merely returns a class definition. Calling it twice yields two independent classes.

```typescript
// src/counter.ts — the DO class is an ordinary EXPORTED class built on the helper base.
import { defineDurableObject } from "@moku-labs/worker";

export class Counter extends defineDurableObject("Counter") {
  async fetch(): Promise<Response> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}
```

The class is exported **alongside** the default Worker export so the Cloudflare runtime can instantiate it:

```typescript
// src/worker.ts
import { app } from "./app";

export { Counter } from "./counter";

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.handle(request, env, ctx)
} satisfies ExportedHandler;
```

> The base class implements the `DurableObjectBase` contract — `{ readonly ctx: DurableObjectState; readonly env: WorkerEnv }`. You rarely reference `DurableObjectBase` / `DurableObjectBaseConstructor` directly; `extends defineDurableObject("Name")` infers everything.

## Events

**None.** This plugin declares no per-plugin events, emits none, and listens to none — it is a leaf accessor. (The framework's only plugin-local events are `server:matched` and `queue:message`; everything else flows through the global events declared in `src/config.ts` — `request:start` / `request:end`, `deploy:phase` / `deploy:complete`, `provision:resource`.)

A Cloudflare Durable Object `alarm()` runs in an **isolated runtime** with no access to the Moku `ctx` or `emit` — it executes inside the DO's own isolate, not the Worker isolate that owns `app`. A `do:alarm` event could therefore never be emitted on the Moku bus. **DO alarm observability is the consumer's concern** (external telemetry written inside the consumer's `alarm()` method), not the Moku event bus.

## Types

The plugin's types are re-exported from the package barrel as the `DurableObjects` namespace (`import type { DurableObjects } from "@moku-labs/worker"`):

| Type | Shape | Notes |
|---|---|---|
| `DurableObjects.Config` | `{ bindings: Record<string, string> }` | The plugin config. Also re-exported flat as `Config` from the plugin module. |
| `DurableObjects.DeployManifest` | `{ kind: "do"; bindings: Record<string, string> }` | Return type of `deployManifest()`. `kind` is the literal `"do"`. |
| `DurableObjects.Api` | `{ get(...): DurableObjectStub; deployManifest(): DeployManifest }` | The full `app.durableObjects` surface. |
| `DurableObjects.Ctx` | `PluginCtx<Config, Record<string, never>, WorkerEvents>` | Internal plugin context — own config first, no state, global events. |

The `defineDurableObject` helper's structural types — `DurableObjectBase` (`{ readonly ctx: DurableObjectState; readonly env: WorkerEnv }`) and `DurableObjectBaseConstructor` — live in the plugin's `helpers.ts`. Only the `defineDurableObject` value is re-exported at the package top level; you typically never name these types directly, since `extends defineDurableObject(...)` infers them.

## Usage

End-to-end: define a DO class with the helper, wire the plugin, and reach the stub from a `server` fetch handler.

```typescript
// src/counter.ts — author the Durable Object class on the helper base.
import { defineDurableObject } from "@moku-labs/worker";

export class Counter extends defineDurableObject("Counter") {
  async fetch(): Promise<Response> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}
```

```typescript
// src/app.ts — wire durableObjects, map the logical name to the CF binding.
// bindings + server are auto-wired by the framework — do not list them in `plugins`.
import { createApp, durableObjectsPlugin, endpoint } from "@moku-labs/worker";

export const app = createApp({
  plugins: [durableObjectsPlugin],
  pluginConfigs: {
    durableObjects: { bindings: { counter: "COUNTER" } },
    server: {
      endpoints: [
        endpoint("/count/{room}").get(({ params, env, require }) =>
          require(durableObjectsPlugin).get(env, "counter", params.room!).fetch("https://do/increment")
        )
      ]
    }
  }
});
```

```typescript
// src/worker.ts — export the DO class alongside the Worker default export.
import { app } from "./app";

export { Counter } from "./counter";

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.handle(request, env, ctx)
} satisfies ExportedHandler;
```

A request to `/count/room-42` resolves the `COUNTER` namespace off `env`, addresses the `Counter` instance keyed by `idFromName("room-42")`, forwards the fetch, and returns the DO's incremented count.

> The `server` config shape (`pluginConfigs.server.endpoints`, the `endpoint` builder) is owned by the `server` plugin — see its README for the authoritative request layer. The durableObjects-relevant part is the handler body: `require(durableObjectsPlugin).get(env, …)`.

## Integration

- **`bindings`** — the hard dependency. Listed in `depends: [bindingsPlugin] as const` so bindings is guaranteed registered first and `ctx.require(bindingsPlugin)` is typed. `get()` resolves namespaces through `ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, binding)`. If a binding is unbound on `env`, the bindings resolver throws the `[moku-worker]`-prefixed error.
- **`server`** — the request layer threads `env` and `require` into each endpoint handler; that is where you call `require(durableObjectsPlugin).get(env, …)`. The plugin never owns a request; it is reached per-request through the server.
- **`deploy`** — reads `deployManifest()` via `ctx.require(durableObjectsPlugin)` to declare `durable_objects` bindings (and the corresponding migrations) in wrangler config. The logical-to-binding map you put in `config.bindings` is exactly what `deployManifest()` surfaces, so the same map drives both runtime resolution and the generated wrangler bindings.

## Design notes

- **Env per request (SB4):** `env` arrives per `fetch` / `queue` / `scheduled` call and is threaded as a call argument, never cached on the plugin. One isolate serves concurrent requests, so capturing an `env` (or a namespace handle off it) isolate-wide would risk cross-request leakage. The plugin is therefore stateless (`createState` omitted; state type `Record<string, never>`).
- **Ambient DO globals:** `DurableObjectNamespace`, `DurableObjectStub`, `DurableObjectState`, and `DurableObjectId` are ambient from `@cloudflare/workers-types` (the Cloudflare Workers platform itself) — they are used unqualified and never imported. No new runtime npm dependency is added.
- **Standard tier:** the plugin carries a domain `api.ts` (`get` / `deployManifest`) plus a `helpers.ts` (`defineDurableObject`), which puts it above the single-file Micro tier. It still declares no events, no state, and no lifecycle hooks (`onInit` / `onStart` / `onStop` all unused) — Cloudflare Workers are request-scoped, so there is no isolate-wide table to compile and no long-lived connection to open or close.
- **Spec boundary #1:** a Moku plugin produces values/APIs, never a top-level exported class. `defineDurableObject` is the closest-legal expression: a pure helper returning a base class the consumer extends and exports. The plugin manages config, bindings, and stubs; the consumer owns the exported class.
