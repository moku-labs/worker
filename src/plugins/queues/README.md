# queues

> Standard tier plugin — Cloudflare Queues producer + consumer for `@moku-labs/worker`.

## Overview

The `queues` plugin gives a Worker both sides of Cloudflare Queues from one plugin:

- **Producer** — `send` / `sendBatch` enqueue messages onto a configured queue instance resolved
  from the per-request `env` bindings object. The default instance's methods sit on `app.queues`;
  any instance is selectable via `app.queues.use(key)`.
- **Consumer** — `consume(batch, env, exec)` is the dispatch the Worker's `queue()` runtime
  export delegates to. It routes the batch to the matching instance (by queue name) and **awaits**
  that instance's `onMessage(message, env)` per message, so Cloudflare receives a settled promise and
  the handler decides ack vs. retry.
- **Deploy metadata** — `deployManifest()` returns one `{ kind: "queue", name, binding, consumer?,
  maxBatchTimeout? }` per configured instance, read by the deploy plugin so it can declare producer
  bindings (and `consumers` entries) in the generated wrangler config.

It is a **regular** plugin (`createPlugin("queues", …)`), not a core plugin, for two reasons it
could not satisfy otherwise: it declares `depends: [bindingsPlugin]` and calls
`ctx.require(bindingsPlugin)` to resolve `Queue` bindings, and it `emit`s its own `queue:message`
event. Both are capabilities only a regular plugin has.

Consumer registration is **declarative config** (each instance's `onMessage`, a frozen-legal function
value) rather than a post-`createApp` mutator — there is no `app.queues.onMessage()` surface to call.

`env` is **never stored**. One Cloudflare isolate serves concurrent requests, so capturing `env`
isolate-wide would leak state across requests; instead every binding-resolving method threads `env`
as a call argument and resolves the `Queue` fresh on each call.

## Configuration

`queues` is configured as a **keyed map** of Queue instances — `Config = Record<string, QueueInstance>`.
Each key is a stable logical id (the one you pass to `app.queues.use(key)`); a single entry, or the
one flagged `default: true`, is the implicit default served by the bare `app.queues` methods. The
default config is `{}` — declare at least one instance. `onMessage` is a function value stored in
config — legal because the resolved config is frozen and freezing a function reference does not break
it.

