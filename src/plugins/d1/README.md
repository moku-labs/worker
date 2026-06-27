# d1

> Standard plugin — thin, typed wrappers over Cloudflare D1's `prepare().bind()` API (`query` / `first` / `run` / `batch`) over a keyed map of databases, each resolving its `D1Database` per-request off `env` via `bindings`. Not an ORM.

## Overview

The `d1` plugin exposes Cloudflare D1 (SQLite) SQL access for `@moku-labs/worker`. It is a **regular** plugin (`createPlugin`) that provides thin, typed wrappers over the native D1 `prepare().bind()` API — nothing more. Every method takes **raw SQL plus bind parameters** and returns the D1 result object unchanged: there is no query builder, no schema mapping, no ORM layer.

The plugin holds **no state**. The `D1Database` lives only in Cloudflare's per-request `env` object, which is **threaded as the first argument** into every API method and resolved on that call's stack frame via the `bindings` plugin — never copied into plugin state. One Cloudflare isolate serves many concurrent requests, so capturing `env` (or a resolved `D1Database`) isolate-wide would leak one request's database handle into another. Resolving per call keeps requests isolated.

It depends on **`bindings`** (`bindingsPlugin`): every method calls `ctx.require(bindingsPlugin).require<D1Database>(env, pickInstance(ctx.config, key, "d1").binding)` to turn the request `env` plus the selected instance's binding name into a live `D1Database`. `bindings` is a regular plugin precisely so binding-family plugins like `d1` can declare it in `depends` and reach it through `ctx.require`.

A `deployManifest()` method also exposes this plugin's deploy metadata (one `{ kind: "d1", name, binding, migrations? }` per configured database) so the deploy pipeline can read it without inspecting sibling plugin configs.

## Configuration

`d1` is configured as a **keyed map** of database instances — `Config = Record<string, D1Instance>`. Each key is a stable logical id (the one you pass to `app.d1.use(key)`); a single entry, or the one flagged `default: true`, is the implicit default served by the bare `app.d1` methods. The default config is `{}` — declare at least one instance. Config is frozen after `createApp`, so all values are read at call-time off `ctx.config`.

| Field | Type | Default | Description |
|---|---|---|---|
| `[key]` | `D1Instance` | — | A configured database, keyed by its logical id. |
| `[key].name` | `string` | — | Base Cloudflare D1 database name (stage-suffixed at deploy); surfaced via `deployManifest()`. |
| `[key].binding` | `string` | — | D1 binding name, as it appears in the request `env` and in wrangler config (`d1_databases[].binding`). Resolved at call-time off `env` via the `bindings` plugin. |
| `[key].migrations` | `string` | `undefined` | Directory (relative to project root) holding `.sql` migration files. **Deploy-time metadata only** — surfaced via `deployManifest()`, never read at request time. Omit when there are none. |
| `[key].default` | `boolean` | `false` | Marks this instance the default when more than one database is configured. |

```typescript
import { createApp, d1Plugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [d1Plugin],
  pluginConfigs: {
    d1: {
      main: { name: "tracker-db", binding: "DB", migrations: "db/migrations" }
    }
  }
});
```

With a single entry, `main` is automatically the default. With more than one database, mark exactly one `default: true`:

```typescript
d1: {
  main: { name: "tracker-db", binding: "DB", default: true },
  analytics: { name: "tracker-analytics", binding: "ANALYTICS" }
}
```

`d1` declares `depends: [bindingsPlugin]`, but you do **not** list `bindingsPlugin` yourself: `bindings` is a framework default shipped by every `createApp` from `@moku-labs/worker`, so the dependency is already satisfied. Adding it again throws `TypeError: [worker] Duplicate plugin name: "bindings"`.

## API

Every method is **env-first**: the per-request `env` is the first argument, threaded down to where the binding is resolved. Access from a consumer is the cross-plugin pull `require(d1Plugin).<method>(env, ...)`; the app-surface form is `app.d1.<method>(env, ...)` (regular plugins mount on `app.<name>`). The `query` / `first` / `run` / `batch` / `prepare` methods operate on the **default** database; `use(key)` returns the same SQL surface (type `D1.D1DatabaseApi`) bound to any other configured database. Results are the raw D1 result objects — no mapping. A missing binding throws a `[worker]`-prefixed error from the `bindings` resolver.

The Cloudflare D1 types referenced below (`D1Database`, `D1PreparedStatement`, `D1Result`) are **ambient globals** from `@cloudflare/workers-types`; you do not import them.

