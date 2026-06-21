/**
 * @file Default workerd-safe env provider for the worker framework.
 *
 * The framework seeds this as the `env` core plugin's default provider in `config.ts`
 * (`createCoreConfig` `pluginConfigs.env.providers`) so deploy/auth can read CLOUDFLARE_API_TOKEN
 * and friends through `ctx.env`. It reads `process.env`
 * — present under Bun/Node (where the deploy scripts run) and under workerd with `nodejs_compat` —
 * and degrades to an empty map when there is no `process` global (a Worker without nodejs_compat), so
 * baking it into every runtime app can never crash a bundle at cold start. `dotenv()` is intentionally
 * NOT the default: it needs `node:fs`, which is unavailable in workerd.
 */
import type { EnvProvider } from "@moku-labs/common";

/**
 * Build the default env provider: a shallow copy of `process.env` when a `process` global exists,
 * else an empty record. Safe to evaluate at Worker cold start — it never throws on a missing
 * `process` (typeof of an undeclared identifier is the string "undefined", not a ReferenceError).
 *
 * @returns An {@link EnvProvider} named `worker-process-env`.
 * @example
 * ```ts
 * // seeded as the env plugin's default so `ctx.env.get("CLOUDFLARE_API_TOKEN")` resolves under Bun/Node
 * const provider = workerSafeProcessEnv();
 * provider.load().CLOUDFLARE_API_TOKEN;
 * ```
 */
export const workerSafeProcessEnv = (): EnvProvider => ({
  name: "worker-process-env",
  /**
   * Read a shallow copy of `process.env`, or `{}` when there is no `process` global (workerd
   * without nodejs_compat). Never throws at cold start.
   *
   * @returns The current environment as a flat record (empty when `process` is absent).
   * @example
   * ```ts
   * workerSafeProcessEnv().load();
   * ```
   */
  load() {
    return typeof process === "undefined" ? {} : { ...process.env };
  }
});
