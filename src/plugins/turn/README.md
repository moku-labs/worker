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

## What the deploy pipeline does — the STANDARD resource flow

1. **Preflight** (`checkInfra` / the plan panel): a turn resource **exists when BOTH its secrets
   are bound on the worker** — a hand-bound key (`wrangler secret put`) counts and is never
   clobbered; a same-name key whose secret was never bound does NOT (the secret is returned exactly
   once at creation and is unrecoverable). The account key listing is best-effort (no Calls scope
   needed just to plan); it feeds stale-key cleanup and teardown ids. The resource shows in the
   plan like any other: `turn myapp-turn` under *exists* or *will create*.
2. **Provision phase** (alongside kv/d1/r2/queues): a stale same-name key is deleted, the key is
   created (`POST /accounts/{account_id}/calls/turn_keys` — needs **Cloudflare Calls `Edit`** on
   `CLOUDFLARE_API_TOKEN`; `auth setup` lists it automatically), and the once-returned credentials
   are held in memory. Announced via `provision:resource` like every resource.
3. **Right after `wrangler deploy`** the credentials bind as the two worker secrets — the one step
   that physically must follow the deploy (secrets need an existing script; the same class as the
   DO migration wrangler applies at deploy). All REST — values never touch argv or disk.
4. **Failures are loud but DEGRADED-class**: a per-step error (`create turn_keys → HTTP 403 (…)`)
   renders as a warning in the provision panel with one actionable instruction line, and the deploy
   **continues** (`turn: "degraded"`) — the app's ICE ladder falls back to STUN. Never prompts
   (`--ci` safe); never fails a live deploy. A torn run self-heals: the next deploy sees the
   unbound pair and recreates.

Teardown (`--delete`) removes the worker (secrets with it) and deletes the TURN key **only when
attributable** (a key matching the configured stage-qualified name); a hand-created key under
another name is left alone.

## Public API (`app.turn`)

| Method | Notes |
|---|---|
| `deployManifest()` | One `{ kind: "turn", name, keyIdBinding, apiTokenBinding }` per configured instance (defaults resolved). Build-time only. |

No runtime surface: the worker reads the two bound secrets straight off `env` by the configured
binding names.
