# storage

> Complex plugin — Cloudflare R2 object storage behind a provider adapter seam; env-first runtime API plus a build-time deploy manifest.

## Overview

The `storage` plugin is the R2 object-storage member of the binding family. It exposes an **env-first** runtime API — `get` / `put` / `delete` / `list` — that resolves an `R2Bucket` binding **per request** off the request-supplied `env`, plus a build-time `deployManifest()` that hands the `deploy` plugin this plugin's own R2 metadata.

It is a **regular** plugin (`createPlugin("storage", ...)`), not a core plugin, so it can declare `depends: [bindingsPlugin]` and resolve the bucket through `ctx.require(bindingsPlugin)`. Core plugins cannot be `require`/`depends` targets, which is the sole reason `storage` is regular rather than core.

What makes it **Complex** is the **provider adapter seam**: every method delegates to a `StorageProvider` rather than touching `R2Bucket` directly. Two implementations sit behind one interface — the real R2-backed provider and an in-memory test double — so handlers and the plugin can be unit- and integration-tested without a live R2 binding. The public API signatures are identical regardless of which provider is in play.

The plugin holds **no state** and emits **no events**. `env` is never stored — one Cloudflare isolate serves concurrent requests, so capturing a per-request binding isolate-wide would leak it across requests.

## Configuration

Both fields are **flat** (no nested objects) so a consumer's partial override via `pluginConfigs.storage` never drops a sibling key under shallow merge. Defaults are complete, so an omitted field never resolves to `undefined`.

| Field | Type | Default | Description |
|---|---|---|---|
| `upload` | `string` | `""` | Directory uploaded to the R2 bucket at deploy time. **Deploy metadata only** — surfaced to the `deploy` plugin via `deployManifest()`; never read by the runtime API. `""` means "upload nothing". |
| `bucket` | `string` | `"ASSETS"` | Name of the `R2Bucket` binding resolved off the per-request `env` (e.g. `env.ASSETS`). |

```typescript
import { createApp, storagePlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [storagePlugin],
  pluginConfigs: {
    storage: { upload: "./public", bucket: "ASSETS" }
  }
});
```

`storage` declares `depends: [bindingsPlugin]`, but you do **not** list `bindingsPlugin` in your `plugins` array: `bindings` is a framework default shipped by every `createApp` from `@moku-labs/worker`, so the dependency is already satisfied. Adding it yourself throws `TypeError: [worker] Duplicate plugin name: "bindings"`.

## API

`storage` is a regular plugin, so its API is reached via `app.storage` or, inside a handler, `require(storagePlugin)` — never injected flat on `ctx.storage`.

All four runtime methods are **env-first**: the per-request `env` (the Cloudflare bindings object) is the first argument, threaded in from `app.server.handle(request, env, exec)` through the request context. Each call resolves the bucket fresh via the provider adapter — the binding is never cached across calls. `deployManifest()` is the one exception: it is build-time only and reads `ctx.config`, never `env` or R2.

### `get(env, key): Promise<R2ObjectBody | null>`

Reads object `key` from the bucket. Resolves to the `R2ObjectBody` (whose `.body` is a `ReadableStream`), or `null` when the key is absent. Rejects if the bucket binding is missing on `env` (the `[worker]`-prefixed error from `bindings.require`).

```typescript
const body = await app.storage.get(env, "assets/logo.png");
return body ? new Response(body.body) : new Response(null, { status: 404 });
```

### `put(env, key, value): Promise<R2Object>`

Writes `value` to the bucket under `key` and resolves the written object's `R2Object` metadata. `value` is `ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null`, so a request body stream can be piped straight through. Rejects if the bucket binding is missing on `env`.

```typescript
const obj = await app.storage.put(env, "assets/logo.png", request.body);
// obj.key, obj.size, obj.etag, ...
```

### `delete(env, key): Promise<void>`

Removes object `key` from the bucket. `key` may be a single string or an array of keys for a batch delete. Absent keys are a no-op (no error). Rejects if the bucket binding is missing on `env`.

```typescript
await app.storage.delete(env, "assets/old.png");
await app.storage.delete(env, ["assets/a.png", "assets/b.png"]);
```

### `list(env, opts?): Promise<R2Objects>`

Lists objects, optionally filtered by `R2ListOptions` (`prefix`, `limit`, `cursor`, `delimiter`). Resolves the `R2Objects` result — `.objects` is the page of `R2Object` metadata, `.truncated` signals more pages, `.cursor` continues them. Rejects if the bucket binding is missing on `env`.

```typescript
const { objects, truncated } = await app.storage.list(env, { prefix: "images/", limit: 100 });
const keys = objects.map((o) => o.key);
```

### `deployManifest(): StorageManifest`

Returns this plugin's **own** deploy metadata — `{ kind: "r2", bucket, upload }` read from `ctx.config`. **Build-time only**: it never touches `env` or R2, so it is safe to call outside a request. The `deploy` plugin consumes it via `ctx.require(storagePlugin).deployManifest()` to learn which bucket to provision and which directory to upload.

