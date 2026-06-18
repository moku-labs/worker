# bindings

> Standard plugin — stateless resolver over a request-supplied Cloudflare `env` object; the binding-family dependency root.

## Overview

The `bindings` plugin exposes two pure methods for resolving Cloudflare Worker bindings (KV namespaces, R2 buckets, D1 databases, Queues, Durable Object namespaces, secrets, and vars) off the per-request `env` argument. It is a **regular** plugin (not a core plugin) so that downstream binding plugins (`kv`, `d1`, `storage`, `queues`, `durableObjects`) can declare `depends: [bindingsPlugin]` and reach it via `ctx.require(bindingsPlugin)`.

`env` is **never stored** — it is threaded as a call argument on every method. One Cloudflare isolate serves concurrent requests; capturing `env` isolate-wide would leak state across requests.

## API

### `require<T>(env, name): T`

Resolves binding `name` off the request-supplied `env`, narrowed to `T`. Throws a `[moku-worker]`-prefixed `Error` when the binding is `null` or `undefined` (both mean "unbound"). Falsy-but-bound values (`""`, `0`, `false`) are returned as-is and never throw.

```typescript
import type { KVNamespace } from "@cloudflare/workers-types";

export default {
  fetch(request: Request, env: Record<string, unknown>) {
    const kv = app.bindings.require<KVNamespace>(env, "MY_KV");
    // throws [moku-worker] binding "MY_KV" is not bound. if absent
    return new Response("ok");
  },
};
```

### `has(env, name): boolean`

Returns `true` when `name` resolves to a non-nullish value on `env`. Never throws. Use for optional-binding branching.

```typescript
const ok = app.bindings.has(env, "DB"); // false if DB is absent
```

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `required` | `string[]` | `[]` | Binding names downstream plugins assert are present. Read-only after `createApp`. |

```typescript
createApp({
  pluginConfigs: {
    bindings: { required: ["MY_KV", "DB"] }
  }
});
```

## Usage in downstream binding plugins

```typescript
import { bindingsPlugin } from "../bindings";

export const kvPlugin = createPlugin("kv", {
  depends: [bindingsPlugin],
  config: { binding: "MY_KV" },
  api: (ctx) => {
    const ns = (env: WorkerEnv) =>
      ctx.require(bindingsPlugin).require<KVNamespace>(env, ctx.config.binding);
    return { get: (env, key) => ns(env).get(key) };
  }
});
```

## Design notes

- **No state** (F4): `env` is per-request and must not be captured isolate-wide.
- **Regular, not core**: core plugins cannot be `require`/`depends` targets; `bindings` must be regular so the binding family can chain off it.
- **No lifecycle hooks**: Cloudflare Workers are request-scoped; there is no long-lived connection to open or close.
