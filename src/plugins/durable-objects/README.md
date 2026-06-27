# durable-objects

> Standard plugin — resolves Cloudflare Durable Object stubs off a request-supplied `env`, ships the `defineDurableObject` base-class helper, and surfaces its own deploy metadata.

## Overview

The `durableObjects` plugin does two distinct jobs and ships one helper.

1. **Runtime stub access** — `get(env, logicalName, idName)` resolves a `DurableObjectNamespace` off the per-request `env` (selecting the configured instance by its logical key, then resolving that instance's Cloudflare `binding`), derives a stable id with `idFromName(idName)`, and returns the addressed `DurableObjectStub`.
2. **Build metadata** — `deployManifest()` returns one `{ kind: "do", binding, className }` per configured instance — this plugin's **own** deploy metadata, read by the `deploy` plugin via `ctx.require(durableObjectsPlugin)` (never by reading sibling `pluginConfigs`).
3. **`defineDurableObject(name)` helper** — a pure factory that returns a **base class** the consumer `extends` and exports from `worker.ts`. A Moku plugin can only produce values/APIs, never a top-level exported class, so the plugin never generates the class — the consumer owns it; the plugin manages config, bindings, and stubs.

It is a **regular** plugin (`createPlugin("durableObjects", …)`), not a core plugin, because it must `depends: [bindingsPlugin]` and call `ctx.require(bindingsPlugin)` to resolve a namespace off the request `env` — which a core plugin cannot do. `env` is **never stored** in plugin state: one Cloudflare isolate serves concurrent requests, so `env` is threaded as a call argument so concurrent invocations never collide.

The runtime plugin instance, the `defineDurableObject` helper, and the `DurableObjects` type namespace are all importable from `@moku-labs/worker`. The Cloudflare DO types (`DurableObjectNamespace`, `DurableObjectStub`, `DurableObjectState`, `DurableObjectId`) are ambient globals from `@cloudflare/workers-types` — used unqualified, never imported.

```typescript
import { createApp, defineDurableObject, durableObjectsPlugin } from "@moku-labs/worker";
import type { DurableObjects } from "@moku-labs/worker";
```

## Configuration

`durableObjects` is configured as a **keyed map** of Durable Object instances — `Config = Record<string, DoInstance>`. Each key is the stable **logical name** you pass to `app.durableObjects.get(env, logicalName, idName)`; `get` always selects an instance by that explicit logical name. The default config is `{}` — declare at least one instance. Unlike the other resource plugins, a DO instance has **no provisioned `name`** (Durable Objects ship with the Worker script rather than being created up front); it carries the env `binding` and the exported `className` instead. Config is shallow-merged per top-level key (each `DoInstance` value is replaced wholesale) and frozen after `createApp`.

| Field | Type | Default | Description |
|---|---|---|---|
| `[key]` | `DoInstance` | — | A configured Durable Object, keyed by its logical name. |
| `[key].binding` | `string` | — | The Cloudflare DO binding name (declared in wrangler config / present on the per-request `env`, e.g. `"COUNTER"`). Consumed by `get()` to resolve the namespace and surfaced by `deployManifest()`. |
| `[key].className` | `string` | — | The **exported** Durable Object class name (e.g. `"Counter"`) — the class the consumer `extends defineDurableObject(...)` and exports from `worker.ts`. Surfaced by `deployManifest()` and written into the generated wrangler `durable_objects` binding (`class_name`) and migration. Decoupled from the logical key, so the key and the class may differ. |
| `[key].default` | `boolean` | `false` | Accepted for shape-consistency with the sibling resource plugins. `get` always selects by explicit logical name, so it picks no implicit default here. |

Config is supplied under the `durableObjects` key of `pluginConfigs`. The plugin `depends: [bindingsPlugin]`, but `bindings` is a framework default (auto-wired by `createApp`), so the edge is always satisfied without the consumer listing `bindingsPlugin`.

```typescript
import { createApp, durableObjectsPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [durableObjectsPlugin],
  pluginConfigs: {
    durableObjects: {
      counter: { binding: "COUNTER", className: "Counter" }
    }
  }
});
```

Configure multiple Durable Objects by adding more keys; each is addressed by its logical key — `get(env, "counter", id)` / `get(env, "board", id)`:

```typescript
durableObjects: {
  counter: { binding: "COUNTER", className: "Counter" },
  board: { binding: "BOARD", className: "BoardChannel" }
}
```

## API

Built by `createDoApi(ctx)` and mounted on `app.durableObjects` (regular plugins mount on `app.<name>`). Handlers reach it via the threaded `require(durableObjectsPlugin)`. The runtime method takes the per-request `env` (`WorkerEnv`) as its first argument — env is threaded, never stored.

### `get(env, logicalName, idName)`

```typescript
get(env: WorkerEnv, logicalName: string, idName: string): DurableObjectStub
```

Resolves the `DurableObjectNamespace` for `logicalName` off the per-request `env` — selecting the configured instance by its logical key (`pickInstance`) and resolving that instance's `binding` — derives a deterministic id with `namespace.idFromName(idName)`, and returns the addressed `DurableObjectStub`.

- **Synchronous** — returns a stub directly, not a `Promise`. The stub is the handle on which the caller then invokes `.fetch(...)`.
- The namespace is resolved via `ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, pickInstance(ctx.config, logicalName, "durableObjects").binding)` — the spec-correct cross-plugin pull.
- **Throws** a `[worker]`-prefixed `Error` when `logicalName` is not a configured key (listing the configured keys), or — via the bindings resolver — when the instance's `binding` is not present on `env`.

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
deployManifest(): Array<{ kind: "do"; binding: string; className: string }>
```

Returns this plugin's **own** deploy metadata — **one entry per configured instance**. Takes no `env` — it is build-time metadata, not a runtime DO operation. Pure synchronous read of `ctx.config`. The `deploy` plugin reads it via `ctx.require(durableObjectsPlugin).deployManifest()`; it never reads sibling `pluginConfigs` (a plugin sees only `ctx.global` plus its own `ctx.config`, and `require` returns a plugin's api, not its config).

```typescript
const manifest = app.durableObjects.deployManifest();
// → [{ kind: "do", binding: "COUNTER", className: "Counter" }]
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

> **Config `className` must equal the exported class identifier.** The `counter` instance in `pluginConfigs.durableObjects` declares `className: "Counter"`, so the consumer must export a class named `Counter` (as above). The generated wrangler `durable_objects` binding (`class_name`) and migration reference that exact identifier; the string passed to `defineDurableObject("Counter")` is only the diagnostic `doName`.

> The base class implements the `DurableObjectBase` contract — `{ readonly ctx: DurableObjectState; readonly env: WorkerEnv }`. You rarely reference `DurableObjectBase` / `DurableObjectBaseConstructor` directly; `extends defineDurableObject("Name")` infers everything.

## Events

**None.** This plugin declares no per-plugin events, emits none, and listens to none — it is a leaf accessor. (The framework's only plugin-local events are `server:matched` and `queue:message`; everything else flows through the global events declared in `src/config.ts` — `request:start` / `request:end`, `deploy:phase` / `deploy:complete`, `provision:resource`.)

A Cloudflare Durable Object `alarm()` runs in an **isolated runtime** with no access to the Moku `ctx` or `emit` — it executes inside the DO's own isolate, not the Worker isolate that owns `app`. A `do:alarm` event could therefore never be emitted on the Moku bus. **DO alarm observability is the consumer's concern** (external telemetry written inside the consumer's `alarm()` method), not the Moku event bus.

## Types

The plugin's types are re-exported from the package barrel as the `DurableObjects` namespace (`import type { DurableObjects } from "@moku-labs/worker"`):

| Type | Shape | Notes |
|---|---|---|
| `DurableObjects.Config` | `Record<string, DoInstance>` | The plugin config — a keyed map of DO instances. Also re-exported flat as `Config` from the plugin module. |
| `DurableObjects.DoInstance` | `{ binding: string; className: string; default?: boolean }` | One configured Durable Object (a single map entry). |
| `DurableObjects.Api` | `{ get(...): DurableObjectStub; deployManifest(): Array<{ kind: "do"; binding; className }> }` | The full `app.durableObjects` surface. `kind` is the literal `"do"`. |
| `DurableObjects.Ctx` | `PluginCtx<Config, Record<string, never>, WorkerEvents>` intersected with a narrow `require(bindingsPlugin)` | Internal API-factory context — own config first, no state, global events; not needed by consumers. |

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
// src/app.ts — wire durableObjects: map the logical name to the CF binding + exported class.
// bindings + server are auto-wired by the framework — do not list them in `plugins`.
import { createApp, durableObjectsPlugin, endpoint } from "@moku-labs/worker";

export const app = createApp({
  plugins: [durableObjectsPlugin],
  pluginConfigs: {
    durableObjects: {
      counter: { binding: "COUNTER", className: "Counter" }
    },
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

- **`bindings`** — the hard dependency. Listed in `depends: [bindingsPlugin] as const` so bindings is guaranteed registered first and `ctx.require(bindingsPlugin)` is typed. `get()` resolves namespaces through `ctx.require(bindingsPlugin).require<DurableObjectNamespace>(env, binding)`. If a binding is unbound on `env`, the bindings resolver throws the `[worker]`-prefixed error.
- **`server`** — the request layer threads `env` and `require` into each endpoint handler; that is where you call `require(durableObjectsPlugin).get(env, …)`. The plugin never owns a request; it is reached per-request through the server.
- **`deploy`** — reads `deployManifest()` via `ctx.require(durableObjectsPlugin)` to declare `durable_objects` bindings (`{ name: binding, class_name: className }`) and the corresponding `migrations` (registering each `className` as a SQLite-backed class) in wrangler config. The `binding` / `className` on each instance is exactly what `deployManifest()` surfaces, so the same config drives both runtime resolution and the generated wrangler bindings.

## Design notes

- **Env per request (SB4):** `env` arrives per `fetch` / `queue` / `scheduled` call and is threaded as a call argument, never cached on the plugin. One isolate serves concurrent requests, so capturing an `env` (or a namespace handle off it) isolate-wide would risk cross-request leakage. The plugin is therefore stateless (`createState` omitted; state type `Record<string, never>`).
- **Ambient DO globals:** `DurableObjectNamespace`, `DurableObjectStub`, `DurableObjectState`, and `DurableObjectId` are ambient from `@cloudflare/workers-types` (the Cloudflare Workers platform itself) — they are used unqualified and never imported. No new runtime npm dependency is added.
- **Standard tier:** the plugin carries a domain `api.ts` (`get` / `deployManifest`) plus a `helpers.ts` (`defineDurableObject`), which puts it above the single-file Micro tier. It still declares no events, no state, and no lifecycle hooks (`onInit` / `onStart` / `onStop` all unused) — Cloudflare Workers are request-scoped, so there is no isolate-wide table to compile and no long-lived connection to open or close.
- **Spec boundary #1:** a Moku plugin produces values/APIs, never a top-level exported class. `defineDurableObject` is the closest-legal expression: a pure helper returning a base class the consumer extends and exports. The plugin manages config, bindings, and stubs; the consumer owns the exported class.
