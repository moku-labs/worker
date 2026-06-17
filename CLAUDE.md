# @moku-labs/worker

Cloudflare Worker framework for Moku — Durable Objects, Queues, R2, D1, and KV plugins that compose with Moku Web — built on @moku-labs/core.

## Package Manager

Use `bun` exclusively — never npm, yarn, or pnpm.

## Scripts

- `bun run build` — Build with tsdown
- `bun run lint` — Biome check + ESLint
- `bun run lint:fix` — Auto-fix lint issues
- `bun run format` — Format with Biome
- `bun run test` — Run all tests (vitest)
- `bun run test:unit` — Unit tests only
- `bun run test:integration` — Integration tests only
- `bun run test:coverage` — Tests with coverage

## Code Style

- **Formatter:** Biome (2-space indent, double quotes, semicolons, no trailing commas)
- **Linter:** ESLint 9 flat config + Biome (biome-config-biome must be LAST)
- **TypeScript:** Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Imports:** Use `import type` enforced via `@typescript-eslint/consistent-type-imports`
- **JSDoc:** Required on all source exports with descriptions, params, returns, and examples

## Architecture

Three-layer Moku model:
1. `src/config.ts` — `createCoreConfig` (Layer 1: config + events)
2. `src/index.ts` — `createCore` (Layer 2: framework + plugins)
3. Consumer apps use `createApp` (Layer 3)

Plugins go in `src/plugins/`. This framework targets the Cloudflare Workers runtime and is designed to
compose alongside Moku Web (`@moku-labs/web`): Moku Web supplies the request/island layer, while this
framework supplies the server-side Cloudflare primitives — Durable Objects, Queues, R2, D1, and KV —
each as its own plugin.

## Testing

- Vitest with unit + integration projects
- Framework-level tests: `tests/unit/` and `tests/integration/` (cross-plugin scenarios, createApp validation)
- Plugin-specific tests: `src/plugins/[name]/__tests__/unit/` and `__tests__/integration/` (colocated inside each plugin)
- 90% coverage threshold
- Never put plugin-specific tests in root `tests/` — root tests are for framework-level integration only

## Moku Development Toolkit

This project uses the **moku** Claude Code plugin for development workflows. Below are the available commands, skills, and agents.

### Commands (slash commands)

**Planning:**
- `/moku:plan [create|update|add|migrate|resume] [type] [args]` — 3-stage gated workflow to plan a framework, consumer app, or plugin. Supports: `create` (new project), `update` (modify existing), `add plugin` (quick single-pass), `migrate` (from existing code). Type synonyms: tool/engine/library → framework, application/service/server/game → app. Output goes to `.planning/specs/` (framework/plugin) or `.planning/app-spec.md` (app).

**Building:**
- `/moku:build [framework|app|plugin] [spec-or-name]` — Build from specifications. Auto-detects what to build based on existing spec files. Resumes if partially built. Supports `/moku:build plugin #3` for individual plugins.

**Setup:**
- `/moku:init` — Initialize a new Moku project with full tooling (used to create this project).

### Skills (automatic context)

Skills are loaded automatically when relevant topics come up. You can also reference them explicitly:

- **moku-core** — Architecture rules, factory chain, lifecycle, event system, context tiers. Use when working with `createCoreConfig`, `createCore`, `createApp`, or discussing the three-layer model.
- **moku-plugin** — Plugin structure specification, complexity tiers (Nano → VeryComplex), file organization, wiring harness pattern. Use when creating or reviewing plugin code.
- **moku-web** — Web patterns: Preact components, CSS architecture (@scope, @layer, tokens), island pattern. Use when building web-facing UI that composes with this framework.

### Agents (validation)

Agents run autonomously to validate code. They are called automatically by build commands, but can also be triggered manually:

- **moku-spec-validator** — Validates Moku Core specification compliance: three-layer separation, factory chain, config system, lifecycle, events, error formats.
- **moku-plugin-spec-validator** — Validates plugin structure: correct tier, file organization, JSDoc coverage, test existence, no anti-patterns (no explicit generics on `createPlugin`, no unnecessary `onStart`/`onStop`).
- **moku-jsdoc-validator** — Validates JSDoc completeness: all exports have descriptions, `@param`, `@returns`, and `@example` tags.

### Typical Workflows

**New framework from scratch:**
1. `/moku:plan create framework "A Cloudflare Worker framework"` — design plugins and structure (3 approval gates)
2. `/moku:build framework` — implement everything from specs
3. Validators run automatically after each plugin

**Add a single plugin:**
1. `/moku:plan add plugin kv "Cloudflare KV namespace binding"` — create plugin spec
2. `/moku:build add kv` — build, wire, and verify the planned plugin

**Update an existing plugin:**
1. `/moku:plan update plugin r2 "add multipart upload support"` — produces updated spec
2. `/moku:build plugin r2` — implement changes from updated spec

**Migrate existing code:**
1. `/moku:plan migrate framework ~/Projects/legacy-worker` — analyze and map to Moku
2. `/moku:build framework` — implement the migration

**Manual validation:**
- Ask Claude to "run the spec validator" or "validate JSDoc" on specific files
- Run `/moku-verify` to fan out the full validation pipeline in parallel

## Specification

For questions about how things should be implemented, refer to the [Moku Core specification](https://github.com/moku-labs/core/tree/main/specification).
