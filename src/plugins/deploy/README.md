# deploy

> Complex plugin (**node-only**, build-time) — turns a built Moku worker app (or any arbitrary Worker) into a deployed Cloudflare Worker with one call: aggregate each resource plugin's `deployManifest()` → generate a wrangler config → provision → upload → `wrangler deploy`.

## Overview

The `deploy` plugin is the build-time deploy orchestrator for `@moku-labs/worker`. It runs the full deploy pipeline:

```
detect → provision → wrangler-config → upload → deploy
```

1. **detect** — read each present resource plugin's `deployManifest()` via `ctx.require`, assembling one `ExternalManifest`.
2. **provision** — create the KV namespaces, R2 buckets, D1 databases, and Queues by shelling out to `wrangler`. (Durable Objects are config-only — see [Manifests](#manifests).)
3. **wrangler-config** — generate/update the wrangler config file (`wrangler.jsonc` by default) from the manifest, non-destructively.
4. **upload** — when a storage (R2) resource declares an `upload` directory, walk it recursively and `wrangler r2 object put` every file.
5. **deploy** — run `wrangler deploy` and parse the deployed URL from stdout.

Each stage emits a global `deploy:phase` event; each provisioned resource emits `provision:resource`; the final URL is emitted as `deploy:complete`.

### Node-only — runs in Node, tree-shaken from the runtime bundle

`deploy` is **not** part of the Cloudflare Workers runtime. It uses `node:child_process` (to spawn `wrangler`) and `node:fs` / `node:fs/promises` (to read and write the wrangler config and walk the upload directory), so it can only run in Node — in `scripts/*.ts` at deploy time, never inside the Cloudflare isolate at request time.

It is exported from the package root (the `@moku-labs/worker/cli` subpath remains as a back-compat alias). Import it from `@moku-labs/worker`:

```typescript
import { deployPlugin } from "@moku-labs/worker";
import type { ExternalManifest, ResourceManifest } from "@moku-labs/worker";
```

Its `node:*` graph reaches a bundle **only** when a consumer adds `deployPlugin` to `createApp({ plugins })`; because the package is `"sideEffects": false`, a request-time Worker that never adds it tree-shakes it away, keeping the Node built-ins out of the deployed bundle.

### Where it sits

`deploy` declares `depends: [storagePlugin, kvPlugin, d1Plugin, queuesPlugin, durableObjectsPlugin]`. It reads each dependency's `deployManifest()` api via `ctx.require` — it **never** reads a sibling's resolved config (a plugin can only see `ctx.global` plus its own `ctx.config`; `ctx.require` returns a plugin's *api*, never its config). The `cli` plugin sits one layer above and depends on `deployPlugin` to expose `app.cli.dev()` / `app.cli.deploy()`.

It is mounted as `app.deploy.*` like any regular plugin.

## Configuration

Configured under `pluginConfigs.deploy`. The config is flat and every field has a complete default, so omission never yields `undefined`.

| Field | Type | Default | Description |
|---|---|---|---|
| `configFile` | `string` | `"wrangler.jsonc"` | The wrangler config file `deploy` generates/updates and that `wrangler deploy` reads. Also the file parsed in the universal/non-moku path. |
| `ci` | `boolean` | `false` | CI / non-interactive mode. When `true` (or stdout is non-TTY), the guided flow never prompts. Cloudflare credentials are read from the Node env (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`), never from plugin config. |
| `seed` | `SeedConfig?` | — | The remote seed `run({ seed: true })` loads after a successful deploy (+ migration): `{ file: string; binding?: string; resetKv?: { binding; key }[] }` — the SQL file executed against the remote D1, then the cached KV keys to clear. Omit it and `run({ seed: true })` reports a clear "no seed configured" error. |

```typescript
import { createApp, deployPlugin } from "@moku-labs/worker";

const app = createApp({
  plugins: [/* resource plugins (kv, d1, storage, queues, durableObjects), */ deployPlugin],
  pluginConfigs: {
    deploy: {
      configFile: "wrangler.jsonc",
      ci: false,
      // Remote seed wired into `deploy({ seed: true })` (run only after a live deploy):
      seed: { file: "db/seed.sql", resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] }
    }
  }
});
```

## API

All methods are mounted on `app.deploy.*` and are invoked from thin Node-side `scripts/*.ts` passthroughs (and re-exposed by the `cli` plugin) — never from the deployed runtime.

### `run(opts?): Promise<DeployReport>`

```typescript
run(opts?: {
  ci?: boolean;
  stage?: string;
  webBuild?: WebBuild; // () => Promise<void> | Promise<{ files?: number }>
  manifest?: ExternalManifest;
  migration?: boolean; // apply remote D1 migrations after a successful deploy
  seed?: boolean;      // load the configured remote seed after a successful deploy (+ migration)
}): Promise<DeployReport>
```

Runs the full deploy pipeline. The phases execute, and emit, in this order:

1. `deploy:phase { phase: "auth" }` — verify the `.env` token (guided on a TTY; see below).
2. `deploy:phase { phase: "detect" }` — assemble the manifest.
3. `deploy:phase { phase: "provision" }` — then, per resource, `await` provisioning and emit `provision:resource { kind, name }`.
4. `deploy:phase { phase: "wrangler-config" }` — write the wrangler config file.
5. `deploy:phase { phase: "upload", detail: "<n> files" }` — **only** when an R2 resource has an `upload` directory; `n` is the uploaded file count.
6. `deploy:phase { phase: "deploy" }` — run `wrangler deploy`.
7. `deploy:complete { url }` — the parsed deployed URL.

**Post-deploy (migration + seed).** `run` owns the remote-DB steps so they run **only after a live deploy** and are **skipped on any abort** (a declined gate, or auth never set up) — the report's `status` is the gate. When `opts.migration` is set, pending D1 migrations are applied to the **remote** database for every configured d1 instance that ships a `migrations` dir. When `opts.seed` is set, the seed configured under `pluginConfigs.deploy.seed` (a SQL `file` + optional `resetKv` keys) is loaded into the remote D1 and its cached KV keys are cleared — after the migration (the seed needs the schema; a failed migration skips the seed). Each post-step folds its failure into the report (rendered inline, not thrown), so a deploy that went live but failed to seed still returns a complete report with `status: "failed"`.

**Manifest source.** When `opts.manifest` is omitted, the manifest is built from each *present* resource plugin's `deployManifest()` via `ctx.require`, gated by `ctx.has(name)` so absent plugins are skipped. When `opts.manifest` is supplied, it is used **verbatim** (the universal / non-moku path) and no `deployManifest()` calls are made.

| Option | Type | Description |
|---|---|---|
| `opts.ci` | `boolean` | CI/automated: never prompts, auto-confirms every gate. Omit/`false` → guided (interactive) whenever stdout is a TTY. Falls back to `ctx.config.ci`. |
| `opts.stage` | `string` | Target stage; suffixes resource names (`"production"` = bare). Falls back to the app stage. |
| `opts.webBuild` | `WebBuild` | Build the web site first (e.g. `() => webApp.cli.build()`). When supplied, an extra `deploy:phase { phase: "build", detail: "web" }` runs right after the auth preflight, before provisioning — so the generated assets exist before the R2 upload and `wrangler deploy`. Wired in from the consumer's app-side script (falls back to `ctx.config.webBuild`). |
| `opts.manifest` | `ExternalManifest` | Caller-supplied manifest; bypasses `deployManifest()` assembly. |
| `opts.migration` | `boolean` | After a **successful** deploy, apply pending D1 migrations to the remote DB for every configured d1 instance with a `migrations` dir. Skipped on an aborted deploy. |
| `opts.seed` | `boolean` | After a **successful** deploy (+ migration), load the seed configured under `pluginConfigs.deploy.seed` into the remote D1 and reset its cached KV keys. Skipped on an aborted deploy. |

**Returns:** a `DeployReport` — `{ ok, status: "deployed" | "aborted" | "failed", stage, url?, resources?, migration, seed, elapsedMs, errors }`. A successful run resolves after `deploy:complete` (and any post-deploy migration/seed); a guided run that the user stops resolves with `status: "aborted"` after emitting `deploy:phase { phase: "aborted" }` — and never touches the remote DB. `DeployReport` is exported from `@moku-labs/worker`.

**Guided recovery (TTY).** On an interactive terminal (not `ci`, stdout is a TTY) every failure point is *guided* rather than thrown:

- **Auth.** A missing/invalid `CLOUDFLARE_API_TOKEN` surfaces the reason, then offers a guided setup: it renders a **branded panel** of exactly which token to create (dashboard URL, the `"Edit Cloudflare Workers"` template, and which permissions to add — derived from your manifest, so D1/Queues are flagged) and **scaffolds a `.env.local`** (same guidance baked in as comments) for you to paste the token + account id into — never clobbering an existing one. The panel is shown whether or not `.env.local` already exists, so the next step is never a mystery. Because the env is snapshotted at app start, a freshly-pasted token only takes effect on a **new** run — the prompt points you there and the deploy aborts cleanly (`status: "aborted"`, no migration/seed). The same panel renders for the `auth setup` command (which also shows the reduced CI token).
- **Build / infra / upload / `wrangler deploy`.** A failure renders the error + a one-line hint, then offers **Retry?**. Provisioning re-plans each attempt, so a partially-created plan stays idempotent. Declining a retry aborts cleanly (the error is shown once, not re-rendered).

**Throws:** only in `ci` / non-interactive runs (fail-fast). The first failure — auth, infra preflight, provisioning, upload, or the wrangler subprocess (`[moku-worker] wrangler exited with code <n>` / `[moku-worker] Failed to spawn wrangler`) — propagates to the caller (the `cli` plugin renders it as a branded `✗` + non-zero exit).

```typescript
// Moku path — manifest assembled from each resource plugin's deployManifest()
await app.deploy.run(); // guided on a TTY; pass { ci: true } for the automated path

// Universal / non-moku path — deploy arbitrary Worker code from a supplied manifest
await app.deploy.run({
  manifest: {
    name: "legacy-worker",
    compatibilityDate: "2026-06-17",
    resources: [{ kind: "kv", binding: "CACHE" }]
  }
});
```

### `dev(opts?): Promise<void>`

```typescript
dev(opts?: {
  port?: number;
  webBuild?: WebBuild; // () => Promise<unknown> — full cold build (e.g. () => web.cli.build())
  onChange?: OnChange; // (changes: readonly string[]) => Promise<unknown> — incremental per-change rebuild
  seed?: boolean;      // load the configured seed into the LOCAL D1 before serving
}): Promise<void>
```

Starts a long-lived local dev session: cold-build the web site (when a `webBuild` hook is wired in), apply local D1 migrations, **(when `seed` is set) load the local seed**, spawn `wrangler dev --port <port> --config <configFile> --live-reload` **once** (default port `8787`), then watch the site sources and rebuild on change — wrangler's asset server live-reloads the browser; wrangler is never restarted for a site change. A failed rebuild emits `dev:error` and keeps serving the last good build. Build-time only; resolves on `SIGINT`.

The per-change rebuild takes the **fast path** when an `onChange` hook is wired: each debounced change calls `onChange(changedPaths)` (e.g. `c => web.cli.update(c)`) so only the changed paths rebuild. Omit `onChange` and each change runs a full `webBuild()` instead — the prior, backward-compatible behavior.

| Option | Type | Default | Description |
|---|---|---|---|
| `opts.port` | `number` | `8787` | Local dev port. |
| `opts.webBuild` | `WebBuild` | — | **Cold** build of the web site (e.g. `() => webApp.cli.build()`); also the per-change rebuild when `onChange` is omitted. Wired in from the consumer's app-side script (falls back to `ctx.config.webBuild`). Omit for a worker-only session. |
| `opts.onChange` | `OnChange` | — | **Incremental** per-change rebuild (e.g. `changes => webApp.cli.update(changes)`). When set, each debounced change rebuilds only the changed paths instead of a full `webBuild()`. |
| `opts.seed` | `boolean` | — | Load the seed configured under `pluginConfigs.deploy.seed` into the **local** D1 (and reset its cached KV keys) before serving — the local twin of `run({ seed: true })`. Forces the local migrate step first so the seed's tables exist (even if `migrateLocal` is off). |

**Throws:** propagates the wrangler subprocess `Error` on a non-zero exit / spawn failure.

```typescript
await app.deploy.dev({ port: 8787, webBuild: () => web.cli.build(), onChange: c => web.cli.update(c) });
```

### `init(opts?): Promise<void>`

```typescript
init(opts?: { ci?: boolean }): Promise<void>
```

Scaffolds a starting wrangler config at `ctx.config.configFile` (and, when `ci` is set, CI workflow files). **Idempotent** — an existing config file is left completely untouched. When the file does not exist, a minimal starter is written:

```jsonc
{
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "<today, YYYY-MM-DD>"
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `opts.ci` | `boolean` | `ctx.config.ci` | Also scaffold CI workflow files. Falls back to the plugin's `ci` config when omitted. |

**Returns:** resolves once scaffolding is written.

```typescript
await app.deploy.init({ ci: true });
```

## Manifests

The pipeline consumes a single `ExternalManifest`, assembled from the per-kind `ResourceManifest` descriptors each resource plugin returns from its own `deployManifest()`. Both types are exported from `@moku-labs/worker` (also via the `./cli` back-compat alias).

```typescript
// @moku-labs/worker
export type ResourceManifest =
  | { kind: "r2"; bucket: string; upload?: string }
  | { kind: "kv"; binding: string }
  | { kind: "d1"; binding: string; migrations?: string }
  | { kind: "queue"; producers: string[] }
  | { kind: "do"; bindings: Record<string, string> };

export type ExternalManifest = {
  name: string;
  compatibilityDate: string;
  resources: ResourceManifest[];
};
```

For the Moku path, `name` comes from `ctx.global.name` and `compatibilityDate` from `ctx.global.compatibilityDate`; `resources` is the filtered list of present plugins' manifests.

### How each resource plugin contributes

Each plugin's `deployManifest()` is a build-time, env-free read of its own `ctx.config`. The descriptor it returns drives both provisioning and the generated wrangler config:

| Plugin | `deployManifest()` returns | Provisioning (`wrangler …`) | wrangler config section |
|---|---|---|---|
| `storage` | `{ kind: "r2", bucket, upload? }` | `r2 bucket create <bucket>`; then, if `upload` is set, `r2 object put <bucket>/<key> --file <path>` per file | `r2_buckets: [{ binding: bucket, bucket_name: bucket.toLowerCase() }]` |
| `kv` | `{ kind: "kv", binding }` | `kv namespace create <binding>` | `kv_namespaces: [{ binding, id: "" }]` |
| `d1` | `{ kind: "d1", binding, migrations? }` | `d1 create <binding>`; then, if `migrations` is set, `d1 migrations apply <binding> --local` | `d1_databases: [{ binding, database_name: binding.toLowerCase(), database_id: "", migrations_dir? }]` |
| `queues` | `{ kind: "queue", producers }` | `queues create <producer>` per producer | `queues: { producers: [{ queue: producer, binding: producer.toUpperCase() }] }` |
| `durableObjects` | `{ kind: "do", bindings }` | none — config-only (no `wrangler do create` command exists) | `durable_objects: { bindings: [{ name, class_name }] }` |

Notes on the generated config:

- **R2 / D1 names** are derived by lower-casing the binding (`bucket_name`, `database_name`). The `id` / `database_id` fields are written empty (`""`) — wrangler / the Cloudflare API fill them on `deploy`.
- **Queue bindings** are derived by upper-casing each producer name.
- **Durable Objects** entries are built from `Object.entries(resource.bindings)` as `{ name: <value>, class_name: <key> }` — the map's keys become the DO `class_name` and its values become the binding `name`.
- The `name` used in `provision:resource` events is: the bucket (`r2`), the joined binding values (`do`), the joined producers (`queue`), or the binding (`kv` / `d1`).

### Universal / non-moku path

`run({ manifest })` accepts a caller-supplied `ExternalManifest` and runs the same provision → config → upload → deploy pipeline against it, deploying arbitrary Worker code without any resource plugins present. This is also how an existing `wrangler.jsonc` is targeted: `writeWranglerConfig` merges into the existing file non-destructively (top-level keys not managed by deploy are preserved).

## Events

`deploy` declares **no per-plugin events block**. It emits three signals, all of which are **global** events declared once in `src/config.ts` (`WorkerEvents`) so the `cli` plugin can hook them for live progress without depending on `deploy` purely for visibility:

| Event | Payload | Emitted |
|---|---|---|
| `deploy:phase` | `{ phase: string; detail?: string }` | At each pipeline stage: `"detect"`, `"provision"`, `"wrangler-config"`, `"upload"` (with `detail: "<n> files"`), `"deploy"`. |
| `provision:resource` | `{ kind: "kv" \| "r2" \| "d1" \| "queue" \| "do"; name: string }` | Once per provisioned resource. |
| `deploy:complete` | `{ url: string }` | After `wrangler deploy` succeeds. |

The plugin **listens to nothing** (no hooks). `emit` is fire-and-forget observability only — all work that must complete (provision, upload, `wrangler deploy`) is `await`ed through the api, never driven through `emit`. It never emits another plugin's event via a cast.

**Provision rendering = branded panels.** The infra plan (what will be created vs already exists vs ships with the Worker) and the provision result (created `✓` / skipped `~` / failed `✗`, with a summary — each failure's **full reason** ANSI-stripped, word-wrapped and printed below the box so it stays readable) are rendered by the deploy plugin as branded **boxes** (see `infra/render.ts`) — both interactively and in CI. The `provision:plan` / `provision:resource` / `provision:skip` events are still emitted (a consumer can hook them), but the `cli` plugin no longer renders them as flat `›` lines, so the panels are the single, un-duplicated provision view. Provisioning is **resilient**: one resource that fails to create (e.g. an invalid R2 bucket name) is captured in the result's `failed` list and shown — it never aborts the rest. On a TTY the run then offers to retry the failed resources; in CI it fails fast.

**Durable Objects ship with the Worker.** Unlike KV / D1 / R2 / Queues, a Durable Object namespace is **not** provisioned through the Cloudflare account API — it is created by `wrangler deploy` applying the auto-derived DO migration. So the planner never lists or queries the account for DOs: it puts them in the plan's own `ships` bucket and renders them as `~ do <ClassName> (ships with worker)` (never `(exists)`, which would falsely imply the planner verified them against the account). The plan summary counts them separately (`… · 1 with worker`), and `provision:plan` carries a `ships` count alongside `exists` / `missing`. A consequence worth knowing: because the planner never checks, it also cannot detect a DO namespace that was deleted out-of-band while the Worker stayed deployed — `wrangler`'s migration history still marks it applied, so a redeploy will not recreate it. Delete the Worker (or add a new migration tag) to force a fresh DO namespace.

## Usage

A realistic end-to-end Node deploy script. The resource plugins (`storage`, `kv`, `d1`, `queues`, `durableObjects`) and `deployPlugin` are listed as consumer extras — but `bindingsPlugin` and `serverPlugin` are **framework defaults** baked into the exported `createApp` (`[log, env, stage, bindings, server]`), so they must **not** be re-listed: the final plugin list is `[...frameworkDefaults, ...consumerExtras]`, and a duplicate name throws `TypeError: [moku-worker] Duplicate plugin name: "bindings".`. Each resource plugin declares `depends: [bindingsPlugin]`, which is already satisfied by the default; `createApp` still throws a `TypeError` on a missing/out-of-order *consumer* dependency, so resource plugins must precede `deployPlugin`.

```typescript
// scripts/deploy.ts — run with `node scripts/deploy.ts` (or via your task runner)
import { createApp } from "@moku-labs/worker";
import {
  storagePlugin,
  kvPlugin,
  d1Plugin,
  deployPlugin,
  durableObjectsPlugin,
  queuesPlugin
} from "@moku-labs/worker";

const app = createApp({
  config: {
    name: "my-worker",
    compatibilityDate: "2026-06-17",
    stage: "production"
  },
  // bindings + server are framework defaults — do NOT re-list them (duplicate name throws).
  plugins: [
    storagePlugin,
    kvPlugin,
    d1Plugin,
    queuesPlugin,
    durableObjectsPlugin,
    deployPlugin
  ],
  pluginConfigs: {
    storage: { bucket: "ASSETS", upload: "./public" },
    kv: { binding: "CACHE" },
    d1: { binding: "DB", migrations: "./migrations" },
    queues: { producers: ["orders"] },
    durableObjects: { bindings: { Counter: "COUNTER" } },
    deploy: { configFile: "wrangler.jsonc", ci: false }
  }
});

// Generate a starter config the first time (idempotent thereafter).
await app.deploy.init();

// Aggregate manifests → provision → write wrangler config → upload → wrangler deploy.
await app.deploy.run({ ci: process.argv.includes("--ci") });
```

A stateless deploy never calls `app.start()` / `app.stop()` — the pipeline is one-shot and driven entirely by the explicit `app.deploy.*` call.

To observe progress, subscribe to the global events (this is exactly what the `cli` plugin's hooks do):

```typescript
// Inside a plugin's hooks(register) — live progress without depending on deploy:
hooks: (register) => {
  register("deploy:phase", ({ phase, detail }) =>
    console.log(`▸ ${phase}${detail ? ` (${detail})` : ""}`)
  );
  register("provision:resource", ({ kind, name }) =>
    console.log(`  provisioned ${kind}: ${name}`)
  );
  register("deploy:complete", ({ url }) => console.log(`✓ deployed → ${url}`));
}
```

## Integration

- **Resource plugins (`storage`, `kv`, `d1`, `queues`, `durableObjects`).** `deploy` depends on all five and reads each one's `deployManifest()` via `ctx.require`, gated by `ctx.has(name)` so plugins absent from `createApp({ plugins })` are skipped. It never reads their `pluginConfigs` — the manifest api is the only contract. See [Manifests](#manifests) for how each descriptor maps to provisioning and the wrangler config.
- **`cli` plugin.** `cli` declares `depends: [deployPlugin]` and exposes `app.cli.dev()` / `app.cli.deploy()` as thin passthroughs to `app.deploy.dev()` / `app.deploy.run()`, plus hooks that render the three global deploy events as a live TUI. Both `cliPlugin` and `deployPlugin` are exported from `@moku-labs/worker` (the `@moku-labs/worker/cli` subpath is a back-compat alias).
- **`wrangler`.** Invoked as a subprocess (resolved from `node_modules/.bin`) for `kv namespace create`, `r2 bucket create`, `r2 object put`, `d1 create`, `d1 migrations apply`, `queues create`, `dev`, and `deploy`. It is a peer/dev dependency, never bundled.

## Design notes

- **Node-only — tree-shaken from the runtime, not walled off.** `deploy` imports `node:child_process` and `node:fs`, which cannot run in the Cloudflare isolate. It is exported from `src/index.ts` (`@moku-labs/worker`) alongside `cliPlugin` (the `./cli` entry is now a back-compat alias), but its `node:*` graph reaches a bundle **only** when a consumer lists it in `createApp({ plugins })`. Because the package is `"sideEffects": false`, a request-time Worker that imports `createApp` and never adds `deployPlugin` tree-shakes it away, keeping the Node built-ins out of the deployed bundle.
- **Manifest, not sibling config (F6).** A plugin can only read `ctx.global` and its own `ctx.config`; `ctx.require` returns a plugin's *api*, never its config. So `deploy` sources every resource descriptor from the producing plugin's `deployManifest()` api — not from `pluginConfigs`. The five `depends` entries make those apis reachable via `ctx.require` and double as a presence gate (`ctx.has`).
- **Global events, no events block (F2).** `deploy`'s three signals are global `WorkerEvents`, declared once in `src/config.ts`, so observers (the `cli` TUI) hook them without a `depends` purely for visibility. `deploy` declares no `events` block and never emits a foreign plugin's event via a cast — R2 upload progress is surfaced as `deploy:phase { phase: "upload" }`, not as a `storage:*` emit.
- **No state, no hooks, no lifecycle.** Every invocation (`run` / `dev` / `init`) is a one-shot build-time orchestration over the resource manifests, `ctx.global`, the Node filesystem, and the `wrangler` subprocess. Cloudflare Workers are request-scoped, so there is no long-lived connection to open or close — `createState`, `hooks`, and `onInit`/`onStart`/`onStop` are all omitted.
- **Complex tier.** The complexity comes from the per-resource provider adapters (`providers/{kv,r2,d1,queues,do}.ts` plus their dispatcher `providers/index.ts`), the wrangler config generator (`wrangler-config.ts`), and the subprocess runner (`runner.ts`) — each kept as a small, independently testable pure function so the pipeline can be unit-tested by stubbing the wrangler runner and filesystem (no real Cloudflare account required).