| Field | Type | Default | Description |
|---|---|---|---|
| `[key]` | `QueueInstance` | — | A configured queue, keyed by its logical id. |
| `[key].name` | `string` | — | Base Cloudflare queue name (stage-suffixed at deploy, e.g. `tracker-activity-dev`). Surfaced by `deployManifest()` and used by `consume()` to route a batch to its instance. |
| `[key].binding` | `string` | — | Producer env binding the `Queue` resolves off the per-request `env` (e.g. `env.ACTIVITY`). |
| `[key].onMessage` | `(message: Message, env: WorkerEnv) => Promise<void>` | `undefined` (no-op) | Per-instance consumer handler — awaited once per message inside `consume()`. The handler owns ack/retry: resolving implies ack; throwing causes a retry per the queue's redelivery policy. An instance that declares `onMessage` is flagged `consumer: true` by `deployManifest()`. Omit for a producer-only instance. |
| `[key].maxBatchTimeout` | `number` | `undefined` | Max seconds the consumer waits to fill a batch (Cloudflare's `max_batch_timeout`, 0–60). Written to the generated wrangler `consumers` entry, so it only has an effect on an instance that also declares `onMessage`. |
| `[key].default` | `boolean` | `false` | Marks this instance the default when more than one queue is configured. |

```typescript
import { createApp, queuesPlugin } from "@moku-labs/worker";
import type { Message } from "@cloudflare/workers-types";

const app = createApp({
  plugins: [queuesPlugin],
  pluginConfigs: {
    queues: {
      orders: {
        name: "orders",
        binding: "ORDERS",
        onMessage: async (message: Message, env) => {
          await handleOrder(message.body);
        }
      }
    }
  }
});
```

## API

The api is built by `createQueuesApi(ctx)` and mounted on `app.queues` (regular plugins mount on
`app.<name>`). `send` / `sendBatch` operate on the **default** instance; `use(key)` returns the same
producer surface (type `QueueProducerApi`) bound to any other configured instance. Every
binding-resolving method takes the per-request `env` as its first argument and resolves the `Queue`
via `ctx.require(bindingsPlugin).require<Queue>(env, pickInstance(ctx.config, key, "queues").binding)`.

### `send(env, body)`

```typescript
send(env: WorkerEnv, body: unknown): Promise<void>
```

Enqueues a single message `body` onto the **default** instance's queue resolved from `env`. Thin
wrapper over the platform `Queue.send` — request/response work, so it returns a promise rather than
emitting an event. Target a non-default instance with `app.queues.use(key).send(env, body)`.

- **Throws** an `Error` with a `[worker]` prefix if the queue binding is missing from `env`
  (propagated from `bindings.require`).

```typescript
import { queuesPlugin } from "@moku-labs/worker";

endpoint("/api/orders").post(async ({ request, env, require }) => {
  await require(queuesPlugin).send(env, await request.json());
  return new Response(null, { status: 202 });
});
```

### `sendBatch(env, bodies)`

```typescript
sendBatch(env: WorkerEnv, bodies: unknown[]): Promise<void>
```

Enqueues many messages in one call onto the **default** instance's queue; each element of `bodies`
becomes one message. Maps each body to `{ body }` (`bodies.map(body => ({ body }))`) before calling
the platform `Queue.sendBatch`. Target a non-default instance with `app.queues.use(key).sendBatch(...)`.

- **Throws** an `Error` with a `[worker]` prefix if the queue binding is missing from `env`.

```typescript
import { queuesPlugin } from "@moku-labs/worker";

endpoint("/api/orders/bulk").post(async ({ request, env, require }) => {
  const orders = (await request.json()) as unknown[];
  await require(queuesPlugin).sendBatch(env, orders);
  return new Response(null, { status: 202 });
});
```

### `consume(batch, env, exec)`

```typescript
consume(batch: MessageBatch, env: WorkerEnv, exec: ExecutionContext): Promise<void>
```

Consumer dispatch — the Worker's `queue()` export delegates here. Routes the batch to the matching
instance — the one whose `name` equals (or stage-prefixes, e.g. `orders-dev`) `batch.queue`, falling
back to the default — then, for each message in `batch.messages`:

1. **awaits** that instance's `onMessage(message, env)` if it declares one (so Cloudflare gets a
   settled promise and the handler controls ack via return / retry via throw),
2. fire-and-forget `emit`s `queue:message` for observability.

Returns a promise the Worker **must** `await` before returning so the isolate is not killed
mid-batch. The `exec` (`ExecutionContext`) parameter is accepted to match Cloudflare's `queue()`
signature; it is currently reserved and not used internally.

- **Throws / rejects** by re-propagating any error thrown from the instance's `onMessage`, so
  Cloudflare can retry the offending message per the queue's redelivery policy.

```typescript
// my-app/src/worker.ts — hand-assembled Worker export
import type { ExecutionContext, ExportedHandler, MessageBatch } from "@cloudflare/workers-types";
import { app } from "./app";

export default {
  queue: (b: MessageBatch, e: Record<string, unknown>, c: ExecutionContext) =>
    app.queues.consume(b, e, c)
} satisfies ExportedHandler;
```

### `use(key)`

```typescript
use(key: string): QueueProducerApi
```

Selects a configured instance by its logical key, returning the `send` / `sendBatch` producer surface
bound to that instance's queue. The bare `app.queues` producer methods are exactly `use(defaultKey)`.
Throws a `[worker]`-prefixed error (listing the configured keys) if `key` is not configured; the
lookup is lazy, so an unconfigured key only errors when a method is actually called.

