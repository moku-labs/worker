# stage

Core plugin (Nano tier) — deployment-stage / dev-mode detection for `@moku-labs/worker`.

Flat-injected as `ctx.stage` on every regular plugin's context (spec/02 §6). No state, no events, no dependencies, no lifecycle.

> **Why a worker-local plugin?** `log` and `env` come from `@moku-labs/common` — but common's `env` plugin is **environment-variable access** (`get`/`require`/`has`), not deployment-stage detection. The worker's stage need (`isDev`/`isProduction`) is therefore its own small core plugin rather than a reimplementation of common's `env`.

## Config

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stage` | `"production" \| "development" \| "test"` | `"production"` | Deployment stage. Production-safe default — an unspecified app behaves as production. |

The framework forwards `WorkerConfig.stage` into this plugin via `pluginConfigs.stage.stage`.

## API (`ctx.stage`)

| Method | Returns | Description |
|--------|---------|-------------|
| `isDev()` | `boolean` | `true` iff `stage === "development"`. |
| `isProduction()` | `boolean` | `true` iff `stage === "production"`. Note: `false` in `"test"`. |
| `current()` | `"production" \| "development" \| "test"` | The raw stage as the literal union (not `string`). |

`isDev()` and `isProduction()` are **both `false`** in the `"test"` stage — they are not boolean inverses, which lets test runs opt out of both dev shortcuts and production side effects.

## Example

```typescript
// Inside any regular plugin's api factory (core injection — ctx.stage):
api: (ctx) => ({
  errorBody: (e: Error) =>
    ctx.stage.isDev() ? e.stack ?? e.message : "Internal Error",
  cacheControl: () =>
    ctx.stage.isProduction() ? "public, max-age=31536000" : "no-store",
  banner: () => `running in ${ctx.stage.current()} mode`
});
```
