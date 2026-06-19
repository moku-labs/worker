# cli

> Standard tier, **node-only** — the developer-facing command-line front door (`dev` / `deploy`) for a `@moku-labs/worker` project. Thin passthroughs to the `deploy` plugin, plus a live progress TUI. Imported from `@moku-labs/worker/cli`, **never** from `@moku-labs/worker`.

## Overview

The `cli` plugin is the small surface a server project drives from a Node script: two build-time verbs — `app.cli.dev()` (run the Worker locally) and `app.cli.deploy()` (one-command Cloudflare deploy). It does **no work itself**. Both verbs are thin passthroughs that forward to the `deploy` plugin via `ctx.require(deployPlugin)`. The single piece of value `cli` adds on top of `deploy` is a **live progress TUI**: it subscribes (via `hooks`) to the three **global** deploy events and prints them through the injected core logger `ctx.log`.

**Node-only.** `cli` runs in Node — inside a `scripts/*.ts` file or a `bin`, at build/deploy time — never inside the Cloudflare isolate at request time. Accordingly it is excluded from the deployed Worker bundle and lives behind a separate package entry:

```typescript
// Node tooling (scripts/*.ts) — the ONLY place cli is imported from:
import { cliPlugin } from "@moku-labs/worker/cli";

// The request-time Worker bundle imports from the bare entry, which does NOT include cli:
import { createApp } from "@moku-labs/worker";
```

