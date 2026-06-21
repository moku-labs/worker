# cli

> Standard tier, **node-only** — the developer-facing command-line front door (`dev` / `deploy`) for a `@moku-labs/worker` project. Thin passthroughs to the `deploy` plugin, plus a live progress TUI. Exported from `@moku-labs/worker` (the `@moku-labs/worker/cli` subpath remains as a back-compat alias).

## Overview

The `cli` plugin is the small surface a server project drives from a Node script: two build-time verbs — `app.cli.dev()` (run the Worker locally) and `app.cli.deploy()` (one-command Cloudflare deploy). It does **no work itself**. Both verbs are thin passthroughs that forward to the `deploy` plugin via `ctx.require(deployPlugin)`. The single piece of value `cli` adds on top of `deploy` is a **live progress TUI**: it subscribes (via `hooks`) to the three **global** deploy events and prints them through the injected core logger `ctx.log`.

**Node-only.** `cli` runs in Node — inside a `scripts/*.ts` file or a `bin`, at build/deploy time — never inside the Cloudflare isolate at request time. It ships from the package root, but its `node:*` graph reaches a bundle only when a consumer adds it to `createApp({ plugins })`; `"sideEffects": false` tree-shakes it out of a request-time Worker that never does:

```typescript
// Node tooling (scripts/*.ts) — add cliPlugin to the app you compose:
import { cliPlugin, createApp } from "@moku-labs/worker";

// A request-time Worker that imports only createApp tree-shakes cli away:
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
import { cliPlugin, createApp } from "@moku-labs/worker";

const app = createApp({
  // deploy + its resource deps (kv, d1, storage, queues, durableObjects) — NOT bindings/server (defaults).
  plugins: [/* …resource plugins…, deployPlugin, */ cliPlugin]
});
// cli takes no config — the dev port is a `dev()` argument: `app.cli.dev({ port: 3000 })`.
```

## API

Two public methods, both mounted on `app.cli.*` (regular plugins mount on `app.<name>`). Each returns the awaitable the `deploy` plugin returns — the work goes through API methods, never `emit`.

### `dev`

```typescript
dev(opts?: {
  port?: number;
  stage?: string;
  webBuild?: WebBuild; // () => Promise<unknown> — full cold build (e.g. () => web.cli.build())
  onChange?: OnChange; // (changes: readonly string[]) => Promise<unknown> — incremental per-change rebuild
}): Promise<void>
```

Run the Worker locally via Wrangler. Prints a branded dev-session banner, then delegates to `ctx.require(deployPlugin).dev(...)`. The dev port comes **only** from `opts.port` — the consumer passes it (e.g. parsed from its own CLI flags in `scripts/dev.ts`); it defaults to 8787 when omitted. There is no hidden argv/config port resolution. `webBuild` is the **cold** build; `onChange` (when wired) is the **incremental** per-change rebuild — each change rebuilds only the changed paths instead of a full `webBuild()`. A failure renders a branded `✗` line and sets a non-zero exit code rather than throwing.

```typescript
await app.cli.dev();               // port from --port, else 8787 → deploy.dev({ port })
await app.cli.dev({ port: 3000 }); // explicit override → deploy.dev({ port: 3000 })
// Compose a web client: full cold build + incremental per-change rebuilds.
await app.cli.dev({ port: 3000, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
```

### `deploy`

```typescript
deploy(opts?: { ci?: boolean; webBuild?: WebBuild }): Promise<void>
```

Run the one-command Cloudflare deploy. Delegates to `ctx.require(deployPlugin).run(opts)`, forwarding `opts` **verbatim** — when called with no opts it passes `undefined`. While `deploy.run` executes its `detect → provision → wrangler-config → upload → deploy` pipeline, it emits the global `deploy:*` / `provision:resource` events that this plugin's hooks turn into the live progress TUI (see [Events](#events)). A failure is caught into a branded `✗` line + non-zero exit code (matching `auth`/`doctor`), never a raw stack trace.

- `ci` — automated/non-interactive: never prompts, auto-confirms. Omit or `false` → guided (interactive) on a TTY.
- `webBuild` — build the web site first (e.g. `() => webApp.cli.build()`), before `wrangler deploy`.

```typescript
await app.cli.deploy();             // guided on a TTY
await app.cli.deploy({ ci: true }); // automated (CI)
```

> `cli.deploy` exposes `{ ci?, webBuild? }`. The underlying `deploy.run` also accepts a `manifest` (the universal/non-Moku path); to use it, call `app.deploy.run({ manifest })` directly — `cli` deliberately does not surface it.

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
import { cliPlugin, deployPlugin } from "@moku-labs/worker";
import { web } from "./web"; // your @moku-labs/web app — web.cli.build() rebuilds the site

// bindings + server are framework defaults baked into the exported createApp
// ([log, env, stage, bindings, server]) — do NOT re-list them or createApp throws
// `TypeError: [moku-worker] Duplicate plugin name: "bindings".`. Among the CONSUMER
// extras, every `depends` target must still be registered EARLIER in the array:
// cli → deploy → [storage, kv, d1, queues, durableObjects] (→ bindings, already a default).
const server = createApp({
  plugins: [
    storagePlugin,
    kvPlugin,
    d1Plugin,
    queuesPlugin,
    durableObjectsPlugin,
    deployPlugin,
    cliPlugin
  ]
});

