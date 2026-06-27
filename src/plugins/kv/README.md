# kv

> Micro plugin — thin env-first wrapper over a keyed map of Cloudflare Workers KV namespaces, each resolved per request through the `bindings` plugin.

## Overview

The `kv` plugin exposes a focused key/value surface — `get` / `put` / `delete` / `list` — over a **keyed map** of Cloudflare KV namespaces. The default namespace's methods are mounted directly on `app.kv`, and any configured namespace is selectable by its logical key via `app.kv.use(key)`. A build-time `deployManifest()` reports the plugin's own deploy metadata — one entry per configured namespace. It mounts on `app.kv`.

It is a **regular** plugin (`createPlugin`, not a core plugin) because it must `depends: [bindingsPlugin]` and resolve its namespaces through `ctx.require(bindingsPlugin)` — and core plugins cannot be `require`/`depends` targets. No namespace is ever held: every runtime method takes the per-request Cloudflare `env` as its **first argument**, and the selected instance's namespace is resolved fresh on each call via:

```typescript
ctx.require(bindingsPlugin).require<KVNamespace>(env, pickInstance(ctx.config, key, "kv").binding);
```

One Cloudflare isolate serves concurrent requests, so capturing `env` (or a namespace handle) isolate-wide would leak state across requests. `kv` therefore holds **no state**, registers **no events**, and has **no lifecycle hooks** — it is a pure, request-scoped resolver.

## Configuration

`kv` is configured as a **keyed map** of KV namespace instances — `Config = Record<string, KvInstance>`. Each key is a stable logical id (the one you pass to `app.kv.use(key)`); a single entry, or the one flagged `default: true`, is the implicit default served by the bare `app.kv` methods. The default config is `{}` — you must declare at least one instance.

| Field | Type | Default | Description |
|---|---|---|---|
| `[key]` | `KvInstance` | — | A configured namespace, keyed by its logical id. |
| `[key].name` | `string` | — | Base Cloudflare KV namespace name (stage-suffixed at deploy); surfaced verbatim by `deployManifest()`. |
| `[key].binding` | `string` | — | The Cloudflare binding name resolved off the per-request `env` (e.g. `env.SESSIONS`). |
| `[key].default` | `boolean` | `false` | Marks this instance the default when more than one namespace is configured. |

Config is shallow-merged per top-level key (each `KvInstance` value is replaced wholesale, never deep-merged). Pass it through `createApp`:

```typescript
import { createApp, kvPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [kvPlugin],
  pluginConfigs: {
    kv: {
      sessions: { name: "my-sessions", binding: "SESSIONS" }
    }
  }
});
```

With a single entry, `sessions` is automatically the default. With more than one namespace, mark exactly one `default: true`:

```typescript
kv: {
  sessions: { name: "my-sessions", binding: "SESSIONS", default: true },
  cache: { name: "my-cache", binding: "CACHE" }
}
```

`kv` declares `depends: [bindingsPlugin]`, so `bindings` must be present — but you do **not** list it in your `plugins` array. `bindings` is a framework default (it ships in every `createApp` from `@moku-labs/worker`), so the dependency is already satisfied; adding `bindingsPlugin` yourself would throw `TypeError: [worker] Duplicate plugin name: "bindings"`.

## API

The `app.kv` surface (type `KvApi`). `get` / `put` / `delete` / `list` operate on the **default** namespace; `use(key)` returns the same key/value surface (type `KvNamespaceApi`) bound to any other configured namespace. Every runtime method takes the per-request `env` as its first argument — it is threaded on the stack and never stored. The KV put/list option types (`KVNamespacePutOptions`, `KVNamespaceListOptions`, `KVNamespaceListResult`) come from `@cloudflare/workers-types`.

### `get(env, key)`

```typescript
get(env: WorkerEnv, key: string): Promise<string | null>
```

Reads a value by key from the namespace, returning `null` when the key is absent. Delegates to `KVNamespace.get`. Throws the `[worker]` bindings error if `binding` is not bound on `env`.

```typescript
const value = await app.kv.get(env, "feature-flags");
```

### `put(env, key, value, opts?)`

```typescript
put(
  env: WorkerEnv,
  key: string,
  value: string,
  opts?: KVNamespacePutOptions
): Promise<void>
```

Writes a string value under a key, optionally with KV put options (`expiration`, `expirationTtl`, `metadata`). Delegates to `KVNamespace.put`. Resolves once the write is acknowledged.

```typescript
await app.kv.put(env, "session:1", "data", { expirationTtl: 3600 });
```

### `delete(env, key)`

```typescript
delete(env: WorkerEnv, key: string): Promise<void>
```

Removes a key from the namespace; a no-op if the key is absent. Delegates to `KVNamespace.delete`.

```typescript
await app.kv.delete(env, "session:expired");
```

### `list(env, opts?)`

```typescript
list(
  env: WorkerEnv,
  opts?: KVNamespaceListOptions
): Promise<KVNamespaceListResult<unknown, string>>
```

Lists keys in the namespace, optionally filtered by `prefix`, paginated by `cursor`, or capped by `limit`. Delegates to `KVNamespace.list`.

```typescript
const { keys } = await app.kv.list(env, { prefix: "session:" });
const names = keys.map((k) => k.name);
```

### `use(key)`

