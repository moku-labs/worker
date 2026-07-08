# turn

> **Nano tier** plugin — Cloudflare **Realtime TURN keys** as first-class deploy resources, the same
> shape as `kv`/`d1`/`r2`/`queues`: declare instances under `pluginConfigs.turn`, and the deploy
> pipeline ensures them.

WebRTC apps (e.g. one composing `@moku-labs/room/server`'s hub) need a TURN relay rung for hostile
NATs. Cloudflare's Realtime TURN service mints short-lived credentials from a **TURN key** — whose
secret is returned **exactly once** at creation. This plugin makes that key a declared resource so no
one ever does the dashboard + `wrangler secret put` dance by hand.

## Configuration (`pluginConfigs.turn`)

```ts
turn: { relay: { name: "myapp-turn" } }
// optional overrides: keyIdBinding (default "TURN_KEY_ID"), apiTokenBinding (default "TURN_KEY_API_TOKEN")
```

`name` is stage-suffixed like every provisioned resource name (`myapp-turn-dev` on `--stage dev`).

## What the deploy pipeline does

TURN keys are ensured in the **post-deploy phase** (next to the remote migration/seed), not the
provision phase — worker secrets can only bind to an EXISTING script:

1. List the worker's secret names (read-only, idempotent). Both bound → no-op (`turn: "exists"`).
2. Otherwise create a TURN key (`POST /accounts/{account_id}/calls/turn_keys` — needs the
   **Calls `Edit`** scope on `CLOUDFLARE_API_TOKEN`; `auth setup` lists it automatically when a turn
   resource is declared) and bind its id + secret as the two worker secrets (`turn: "provisioned"`).
   Everything runs over the Cloudflare REST API — secret values never touch argv or disk.
3. **Strictly fail-open**: no token / missing scope / any API failure prints ONE actionable
   instruction line and the deploy continues (`turn: "degraded"`) — the app's ICE ladder falls back
   to STUN, so a TURN-less deploy is degraded, not broken. Never prompts (`--ci` safe).

A half-bound pair (a torn earlier run) is re-ensured with a FRESH key — the old key's secret is
unrecoverable by design. Teardown (`--delete`) removes the worker and with it the secrets; the
account-level TURN key itself is left in place (harmless; delete it in the dashboard if desired).

## Public API (`app.turn`)

| Method | Notes |
|---|---|
| `deployManifest()` | One `{ kind: "turn", name, keyIdBinding, apiTokenBinding }` per configured instance (defaults resolved). Build-time only. |

No runtime surface: the worker reads the two bound secrets straight off `env` by the configured
binding names.
