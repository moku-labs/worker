# env

Core Plugin — Nano tier. Stage / dev-mode detection for `@moku-labs/worker`.

Flat-injected as `ctx.env` on every regular plugin's context (spec/02 §6). No state,
no events, no depends, no lifecycle hooks — pure read-only accessors over `config.stage`.

## API

All three methods are synchronous reads of the resolved `stage` config value.

| Method | Returns | Description |
|---|---|---|
| `isDev()` | `boolean` | `true` iff `stage === "development"` |
| `isProduction()` | `boolean` | `true` iff `stage === "production"` (false in "test") |
| `stage()` | `"production" \| "development" \| "test"` | The raw stage as the literal union |

Truth table:

| stage | isDev() | isProduction() |
|---|---|---|
| `"production"` | `false` | `true` |
| `"development"` | `true` | `false` |
| `"test"` | `false` | `false` |

`isDev()` and `isProduction()` are **both false** in the `"test"` stage — they are not
boolean inverses. This lets test runs opt out of both dev shortcuts and production side
effects.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `stage` | `"production" \| "development" \| "test"` | `"production"` | Deployment stage. Production-safe default. |

## Usage

The `env` plugin is a core plugin — it is not mounted on `app.env`. Access it via
`ctx.env` inside any regular plugin's `api` factory:

```typescript
import { createPlugin } from "@moku-labs/worker";

const myPlugin = createPlugin("myPlugin", {
  api: (ctx) => ({
    // Gate dev-only behavior:
    errorBody: (e: Error) =>
      ctx.env.isDev() ? e.stack ?? e.message : "Internal Error",

    // Gate production-only behavior:
    cacheControl: () =>
      ctx.env.isProduction() ? "public, max-age=31536000" : "no-store",

    // Three-way branch or logging:
    banner: () => `running in ${ctx.env.stage()} mode`,
  }),
});
```

## Configuration override

Pass `pluginConfigs.env.stage` to `createApp` to set the stage for a given deploy:

```typescript
import { createApp } from "@moku-labs/worker";

const app = createApp({
  pluginConfigs: {
    env: { stage: "development" },
  },
});
```

The framework wiring also forwards the top-level `config.stage` into
`pluginConfigs.env.stage` automatically, so typically no explicit override is needed.