```typescript
use(key: string): KvNamespaceApi
```

Selects a configured namespace by its logical key, returning the `get` / `put` / `delete` / `list` surface bound to that namespace. The bare `app.kv` methods are exactly `use(defaultKey)`. Throws a `[worker]`-prefixed error (listing the configured keys) if `key` is not configured. The lookup is lazy — an unconfigured key only errors when a method is actually called.

```typescript
await app.kv.use("cache").put(env, "page:home", html, { expirationTtl: 60 });
const html = await app.kv.use("cache").get(env, "page:home");
```

### `deployManifest()`

```typescript
deployManifest(): Array<{ kind: "kv"; name: string; binding: string }>
```

Returns this plugin's **own** deploy metadata — **one entry per configured namespace**. Takes **no `env`** — it is build-time metadata, not a runtime KV operation. The deploy plugin reads it via `ctx.require(kvPlugin).deployManifest()`; it never inspects sibling `pluginConfigs` (a plugin sees only `ctx.global` plus its own `ctx.config`, and `require` returns a plugin's api, not its config).

```typescript
const manifest = app.kv.deployManifest();
// => [{ kind: "kv", name: "my-sessions", binding: "SESSIONS" }]
```

## Events

**None.** The `kv` plugin emits no events and registers no event hooks (it neither listens for nor reacts to any global or sibling-plugin events). KV reads/writes are request/response work expressed as awaited api methods, not observability signals.

## Usage

A realistic end-to-end session store inside `server` endpoint handlers. Each handler receives a fresh per-request `RequestContext` carrying `env` and `require`, so it reaches `app.kv` via `require(kvPlugin)` and threads `env` through:

```typescript
import { createApp, endpoint, kvPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [kvPlugin],
  pluginConfigs: {
    kv: {
      sessions: { name: "my-sessions", binding: "SESSIONS" }
    },
    server: {
      endpoints: [
        endpoint("/session/{id}").get(async ({ params, env, require }) => {
          const value = await require(kvPlugin).get(env, params.id ?? "");
          return value ? new Response(value) : new Response(null, { status: 404 });
        }),

        endpoint("/session/{id}").put(async ({ params, request, env, require }) => {
          await require(kvPlugin).put(env, params.id ?? "", await request.text(), {
            expirationTtl: 3600
          });
          return new Response(null, { status: 204 });
        }),

        endpoint("/session/{id}").delete(async ({ params, env, require }) => {
          await require(kvPlugin).delete(env, params.id ?? "");
          return new Response(null, { status: 204 });
        }),

        endpoint("/sessions").get(async ({ env, require }) => {
          const { keys } = await require(kvPlugin).list(env, { prefix: "session:" });
          return Response.json(keys.map((k) => k.name));
        })
      ]
    }
  }
});

export default {
  fetch(request: Request, env: Record<string, unknown>, exec: ExecutionContext) {
    return app.server.handle(request, env, exec);
  }
};
```

Direct access outside a handler is possible but rare — it still requires a live request `env`:

```typescript
const flags = await app.kv.get(env, "feature-flags");
```

## Integration

- **`bindings`** — `kv`'s sole dependency and the reason it is a regular plugin. On every api call, `kv` resolves the selected instance's namespace with `ctx.require(bindingsPlugin).require<KVNamespace>(env, pickInstance(ctx.config, key, "kv").binding)`. If that `binding` is `null`/`undefined` on `env`, the bindings resolver throws a `[worker]`-prefixed error naming the missing binding. `bindings` is a framework default, so the `depends: [bindingsPlugin]` requirement is satisfied automatically — you never add `bindingsPlugin` to your `plugins` array.
- **`server`** — handlers receive `env` and `require` on the per-request `RequestContext`; they reach `kv` through `require(kvPlugin)` and thread `env` into each call. `kv` never imports `server` — the coupling is one-way, through the handler context.
- **deploy** — the deploy plugin calls `app.kv.deployManifest()` to collect one `{ kind: "kv", name, binding }` per configured namespace, without reading `kv`'s config directly.

## Design notes

- **Env per request, never captured** — KV namespaces, like all Cloudflare bindings, only exist inside the request stack frame. `env` is the first argument of every runtime method and is resolved fresh on each call; the plugin holds no handle and no state, so concurrent requests on one isolate can never leak each other's namespace.
- **No state** — `createState` is omitted; the plugin runs on the default empty `{}` state, and its context types the state slot as `Record<string, never>`.
- **No lifecycle hooks** — Workers are request-scoped: there is nothing to compile or warm at isolate init and no long-lived connection to open or close, so `onInit` / `onStart` / `onStop` are all absent.
- **Micro tier** — a keyed-map config and a handful of thin delegating methods (`get` / `put` / `delete` / `list`, plus the `use(key)` selector and build-time `deployManifest()`), well under the tier's size budget. The implementation is split across `index.ts` (wiring) and `api.ts` (the api factory) purely to keep the wiring file within the ≤30-effective-line skeleton rule; there is no `types.ts` or `state.ts`. The keyed-map default/`use` resolution is shared with the sibling resource plugins via `bindings/instances.ts` (`defaultInstanceKey` / `pickInstance`).
- **`deployManifest()` is build-time** — it is the one method that takes no `env`, because it reports static deploy metadata rather than performing a runtime KV operation.