### `query<T>(env, sql, ...params): Promise<D1Result<T>>`

Run a statement and return **all** rows in a `D1Result<T>` (its `.results` is `T[]`). Wraps `prepare(sql).bind(...params).all<T>()`. The call-site generic `<T>` is forwarded to `all<T>()`, so `query<Product>(...)` resolves to `Promise<D1Result<Product>>` and is not widened to `unknown`.

```typescript
const { results } = await app.d1.query<Product>(
  env,
  "SELECT * FROM products WHERE active = ?",
  1
);
// results: Product[]
```

### `first<T>(env, sql, ...params): Promise<T | null>`

Run a statement and return the **first** row, or `null` if none matched. Wraps `prepare(sql).bind(...params).first<T>()`. The generic `<T>` is forwarded to `first<T>()`.

```typescript
const row = await app.d1.first<Product>(
  env,
  "SELECT * FROM products WHERE id = ?",
  id
);
if (!row) return new Response(null, { status: 404 });
```

### `run(env, sql, ...params): Promise<D1Result>`

Run a write or DDL statement (`INSERT` / `UPDATE` / `DELETE` / DDL) and return the `D1Result` carrying `.meta` (e.g. `rows_written`, `last_row_id`). Wraps `prepare(sql).bind(...params).run()`.

```typescript
const res = await app.d1.run(
  env,
  "INSERT INTO products (name) VALUES (?)",
  name
);
const id = res.meta.last_row_id;
```

### `batch(env, stmts): Promise<D1Result[]>`

Execute caller-built prepared statements **atomically in one round-trip**, returning one `D1Result` per statement with order preserved. Wraps `db.batch(stmts)`. `batch` does **not** accept raw SQL — D1's batch API requires `D1PreparedStatement` instances bound to the database, which you build via `prepare(env)` (below).

```typescript
const db = app.d1.prepare(env); // resolve the D1Database to build statements
await app.d1.batch(env, [
  db.prepare("UPDATE accounts SET bal = bal - ? WHERE id = ?").bind(100, "a"),
  db.prepare("UPDATE accounts SET bal = bal + ? WHERE id = ?").bind(100, "b")
]);
```

### `prepare(env): D1Database`

Resolve the request-scoped `D1Database` so callers can build `D1PreparedStatement`s for `batch`. A thin pass-through — it issues **no query itself**; it is simply the single place the binding is resolved for the batch path.

```typescript
const db = app.d1.prepare(env);
const stmt = db.prepare("SELECT * FROM t WHERE id = ?").bind(id);
const row = await stmt.first();
```

### `use(key): D1DatabaseApi`

Select a configured database by its logical key, returning the `query` / `first` / `run` / `batch` / `prepare` surface bound to that database. The bare `app.d1` methods are exactly `use(defaultKey)`. Throws a `[worker]`-prefixed error (listing the configured keys) if `key` is not configured; the lookup is lazy, so an unconfigured key only errors when a method is actually called.

```typescript
await app.d1.use("analytics").run(env, "INSERT INTO events (name) VALUES (?)", "click");
```

### `deployManifest(): Array<{ kind: "d1"; name: string; binding: string; migrations?: string }>`

Return this plugin's own deploy metadata — **one entry per configured database**. **Build-time only** — it takes no `env`. The deploy pipeline reads it via `ctx.require(d1Plugin).deployManifest()` rather than inspecting `d1`'s config directly. `kind` is pinned to the literal `"d1"` so deploy can discriminate resource kinds.

```typescript
const m = app.d1.deployManifest();
// => [{ kind: "d1", name: "tracker-db", binding: "DB", migrations: "db/migrations" }]
```

## Events

**None.** `d1` declares, emits, and listens to no events. Its API methods do request/response work via `require`, never `emit`. Migrations run inside the deploy pipeline, which emits its own **global** events (`provision:resource`, `deploy:phase`) — those are owned by the deploy plugin, not by `d1`. Accordingly the plugin context is typed `PluginCtx<Config, Record<string, never>, WorkerEvents>` — only the framework's global events, no `d1`-local map.

## Types

The plugin's types are re-exported from the package barrel as the `D1` namespace:

```typescript
import type { D1 } from "@moku-labs/worker";

let cfg: D1.Config;
let db: D1.D1DatabaseApi;
```