// The script is the wiring point: pass the web build into dev/deploy so one small
// app-side script composes the Moku Web app with this Worker framework. dev does ONE cold
// build then rebuilds incrementally per change (onChange); deploy builds once before deploy.
const webBuild = () => web.cli.build();
const onChange = (changes: readonly string[]) => web.cli.update(changes);
const command = process.argv[2];

if (command === "dev") {
  // Port is framework-resolved from a `--port <n>` flag, else 8787 — no manual parsing.
  // onChange = fast incremental rebuild of only the changed paths (omit it → full webBuild per change).
  await server.cli.dev({ webBuild, onChange });
} else if (command === "deploy") {
  // Not CI → guided/interactive; `--ci` → automated, non-interactive.
  await server.cli.deploy({ ci: process.argv.includes("--ci"), webBuild });
} else {
  throw new Error(`unknown command: ${String(command)} (expected "dev" or "deploy")`);
}
```

```bash
bun scripts/cli.ts dev              # wrangler dev --port 8787, web recompiles on change
bun scripts/cli.ts dev --port 3000 # wrangler dev --port 3000
bun scripts/cli.ts deploy          # build web → guided deploy, live TUI
bun scripts/cli.ts deploy --ci     # non-interactive deploy
```

A worker-only app omits the `webBuild` hook entirely (`server.cli.dev()` / `server.cli.deploy()`); dev then serves the worker without recompiling a site.

## Integration

`cli` sits one layer above `deploy` and delegates everything to it:

| `cli` verb | Delegates to |
|------------|--------------|
| `app.cli.dev(opts?)` | `ctx.require(deployPlugin).dev({ port: opts?.port, stage?, webBuild?, onChange? })` (each forwarded only when given; port defaults to 8787 downstream) |
| `app.cli.deploy(opts?)` | `ctx.require(deployPlugin).run(opts)` |

Both verbs accept an optional `webBuild` hook (`() => webApp.cli.build()`): `dev` cold-builds the web site with it, `deploy` builds it once before `wrangler deploy`. `dev` additionally accepts an `onChange` hook (`changes => webApp.cli.update(changes)`) — the **incremental** per-change rebuild that recompiles only the changed paths instead of a full `webBuild()` every keystroke (omit it for the prior full-rebuild behavior). The hooks are threaded straight through to `deploy`; `cli` adds only the port default.

The resource plugins (`storage`/R2, `kv`, `d1`, `queues`, `durableObjects`) are reached only **transitively**, through `deploy`. `cli` never imports or requires them: `deploy` is the one that declares `depends: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin]`, assembles each resource's `deployManifest()`, provisions, writes the wrangler config, uploads, and runs `wrangler deploy` — emitting the global events `cli` renders. `cli` reads neither `deploy`'s config nor any sibling `pluginConfigs`; `ctx.require` returns a plugin's API, never its config.

The package root (`@moku-labs/worker`) exports `cliPlugin`, `deployPlugin`, and the deploy manifest types `ExternalManifest` / `ResourceManifest`, so a Node script composes the full deploy toolchain from one import path; the `@moku-labs/worker/cli` entry (`src/cli.ts`) re-exports the same names as a back-compat alias.

## Design notes

- **Node-only — tree-shaken from the Worker bundle, not walled off.** `cli` (and its dependency `deploy`, which reaches for `node:child_process` / `node:fs`) ship from `src/index.ts` (`@moku-labs/worker`) — the `./cli` entry is now a back-compat alias. Their Node built-ins reach a bundle only when a consumer adds them to `createApp({ plugins })`; because the package is `"sideEffects": false`, a request-time Worker that imports only `createApp` tree-shakes them away, keeping the isolate bundle clean without a separate entry point.
- **Standard tier rationale.** A domain function — the `deploy:phase` formatter — exceeds the trivial-inline bar, so the verbs live in `api.ts` and the three TUI formatters in `handlers.ts`, leaving `index.ts` as a wiring harness under 50 lines. The `api` and `hooks` fields are passed as inline lambdas `(ctx) => ...` to preserve event-name inference, so the hook-map keys are constrained to `WorkerEvents` keys.
- **Single-dependency `require`.** `cli` depends on exactly one plugin, so its context types `require` as a single typed method — `require(plugin: typeof deployPlugin): DeployApi` — rather than the general multi-plugin `RequireFn` that `deploy` itself uses. This mirrors the `kv` single-dep overload pattern and gives `ctx.require(deployPlugin)` a precise `dev` / `run` / `init` return type.
- **No state; one lifecycle hook.** Nothing to retain (`createState` is omitted). The sole lifecycle hook is `onInit`, which **always** swaps the default object-dump log sink for `brandedSink()` from `@moku-labs/common/cli` (node-only, so the Worker runtime bundle is unaffected). No `onStart` / `onStop`: there is no long-lived connection, socket, or pool to open or close.
- **No external runtime packages.** The TUI is `ctx.log` lines rendered by the branded sink from `@moku-labs/common/cli` (zero-dependency ANSI) — no argv parser, no `bin`, no third-party TUI library inside the plugin. All Wrangler/Cloudflare interaction lives in `deploy`, not here.