```typescript
import { queuesPlugin } from "@moku-labs/worker";

endpoint("/api/activity").post(async ({ request, env, require }) => {
  await require(queuesPlugin).use("activity").send(env, await request.json());
  return new Response(null, { status: 202 });
});
```

### `deployManifest()`

```typescript
deployManifest(): Array<{
  kind: "queue";
  name: string;
  binding: string;
  consumer?: boolean;
  maxBatchTimeout?: number;
}>
```

Returns this plugin's **own** deploy metadata — **one entry per configured instance** — a pure
synchronous read of `ctx.config`. An instance that declares an `onMessage` handler is flagged
`consumer: true` so the deploy plugin registers it as a wrangler `consumers` entry (without which this
Worker never receives the queue's messages). The deploy plugin reads it via
`ctx.require(queuesPlugin).deployManifest()`; it never reads sibling `pluginConfigs` directly.

```typescript
import { queuesPlugin } from "@moku-labs/worker";

// Inside the deploy plugin:
const manifest = ctx.has("queues") ? ctx.require(queuesPlugin).deployManifest() : null;
// → [{ kind: "queue", name: "orders", binding: "ORDERS", consumer: true }]
```

## Events

`queues` is an own-event plugin: it declares one domain event via the `events` register-callback and
`emit`s it from `consume`. Observers reach it by declaring `depends: [queuesPlugin]`.

| Event | Payload | When |
|---|---|---|
| `queue:message` | `{ queue: string; messageId: string }` | After the matched instance's `onMessage` settles for a message inside `consume` — fire-and-forget observability only. `queue` is `batch.queue`; `messageId` is the message's `id`. |

```typescript
// A tiny observer plugin reacting to queue:message:
import { createPlugin, queuesPlugin } from "@moku-labs/worker";

export const queueMetricsPlugin = createPlugin("queueMetrics", {
  depends: [queuesPlugin] as const,
  hooks: {
    "queue:message": ({ queue, messageId }) => {
      // record a metric, log, etc.
    }
  }
});
```

## Types

The plugin's types are re-exported from the barrel as the `Queues` namespace
(`export * as Queues from "./queues/types"`), so consumers reference them as `Queues.Config`,
`Queues.Api`, etc.

| Type | Shape | Notes |
|---|---|---|
| `Queues.Config` | `Record<string, QueueInstance>` | Plugin config — a keyed map of queue instances. Also re-exported directly as `Config` from the plugin entry. |
| `Queues.QueueInstance` | `{ name: string; binding: string; onMessage?; maxBatchTimeout?: number; default?: boolean }` | One configured queue (a single map entry). |
| `Queues.QueueProducerApi` | `{ send; sendBatch }` | The producer surface bound to one instance — the return type of `use(key)`. |
| `Queues.Api` | `QueueProducerApi & { use(key); consume; deployManifest }` | The public api surface mounted on `app.queues`. `deployManifest()` returns `Array<{ kind: "queue"; name; binding; consumer?; maxBatchTimeout? }>`. |
| `Queues.QueueEvents` | `{ "queue:message": { queue: string; messageId: string } }` | Per-plugin event map merged into the plugin's event context. |
| `Queues.Ctx` | `PluginCtx<Config, Record<string, never>, WorkerEvents & QueueEvents>` plus a `require(bindingsPlugin)` overload | Internal plugin context type — own config first, no state, merged events, and a `require` narrowed to the one dependency (`bindings`). |

`Message`, `MessageBatch`, `Queue`, and `ExecutionContext` are ambient Cloudflare types from
`@cloudflare/workers-types`. `WorkerEnv` (`Record<string, unknown>`) and `WorkerEvents` are framework
types exported from `@moku-labs/worker`.

## Usage

End-to-end: a `fetch` handler enqueues work, and the `queue()` consumer drains the batch through the
declarative `onMessage` handler.

```typescript
// my-app/src/app.ts
import { createApp, queuesPlugin } from "@moku-labs/worker";
import type { Message } from "@cloudflare/workers-types";

type Order = { orderId: string; total: number };

export const app = createApp({
  plugins: [queuesPlugin],
  pluginConfigs: {
    queues: {
      orders: {
        name: "orders",
        binding: "ORDERS",
        // Handle one message per call; throwing here triggers a Cloudflare retry.
        onMessage: async (message: Message, env) => {
          const order = message.body as Order;
          await fulfill(order, env);
        }
      }
    }
  }
});
```

```typescript
// my-app/src/worker.ts — hand-assembled Worker export
import type {
  ExecutionContext,
  ExportedHandler,
  MessageBatch
} from "@cloudflare/workers-types";
import { app } from "./app";

export default {
  // Producer side: enqueue from a request.
  fetch: async (request: Request, env: Record<string, unknown>) => {
    const order = await request.json();
    await app.queues.send(env, order); // default instance ("orders")
    return new Response(null, { status: 202 });
  },
  // Consumer side: drain the batch — MUST await so the isolate survives the batch.
  queue: (b: MessageBatch, e: Record<string, unknown>, c: ExecutionContext) =>
    app.queues.consume(b, e, c)
} satisfies ExportedHandler;
```

## Integration

- **`bindings` (required)** — `queues` declares `depends: [bindingsPlugin]` and resolves each
  `Queue` through `ctx.require(bindingsPlugin).require<Queue>(env, pickInstance(ctx.config, key, "queues").binding)`. `bindings` is a framework
  default (auto-wired by `createApp`), so the `depends` edge is always satisfied without the consumer
  listing it. It is a regular plugin precisely so it can be a `require`/`depends` target.
- **`server`** — the producer path is typically driven from `server` endpoint handlers, which expose
  `env` and `require` on their handler context (`require(queuesPlugin).send(env, …)`). The consumer
  path is independent of `server`: it is wired through the Worker's `queue()` export, assembled by
  hand alongside `fetch` (`server.handle`) in the Worker entry module.
- **`deploy`** — reads `deployManifest()` via `ctx.require(queuesPlugin)` to emit producer bindings
  (and `consumers` entries for instances that declare an `onMessage`); it never reaches into the
  queues config directly.

## Design notes

- **env-per-request** — `queues` holds no state (`createState` is omitted). Producer sends resolve a
  `Queue` from each call's `env`; the consumer reads the matched instance's frozen `onMessage` plus
  the request `env` argument. `env` is threaded, never captured, so concurrent invocations in one
  isolate never collide.
- **Own-event inference** — `events` is declared on the plugin via
  `register.map<QueueEvents>({ "queue:message": "…" })`, which infers the plugin's own event into the
  factory context; the `api` wiring is therefore an inline arrow (`ctx => createQueuesApi(ctx)`) so
  the contextual typing of `ctx.emit("queue:message", …)` is preserved.
- **emit vs. await** — `consume` **awaits** `onMessage` (request/response work that gates ack/retry)
  and only *then* fire-and-forget `emit`s `queue:message`. The emit is observability and never
  carries awaited work; `emit` returns `void`.
- **Standard tier** — the plugin splits across `index.ts` (wiring), `api.ts` (the producer/consumer
  api factory plus the `use`/`consume`/`deployManifest` surface), and `types.ts` (config, api,
  manifest, events, and context types), with colocated tests under `__tests__/`. The split, the
  cross-plugin `require`, and the own event together place it at the Standard tier rather than a
  smaller single-file tier.
- **No lifecycle hooks** — Cloudflare Workers are request-scoped: bindings arrive per invocation and
  nothing is held open across requests, so `onInit` / `onStart` / `onStop` are all unused and the app
  is driven without `start()` / `stop()`.