| Type | Shape | Purpose |
|---|---|---|
| `D1.Config` | `Record<string, D1Instance>` | The plugin's configuration — a keyed map of database instances. |
| `D1.D1Instance` | `{ name: string; binding: string; migrations?: string; default?: boolean }` | One configured database (a single map entry). |
| `D1.D1DatabaseApi` | `{ query, first, run, batch, prepare }` | The SQL surface bound to one database — the return type of `use(key)`. |
| `D1.Api` | `D1DatabaseApi & { use(key): D1DatabaseApi; deployManifest() }` | The full `app.d1` surface: default-database methods, the `use` selector, and `deployManifest()` (which returns `Array<{ kind: "d1"; name; binding; migrations? }>`). |
| `D1.D1Ctx` | `PluginCtx<Config, Record<string, never>, WorkerEvents>` intersected with a narrow `require(bindingsPlugin)` | Internal API-factory context; not needed by consumers. |

## Usage

A complete `server` fetch handler running queries through `d1`. Endpoints pull `d1` via `require` and thread `env` into each call.

```typescript
import { createApp, d1Plugin, endpoint } from "@moku-labs/worker";

type Product = { id: number; name: string; active: number };

const app = createApp({
  plugins: [d1Plugin],
  pluginConfigs: {
    d1: {
      main: { name: "tracker-db", binding: "DB", migrations: "db/migrations" }
    },
    server: {
      endpoints: [
        endpoint("/api/products").get(async ({ env, require }) => {
          const { results } = await require(d1Plugin).query<Product>(
            env,
            "SELECT * FROM products WHERE active = ?",
            1
          );
          return Response.json(results);
        }),

        endpoint("/api/products/{id}").get(async ({ params, env, require }) => {
          const row = await require(d1Plugin).first<Product>(
            env,
            "SELECT * FROM products WHERE id = ?",
            params.id
          );
          return row ? Response.json(row) : new Response(null, { status: 404 });
        }),

        endpoint("/api/products").post(async ({ request, env, require }) => {
          const { name } = (await request.json()) as { name: string };
          const res = await require(d1Plugin).run(
            env,
            "INSERT INTO products (name) VALUES (?)",
            name
          );
          return Response.json({ id: res.meta.last_row_id }, { status: 201 });
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

- **`bindings`** — `d1` declares `depends: [bindingsPlugin] as const`. Every method resolves its `D1Database` through `ctx.require(bindingsPlugin).require<D1Database>(env, pickInstance(ctx.config, key, "d1").binding)`. `bindings` is a framework default, so this dependency is satisfied automatically — never add `bindingsPlugin` to your `plugins` array (it would throw a duplicate-plugin-name `TypeError`). A selected instance's `binding` that is absent from `env` raises the `[worker] binding "DB" is not bound.` error from the `bindings` resolver.
- **`server`** — `d1` does no routing itself; reach it from endpoint handlers via `require(d1Plugin).<method>(env, ...)`, threading the handler's `env`. `server` is also a framework default, so registering endpoints under `pluginConfigs.server.endpoints` is enough — you do not list `serverPlugin` either.
- **deploy** — the deploy pipeline reads `deployManifest()` to discover the binding and migrations directory. `d1` exposes this metadata through its own API surface; it never has its config read by sibling plugins.

## Design notes

- **Env-per-request, no state.** D1 access is a pure function over a request-supplied `env`. The plugin defines no `createState`; `env` is an argument on every method and the resolved handle never outlives the call. This guards against cross-request leakage in a shared isolate.
- **Ambient Cloudflare types.** `D1Database`, `D1PreparedStatement`, and `D1Result` come from `@cloudflare/workers-types` as ambient globals — they are type-only (not bundled into the deployed Worker) and never imported in usage code.
- **Not an ORM.** Thin typed wrappers over `prepare().bind()` by design — no `drizzle` / `kysely` / `better-sqlite3`, no query builder. The native D1 result objects pass through unchanged. The only generics are the optional row types on `query` / `first`, forwarded to D1's own `all<T>()` / `first<T>()`.
- **Standard tier.** The domain logic lives in `api.ts` as a pure `createD1Api(ctx)` factory; `index.ts` is wiring only; the public surface lives in `types.ts`. There is no `state.ts` — the plugin has no state.
- **No lifecycle hooks.** Cloudflare Workers are request-scoped: the binding arrives per-request and there is no long-lived connection or pool to open in `onStart` or close in `onStop`. `d1` defines no `onInit` / `onStart` / `onStop`.