`cli` is a **single-dependency** plugin: it depends only on `deploy` (`depends: [deployPlugin] as const`). The edge exists purely so `ctx.require(deployPlugin)` is legal and type-safe — it is not required for event visibility, because the deploy events are global. `cli` holds **no state** and emits **no events of its own**; its one lifecycle hook is an `onInit` that **always** installs the branded log sink (see [Configuration](#configuration)).

## Configuration

Configured through `pluginConfigs.cli`. The config is flat with a complete default, so omitting it never yields `undefined`. The resolved object is frozen after `createApp()`.

| Field  | Type     | Default | Description |
|--------|----------|---------|-------------|
| `port` | `number` | `8787`  | Default local dev port. Used **only** when `dev()` is called with no `port` override; passed through to `deploy.dev({ port })` → `wrangler dev --port <n>`. |

> [!NOTE]
> The deploy progress TUI is **always** branded — there is no config flag and no opt-out. At `onInit` the plugin clears the default object-dump log sink and installs `brandedSink()` from [`@moku-labs/common/cli`](https://github.com/moku-labs/common) (node-only; the Worker runtime bundle excludes `cli`, so its logging is untouched). A consistent branded CLI across the family is an invariant, not an option.

```typescript
import { createApp } from "@moku-labs/worker";
import { cliPlugin } from "@moku-labs/worker/cli";

const app = createApp({
  // deploy + its resource deps (kv, d1, storage, queues, durableObjects) — NOT bindings/server (defaults).
  plugins: [/* …resource plugins…, deployPlugin, */ cliPlugin],
  pluginConfigs: {
    cli: { port: 3000 }
  }
});
```

## API

Two public methods, both mounted on `app.cli.*` (regular plugins mount on `app.<name>`). Each returns the awaitable the `deploy` plugin returns — the work goes through API methods, never `emit`.

### `dev`

```typescript
dev(opts?: { port?: number }): Promise<void>
```

Run the Worker locally via Wrangler. Delegates to `ctx.require(deployPlugin).dev(...)`. When called with **no opts**, it forwards the configured default port as `{ port: ctx.config.port }` (8787 by default); when given a port, it forwards that override verbatim.

```typescript
await app.cli.dev();              // → deploy.dev({ port: 8787 })
await app.cli.dev({ port: 3000 }); // → deploy.dev({ port: 3000 })
```

### `deploy`

```typescript
deploy(opts?: { guided?: boolean; yes?: boolean }): Promise<void>
```

Run the one-command Cloudflare deploy. Delegates to `ctx.require(deployPlugin).run(opts)`, forwarding `opts` **verbatim** — when called with no opts it passes `undefined` (not a default empty object). While `deploy.run` executes its `detect → provision → wrangler-config → upload → deploy` pipeline, it emits the global `deploy:*` / `provision:resource` events that this plugin's hooks turn into the live progress TUI (see [Events](#events)).

- `guided` — walk through each step interactively.
- `yes` — skip confirmation prompts (non-interactive / CI / non-TTY).

```typescript
await app.cli.deploy({ guided: true });
await app.cli.deploy({ yes: true }); // CI
await app.cli.deploy();              // opts === undefined forwarded to deploy.run
```

> `cli.deploy` exposes only `{ guided?, yes? }`. The underlying `deploy.run` also accepts a `manifest` (the universal/non-Moku path); to use it, call `app.deploy.run({ manifest })` directly — `cli` deliberately does not surface it.

## Events

`cli` **emits no events of its own.** It is a pure consumer of the three **global** deploy events — declared once in `src/config.ts` (`WorkerEvents`) and emitted by the `deploy` plugin during `deploy.run(...)`. Because they are global, `cli`'s hooks see them regardless of the `depends` edge. Each handler reads only its typed payload and logs a clean, prefix-free message via the injected core logger `ctx.log`. The cli plugin installs the **branded** log sink from `@moku-labs/common/cli` at `onInit` (always — replacing the default object-dump sink), so every line renders with the family `›` marker and brand color — `⚠`/`✗` to stderr — matching `@moku-labs/web`. Handlers are pure fire-and-forget observers: they print and return; they never mutate state and never block the deploy pipeline.

| Event (listened) | Payload (from `WorkerEvents`) | Rendered line (branded) |
|------------------|-------------------------------|-------------------------|
| `deploy:phase` | `{ phase: string; detail?: string }` | `  › <phase>` — or `  › <phase> · <detail>` when `detail` is present. One line per pipeline phase (`detect`, `provision`, `wrangler-config`, `upload`, `deploy`). |
| `provision:resource` | `{ kind: "kv" \| "r2" \| "d1" \| "queue" \| "do"; name: string }` | `  › <kind> <name>` — one line per provisioned resource. |
| `deploy:complete` | `{ url: string }` | `  › deployed → <url>` — terminal success line with the deployed URL. |

A full guided deploy therefore streams something like:

```text
  › detect
  › provision
  › kv CACHE
  › d1 DB
  › wrangler-config
  › upload · 3 files
  › deploy
  › deployed → https://my-worker.workers.dev
```

## Usage

A realistic Node CLI entry. `cli` is driven by a thin `scripts/*.ts` passthrough — there is **no `bin` and no argv parser inside the plugin**; the consumer's script owns argument handling and calls `await app.cli.<verb>(...)`.

```typescript
// scripts/cli.ts — node-only entry; run with `bun scripts/cli.ts <command>`
import { createApp } from "@moku-labs/worker";
import {
  d1Plugin,
  durableObjectsPlugin,
  kvPlugin,
  queuesPlugin,
  storagePlugin
} from "@moku-labs/worker";
import { cliPlugin, deployPlugin } from "@moku-labs/worker/cli";

// bindings + server are framework defaults baked into the exported createApp
// ([log, env, stage, bindings, server]) — do NOT re-list them or createApp throws
// `TypeError: [moku-worker] Duplicate plugin name: "bindings".`. Among the CONSUMER
// extras, every `depends` target must still be registered EARLIER in the array:
// cli → deploy → [storage, kv, d1, queues, durableObjects] (→ bindings, already a default).
const app = createApp({
  plugins: [
    storagePlugin,
    kvPlugin,
    d1Plugin,
    queuesPlugin,
    durableObjectsPlugin,
    deployPlugin,
    cliPlugin
  ],
  pluginConfigs: {
    cli: { port: 8787 }
  }
});

const command = process.argv[2];

if (command === "dev") {
  const portArg = process.argv[3];
  await app.cli.dev(portArg ? { port: Number(portArg) } : undefined);
} else if (command === "deploy") {
  const ci = process.argv.includes("--ci");
  await app.cli.deploy(ci ? { yes: true } : { guided: true });
} else {
  throw new Error(`unknown command: ${String(command)} (expected "dev" or "deploy")`);
}
```

```bash
bun scripts/cli.ts dev            # wrangler dev --port 8787
bun scripts/cli.ts dev 3000       # wrangler dev --port 3000
bun scripts/cli.ts deploy         # guided deploy, live TUI
bun scripts/cli.ts deploy --ci    # non-interactive deploy
```

## Integration

`cli` sits one layer above `deploy` and delegates everything to it:

| `cli` verb | Delegates to |
|------------|--------------|
| `app.cli.dev(opts?)` | `ctx.require(deployPlugin).dev(opts ?? { port: ctx.config.port })` |
| `app.cli.deploy(opts?)` | `ctx.require(deployPlugin).run(opts)` |

The resource plugins (`storage`/R2, `kv`, `d1`, `queues`, `durableObjects`) are reached only **transitively**, through `deploy`. `cli` never imports or requires them: `deploy` is the one that declares `depends: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin]`, assembles each resource's `deployManifest()`, provisions, writes the wrangler config, uploads, and runs `wrangler deploy` — emitting the global events `cli` renders. `cli` reads neither `deploy`'s config nor any sibling `pluginConfigs`; `ctx.require` returns a plugin's API, never its config.

The `@moku-labs/worker/cli` entry (`src/cli.ts`) re-exports `cliPlugin`, `deployPlugin`, and the deploy manifest types `ExternalManifest` / `ResourceManifest`, so a Node script can compose the full deploy toolchain from one import path.

## Design notes

- **Node-only exclusion from the Worker bundle (HC11).** `cli` is exported only from the package `./cli` entry (`src/cli.ts`) and is deliberately **not** re-exported from `src/index.ts` (the bare `.` barrel that `createApp` ships in). The deployed Worker bundle must never import deploy tooling. `cli`'s own dependency, `deploy`, is node-only too (it reaches for `node:child_process` and `node:fs`), so keeping both behind `./cli` keeps Node built-ins out of the isolate bundle.
- **Standard tier rationale.** A domain function — the `deploy:phase` formatter — exceeds the trivial-inline bar, so the verbs live in `api.ts` and the three TUI formatters in `handlers.ts`, leaving `index.ts` as a wiring harness under 50 lines. The `api` and `hooks` fields are passed as inline lambdas `(ctx) => ...` to preserve event-name inference, so the hook-map keys are constrained to `WorkerEvents` keys.
- **Single-dependency `require`.** `cli` depends on exactly one plugin, so its context types `require` as a single typed method — `require(plugin: typeof deployPlugin): DeployApi` — rather than the general multi-plugin `RequireFn` that `deploy` itself uses. This mirrors the `kv` single-dep overload pattern and gives `ctx.require(deployPlugin)` a precise `dev` / `run` / `init` return type.
- **No state; one lifecycle hook.** Nothing to retain (`createState` is omitted). The sole lifecycle hook is `onInit`, which **always** swaps the default object-dump log sink for `brandedSink()` from `@moku-labs/common/cli` (node-only, so the Worker runtime bundle is unaffected). No `onStart` / `onStop`: there is no long-lived connection, socket, or pool to open or close.
- **No external runtime packages.** The TUI is `ctx.log` lines rendered by the branded sink from `@moku-labs/common/cli` (zero-dependency ANSI) — no argv parser, no `bin`, no third-party TUI library inside the plugin. All Wrangler/Cloudflare interaction lives in `deploy`, not here.