```typescript
const manifest = app.storage.deployManifest();
// → { kind: "r2", bucket: "ASSETS", upload: "./public" }
```

## Events

**None.** `storage` emits no plugin events and listens to none. Deploy-time upload progress is the responsibility of the `deploy` plugin, which emits the **global** `deploy:phase` event (declared in `WorkerEvents`) — not `storage`. The `events` field is omitted from the `createPlugin` call entirely.

## Types

The plugin's types are re-exported from the package barrel under the `Storage` namespace (`export * as Storage from "./storage/types"`), so consumers reach them as `Storage.StorageApi`, `Storage.StorageConfig`, and so on.

| Type | Shape | Notes |
|---|---|---|
| `StorageApi` | `{ get, put, delete, list, deployManifest }` | The public env-first surface (the type of `app.storage`). |
| `StorageConfig` | `{ upload: string; bucket: string }` | Flat config with complete defaults. |
| `StorageManifest` | `{ readonly kind: "r2"; readonly bucket: string; readonly upload: string }` | Build-time deploy metadata returned by `deployManifest()`. `kind` is the `"r2"` discriminant the `deploy` plugin matches on. |
| `StorageProvider` | `{ get, put, delete, list }` | The adapter seam — the **key-first** internal interface both providers implement. Re-exported for handlers that want to type a provider directly. |

R2 types (`R2Bucket`, `R2Object`, `R2ObjectBody`, `R2Objects`, `R2ListOptions`) are **ambient globals** from `@cloudflare/workers-types` (configured via tsconfig `types`). They are used unqualified throughout and are **never imported** — and never re-exported by this plugin.

`StorageCtx` (internal) is `PluginCtx<StorageConfig, Record<string, never>, WorkerEvents>` intersected with a narrow `require` typed to the single dependency `storage` resolves (`bindingsPlugin`). Empty state is `Record<string, never>` — there is no plugin state.

## Usage

A `server` fetch handler that serves objects on `GET` and stores them on `PUT`, pulling the storage API on demand. `env` is threaded from the runtime entry point into `app.server.handle` and reaches the handler via the request context.

```typescript
import { createApp, endpoint, storagePlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [storagePlugin],
  pluginConfigs: {
    storage: { upload: "./public", bucket: "ASSETS" },
    server: {
      endpoints: [
        endpoint("/assets/{key}").get(async ({ params, env, require }) => {
          const obj = await require(storagePlugin).get(env, params.key!);
          return obj ? new Response(obj.body) : new Response(null, { status: 404 });
        }),

        endpoint("/assets/{key}").put(async ({ params, request, env, require }) => {
          await require(storagePlugin).put(env, params.key!, request.body);
          return new Response(null, { status: 201 });
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

## Integration

- **`bindings`** — the hard dependency. `storage` resolves its `R2Bucket` through `ctx.require(bindingsPlugin).require<R2Bucket>(env, ctx.config.bucket)` on every call. `bindings` is a framework default, so this `depends: [bindingsPlugin]` requirement is satisfied automatically — do not add `bindingsPlugin` to your `plugins` array (it would throw a duplicate-plugin-name `TypeError`).
- **`server`** — the typical caller. Handlers receive `env` and `require` on their context and pull `require(storagePlugin)` to serve or store objects, as in the Usage example above. `storage` does not depend on `server` — it is a passive resource any handler can use.
- **`deploy`** — the build-time consumer of `deployManifest()`. When the `deploy` plugin is present it reads `{ kind: "r2", bucket, upload }` to know which R2 bucket to provision and which `upload` directory to push at deploy time. `storage` never reads sibling `pluginConfigs`; it only exposes its own metadata for `deploy` to pull.

## Design notes

- **Env per request (no state).** The `R2Bucket` is resolved fresh on every method call from the request-supplied `env`; nothing is captured isolate-wide. One isolate serves concurrent requests, so storing a per-request binding would leak it across requests. `createState` is therefore not defined.
- **Ambient R2 globals.** `R2Bucket` and friends come from `@cloudflare/workers-types` as ambient declarations. They are referenced unqualified, never imported, and provided by the Workers runtime at execution — there is no runtime npm dependency for R2.
- **Provider adapter seam (the Complex-tier mechanism).** `api.ts` is provider-agnostic: it calls a `StorageProvider` resolved per request. `providers/r2.ts` (`resolveR2Provider`) wraps the real `R2Bucket`; its methods are `async` so synchronous throws from a missing binding surface as rejected promises (callers can always `await`/`.catch`). `providers/memory.ts` (`createMemoryProvider`) is a `Map`-backed in-memory double used in tests (it is not wired into the runtime path — `api.ts` always resolves the real R2 provider). Note the seam is **key-first** (`provider.get(key)`), while the public API is **env-first** (`api.get(env, key)`) — `api.ts` binds the env to a provider and forwards the key.
- **No lifecycle hooks.** Cloudflare Workers are request-scoped: bindings arrive per request and nothing is held open across requests, so `onInit` / `onStart` / `onStop` are all unused.
