# @moku-labs/worker

> Server-side Cloudflare Workers app + deploy framework, built on [`@moku-labs/core`](https://github.com/moku-labs/core). Durable Objects, Queues, R2, D1, and KV — each as its own composable Moku plugin — designed to compose alongside Moku Web.

## Overview

`@moku-labs/worker` models a Cloudflare Worker as a small set of **composable Moku plugins**. Each Cloudflare primitive (KV, D1, R2, Queues, Durable Objects) is a plugin that resolves its binding **per request** off the Cloudflare `env`, and a `server` plugin owns the HTTP routing and request dispatch. Deploy tooling (`deploy`, `cli`) is built from the same plugin model but kept strictly **out of the runtime bundle**.

Two design facts shape everything below:

1. **Runtime vs. node-only surface.** Everything ships from `@moku-labs/worker`, including the build-time `deployPlugin`/`cliPlugin` (the `@moku-labs/worker/cli` subpath remains as a back-compat alias). Those two reach for `node:child_process`/`node:fs`, so they enter a bundle **only when a consumer actually lists them in `createApp({ plugins })`** — `"sideEffects": false` tree-shakes them out of any request-time Worker bundle that doesn't.
2. **Env per request, never stored.** One Cloudflare isolate serves concurrent requests. Bindings (`env`) are threaded as a **call argument** to every plugin method and live only on the call stack — they are never captured in plugin state, so concurrent requests cannot leak each other's bindings.

This framework supplies the **server-side** Cloudflare primitives. Moku Web (`@moku-labs/web`) supplies the request/island layer; the two compose.

## Quick Start

Install (this project uses **bun** as its package manager):

```bash
bun add @moku-labs/worker
bun add -d @cloudflare/workers-types
```

A minimal Worker that routes HTTP requests. This shape is taken directly from the framework's own passing server integration test (`src/plugins/server/__tests__/integration/server.test.ts`):

```typescript
// app.ts
import { createApp, endpoint } from "@moku-labs/worker";

export const app = createApp({
  pluginConfigs: {
    server: {
      endpoints: [
        endpoint("/health").get(() => new Response("ok", { status: 200 })),
        endpoint("/api/data/{lang:?}").get(({ params }) =>
          Response.json({ lang: params.lang ?? "en" })
        ),
        endpoint("/users/{userId}").get(
          ({ params }) => new Response(`user=${params.userId}`, { status: 200 })
        )
      ]
    }
  }
});
```

```typescript
// worker.ts — the default export is hand-assembled; no plugin produces it.
import { app } from "./app";

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.handle(request, env, ctx)
} satisfies ExportedHandler;
```

`createApp` is synchronous, built once per isolate at module load, and frozen. `bindingsPlugin` and `serverPlugin` are wired into the framework by default — you do not list them in `plugins`. A request to `/api/data/fr` returns `{ "lang": "fr" }`; `/api/data` returns `{ "lang": "en" }`; an unmatched path returns `404`.

## Installation

```bash
bun add @moku-labs/worker
```

| Dependency | Why |
|---|---|
| `@moku-labs/core@0.1.4` | The micro-kernel this framework is built on. Installed transitively. |
| `@moku-labs/common@0.1.1` | Supplies the `log` and `env` core plugins. Installed transitively. |
| `@cloudflare/workers-types` (dev) | Ambient Cloudflare runtime types (`KVNamespace`, `D1Database`, `R2Bucket`, `Queue`, `DurableObjectNamespace`, `ExecutionContext`, …). Type-only — never bundled. Add to your tsconfig `types`. |
| `wrangler` (peer/dev) | Required **only** when you add the node-only `deployPlugin`/`cliPlugin`. Invoked as a subprocess; never bundled. |

Requires Node `>=24` for the build/deploy tooling and bun `>=1.3.14`.

## Usage

### Creating an app

`createApp` is the Layer-3 consumer entry. Resource plugins are added to `plugins`; their configuration goes under `pluginConfigs.<name>`:

```typescript
import { createApp, kvPlugin } from "@moku-labs/worker";

const app = createApp({
  config: { name: "my-api", stage: "production", compatibilityDate: "2026-06-17" },
  plugins: [kvPlugin],
  pluginConfigs: {
    bindings: { required: ["MY_KV"] },
    kv: { binding: "MY_KV" }
  }
});
```

**The final plugin list is `[...frameworkDefaults, ...yourPlugins]`** (spec/02 §4). This framework's defaults are the core plugins (`log`, `env`, `stage`) plus `bindingsPlugin` and `serverPlugin`, registered first and in order; your `plugins` are appended after. So:

- **Do not re-list `bindingsPlugin` or `serverPlugin`** — they are already defaults. Re-listing a default collides on name and throws `TypeError: [moku-worker] Duplicate plugin name: "bindings"` during init (spec/11 §Part 1 — no merge, no "last wins").
- **`depends: [bindingsPlugin]` is satisfied automatically.** `bindings` is a default ordered ahead of every consumer plugin, so any resource plugin you append (which declares `depends: [bindingsPlugin]`) resolves correctly without you listing `bindings`. List only the resource plugins you are adding.
- **`pluginConfigs` is keyed by plugin name**, so you can still configure a default plugin (e.g. `bindings: { required: [...] }`) without putting it in `plugins`.

### Accessing plugin APIs

Regular plugins mount their api on `app.<name>`:

```typescript
app.server.handle(request, env, exec);   // route one HTTP request → Response
app.kv.get(env, "feature-flags");         // env-first KV read
app.d1.query(env, "SELECT 1");            // env-first D1 query
```

The core plugins are **flat-injected** on every plugin's `ctx` — `ctx.log`, `ctx.env`, `ctx.stage` — which is the ergonomic way to use them from inside plugin code. Like every plugin, they are also mounted on the app surface, so `app.log`, `app.env`, and `app.stage` exist alongside `app.server`, `app.bindings`, and the resource plugins.

### Env-per-request threading

Every binding-resolving method takes the per-request Cloudflare `env` as its **first argument**. Inside a `server` endpoint handler you receive `env` (and a cross-plugin `require`) on the per-request `RequestContext`, and thread `env` into each call:

```typescript
import { createApp, endpoint, kvPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [kvPlugin],
  pluginConfigs: {
    kv: { binding: "MY_KV" },
    server: {
      endpoints: [
        endpoint("/cache/{key}").get(async ({ params, env, require, has }) => {
          if (!has("kv")) return new Response("kv not configured", { status: 501 });
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

### Wiring the Worker entry

The Cloudflare default export (`{ fetch, scheduled, queue }`) is **not** produced by any plugin — you hand-assemble it from the relevant `app.*` methods. `fetch` / `scheduled` / `queue` are Cloudflare runtime callbacks (not Moku lifecycle phases); each threads the per-invocation `env` on the stack:

```typescript
// worker.ts
import { app } from "./app";
import type { ExecutionContext, ExportedHandler, MessageBatch, ScheduledController } from "@cloudflare/workers-types";

export default {
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.handle(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.server.scheduled(controller, env, ctx),
  queue: (batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext) =>
    app.queues.consume(batch, env, ctx)
} satisfies ExportedHandler;
```

A stateless Worker never calls `app.start()` / `app.stop()` — no plugin opens a long-lived connection, so there is no lifecycle to run.

## Plugins

Plugin **name strings** are bare (`"server"`, `"kv"`, `"durableObjects"`); the **exported instances** carry the `Plugin` suffix (`serverPlugin`, `kvPlugin`, `durableObjectsPlugin`).

| Plugin | Description | Tier | Entry | Key APIs |
|---|---|---|---|---|
| [`bindings`](src/plugins/bindings/README.md) | Resolves Cloudflare bindings off the per-request `env`; the binding-family dependency root. | Micro | `@moku-labs/worker` | `require(env, name)`, `has(env, name)` |
| [`server`](src/plugins/server/README.md) | HTTP routing + request/scheduled dispatch; the Worker-entry surface. | Standard | `@moku-labs/worker` | `handle`, `scheduled`, `endpoint` |
| [`kv`](src/plugins/kv/README.md) | Thin env-first wrapper over one KV namespace. | Micro | `@moku-labs/worker` | `get`, `put`, `delete`, `list`, `deployManifest` |
| [`d1`](src/plugins/d1/README.md) | Typed wrappers over D1's `prepare().bind()` (`query`/`first`/`run`/`batch`). Not an ORM. | Standard | `@moku-labs/worker` | `query`, `first`, `run`, `batch`, `prepare`, `deployManifest` |
| [`queues`](src/plugins/queues/README.md) | Cloudflare Queues producer + consumer. | Standard | `@moku-labs/worker` | `send`, `sendBatch`, `consume`, `deployManifest` |
| [`storage`](src/plugins/storage/README.md) | R2 object storage behind a provider-adapter seam. | Complex | `@moku-labs/worker` | `get`, `put`, `delete`, `list`, `deployManifest` |
| [`durableObjects`](src/plugins/durable-objects/README.md) | Resolves DO stubs off `env`; ships `defineDurableObject` base-class helper. | Standard | `@moku-labs/worker` | `get`, `deployManifest`, `defineDurableObject` |
| [`stage`](src/plugins/stage/README.md) | Deployment-stage / dev-mode detection. Core plugin, flat-injected as `ctx.stage`. | Nano | `@moku-labs/worker` | `isDev`, `isProduction`, `current` |
| [`deploy`](src/plugins/deploy/README.md) | Build-time deploy orchestrator: detect → provision → wrangler-config → upload → deploy. **Node-only.** | Complex | `@moku-labs/worker` (`./cli` alias) | `run`, `dev`, `init` |
| [`cli`](src/plugins/cli/README.md) | Developer-facing `dev` / `deploy` verbs + live progress TUI. Thin passthroughs to `deploy`. **Node-only.** | Standard | `@moku-labs/worker` (`./cli` alias) | `dev`, `deploy` |

> The `log` and `env` **core plugins are not authored here** — they come from `@moku-labs/common` and are re-exported (`logPlugin`, `envPlugin`) for completeness. `env` is environment-**variable** access (`get`/`require`/`has`), distinct from `stage` (dev/production detection).

Helpers (also from `@moku-labs/worker`): `endpoint(path)` (server route builder) and `defineDurableObject(name)` (DO base-class factory).

## Configuration

### `WorkerConfig`

The global framework config, passed as `createApp({ config })`. Flat, with complete defaults:

| Field | Type | Default | Description |
|---|---|---|---|
| `stage` | `"production" \| "development" \| "test"` | `"production"` | Deployment stage. Production-safe default. Forwarded into the `stage` plugin (`ctx.stage`). |
| `name` | `string` | `"moku-worker"` | Worker name. Used by `deploy` as the wrangler `name` (`ctx.global.name`). |
| `compatibilityDate` | `string` | `""` | Cloudflare compatibility date. Used by `deploy` as the wrangler `compatibility_date`. |

```typescript
const app = createApp({
  config: { name: "my-api", stage: "production", compatibilityDate: "2026-06-17" }
});
```

### Per-plugin config (`pluginConfigs`)

Each plugin's config is supplied under its name key. All configs are flat with complete defaults (overriding one key never drops siblings) and **frozen** after `createApp`:

| Plugin | Key fields (default) |
|---|---|
| `bindings` | `required: string[]` (`[]`) |
| `server` | `endpoints: Endpoint[]` (`[]`) |
| `kv` | `binding: string` (`"KV"`) |
| `d1` | `binding: string` (`"DB"`), `migrations: string` (`""`) |
| `queues` | `producers: string[]` (`[]`), `onMessage: (message, env) => Promise<void>` (no-op) |
| `storage` | `bucket: string` (`"ASSETS"`), `upload: string` (`""`) |
| `durableObjects` | `bindings: Record<string, string>` (`{}`) — logical → CF binding name |
| `stage` | `stage: "production" \| "development" \| "test"` (`"production"`) — fed from `WorkerConfig.stage` |
| `deploy` | `configFile: string` (`"wrangler.jsonc"`), `ci: boolean` (`false`) |
| `cli` | `port: number` (`8787`) |

See each plugin's README for the full field reference.

## Events

Events are fire-and-forget observability — the kernel cannot carry a return value through an event, so all request/response and deploy **work** flows through api return values, never through `emit`. Two scopes exist:

### Global events (`WorkerEvents`, declared in `src/config.ts`)

Visible to every plugin; hookable without a `depends` edge.

| Event | Payload | Emitted by | When |
|---|---|---|---|
| `request:start` | `{ method: string; path: string; requestId: string }` | `server` | Start of `handle`, before matching. `requestId` is a fresh `crypto.randomUUID()`. |
| `request:end` | `{ method: string; path: string; status: number; ms: number }` | `server` | After the handler returns, with final status + elapsed ms. |
| `deploy:phase` | `{ phase: string; detail?: string }` | `deploy` | Each pipeline stage: `detect`, `provision`, `wrangler-config`, `upload` (`detail: "<n> files"`), `deploy`. |
| `provision:resource` | `{ kind: "kv" \| "r2" \| "d1" \| "queue" \| "do"; name: string }` | `deploy` | Once per provisioned resource. |
| `deploy:complete` | `{ url: string }` | `deploy` | After `wrangler deploy` succeeds. |

### Plugin-local events

Declared on the producing plugin; observers reach them via `depends: [<plugin>]`.

| Event | Scope | Payload | Emitted by | When |
|---|---|---|---|---|
| `server:matched` | `Server.ServerEvents` | `{ path: string; method: string }` | `server` | After a request matches an endpoint, before the handler runs. Not emitted on `404`. |
| `queue:message` | `Queues.QueueEvents` | `{ queue: string; messageId: string }` | `queues` | After `config.onMessage` settles for a message inside `consume`. |

Subscribe from a plugin's `hooks`:

```typescript
hooks: (register) => {
  register("deploy:phase", ({ phase, detail }) =>
    console.log(`▸ ${phase}${detail ? ` (${detail})` : ""}`)
  );
  register("deploy:complete", ({ url }) => console.log(`✓ ${url}`));
}
```

## Architecture

### Three-layer Moku model

| Layer | File | Produces |
|---|---|---|
| 1 — config + events | `src/config.ts` | `createCoreConfig` → `WorkerConfig`, `WorkerEvents`, registers core plugins (`log`, `env`, `stage`) |
| 2 — framework + plugins | `src/index.ts` | `createCore` → exposes `createApp` / `createPlugin`; wires `bindings` + `server` defaults |
| 3 — consumer app | your code | `createApp({ ... })` |

### Plugin dependency graph

```
bindings  (root — depends on nothing)
   ├── server
   ├── kv
   ├── d1
   ├── queues
   ├── storage
   └── durableObjects

deploy  → depends on [storage, kv, d1, queues, durableObjects]   (node-only)
cli     → depends on [deploy]                                     (node-only)
```

Each resource plugin exposes a `deployManifest()` that `deploy` reads via `ctx.require` — `deploy` never inspects sibling `pluginConfigs` (a plugin sees only `ctx.global` + its own `ctx.config`; `require` returns a plugin's api, not its config). Init order is a topological sort of this graph; `bindings` initializes first.

### Event flow

```
fetch → app.server.handle
          ├─ emit request:start   (global)
          ├─ match endpoint
          ├─ emit server:matched  (local)   ─ skipped on 404
          ├─ run handler → Response
          └─ emit request:end     (global)

deploy → app.deploy.run
          ├─ emit deploy:phase {detect}
          ├─ emit deploy:phase {provision} → per resource: emit provision:resource
          ├─ emit deploy:phase {wrangler-config}
          ├─ emit deploy:phase {upload}   (only if R2 upload dir)
          ├─ emit deploy:phase {deploy}
          └─ emit deploy:complete {url}
```

### Runtime vs. node-only boundary

```
@moku-labs/worker          (.   → src/index.ts)   one entry for everything
  createApp, createPlugin
  bindingsPlugin, serverPlugin, kvPlugin, d1Plugin,
  queuesPlugin, storagePlugin, durableObjectsPlugin, stagePlugin
  endpoint, defineDurableObject
  envPlugin, logPlugin
  WorkerConfig, WorkerEvents, WorkerEnv, + type namespaces (Server, D1, Queues, Storage, DurableObjects)
  deployPlugin, cliPlugin                       node-only — tree-shaken unless you add them
  ExternalManifest, ResourceManifest

@moku-labs/worker/cli      (./cli → src/cli.ts)   back-compat alias for the two node-only plugins
  deployPlugin, cliPlugin, ExternalManifest, ResourceManifest
```

`deploy` and `cli` import `node:child_process` / `node:fs`, which cannot run in the Cloudflare isolate — but they reach a bundle **only** when a consumer lists them in `createApp({ plugins })`. Because the package is `"sideEffects": false`, a request-time Worker that imports `createApp` (and never adds those two) tree-shakes them away, so the Node built-ins stay out of the deployed bundle without a separate entry point. The `./cli` subpath remains as a back-compat alias. The specs reference a `@moku-labs/worker/worker` subpath — it does **not** exist; the real entries are `.` and `./cli`.

## Development

Scripts (run with **bun** — never npm/yarn/pnpm):

| Script | Command | Purpose |
|---|---|---|
| `bun run build` | `tsdown` | Build the package (`dist/`). |
| `bun run lint` | `biome check . && eslint .` | Biome + ESLint. |
| `bun run lint:fix` | `biome check --write . && eslint --fix .` | Auto-fix. |
| `bun run format` | `biome format --write .` | Format. |
| `bun run test` | `vitest run` | All tests (unit + integration). |
| `bun run test:unit` | `vitest run --project unit` | Unit tests only. |
| `bun run test:integration` | `vitest run --project integration` | Integration tests only. |
| `bun run test:coverage` | `vitest run … --coverage` | Tests with coverage (90% threshold). |
| `bun run validate` | `publint && attw …` | Package-publish validation. |

### Test layout

Tests are **colocated inside each plugin**: `src/plugins/<name>/__tests__/unit/` and `src/plugins/<name>/__tests__/integration/`. Framework-level cross-plugin tests live in root `tests/unit/` and `tests/integration/`. Never put plugin-specific tests in the root `tests/`.

### Adding a plugin

1. Create `src/plugins/<name>/` (see [moku-plugin tiers](src/plugins/server/README.md) for file layout by complexity).
2. Author the plugin with `createPlugin("<name>", { … })` (no explicit generics — they are inferred).
3. Re-export the instance (and any type namespace) from `src/plugins/index.ts` for the runtime entry, or `src/cli.ts` for a node-only plugin.
4. Add colocated `__tests__/`.

Custom plugin skeleton:

```typescript
import { createPlugin } from "@moku-labs/worker";
import { bindingsPlugin } from "@moku-labs/worker";
import type { WorkerEnv } from "@moku-labs/worker";

export const cachePlugin = createPlugin("cache", {
  depends: [bindingsPlugin] as const,
  config: { binding: "CACHE" },
  api: (ctx) => ({
    read: (env: WorkerEnv, key: string) =>
      ctx.require(bindingsPlugin).require<KVNamespace>(env, ctx.config.binding).get(key)
  })
});
```

## API Reference

Per-plugin READMEs (authoritative API/config/events for each):

- [`bindings`](src/plugins/bindings/README.md)
- [`server`](src/plugins/server/README.md)
- [`kv`](src/plugins/kv/README.md)
- [`d1`](src/plugins/d1/README.md)
- [`queues`](src/plugins/queues/README.md)
- [`storage`](src/plugins/storage/README.md)
- [`durable-objects`](src/plugins/durable-objects/README.md)
- [`stage`](src/plugins/stage/README.md)
- [`deploy`](src/plugins/deploy/README.md)
- [`cli`](src/plugins/cli/README.md)

For the underlying kernel model (`createCoreConfig`, `createCore`, `createApp`, lifecycle, events), see the [Moku Core specification](https://github.com/moku-labs/core/tree/main/specification).
