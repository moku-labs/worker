/**
 * @file Shared helpers for keyed-map resource configs (kv / d1 / storage / queues / durableObjects).
 *
 * Every resource plugin configures its instances as a `Record<key, instance>` where one instance is
 * the default (the sole entry, or the one flagged `default: true`). These helpers resolve the default
 * key and look an instance up by key — with branded errors — so the implicit default and the explicit
 * `app.<kind>.use("key")` selector behave identically across plugins. Pure; safe in any runtime.
 */

/** The minimal shape every keyed resource instance shares: an optional default flag. */
export type ResourceInstance = {
  /** Marks this instance as the default when a kind declares more than one. */
  default?: boolean;
};

/**
 * Resolve the default instance key from a keyed-map config: the sole entry, or the one flagged
 * `default: true`. Throws a branded error when there are no instances, or several without (or with
 * more than one) `default: true`.
 *
 * @param instances - The keyed-map config (`Record<key, instance>`).
 * @param kind - The resource kind, for the error message (e.g. "kv", "d1").
 * @returns The default instance's key.
 * @throws {Error} With a `[moku-worker]` prefix when no single default can be resolved.
 * @example
 * ```ts
 * defaultInstanceKey({ main: { name: "db", binding: "DB" } }, "d1"); // "main"
 * ```
 */
export const defaultInstanceKey = <T extends ResourceInstance>(
  instances: Record<string, T>,
  kind: string
): string => {
  const keys = Object.keys(instances);
  if (keys.length === 0) {
    throw new Error(`[moku-worker] No ${kind} instance is configured.`);
  }
  if (keys.length === 1) {
    return keys[0] as string;
  }

  const flagged = keys.filter(key => instances[key]?.default === true);
  if (flagged.length === 1) {
    return flagged[0] as string;
  }
  throw new Error(
    `[moku-worker] ${kind} has ${String(keys.length)} instances — mark exactly one with \`default: true\`.`
  );
};

/**
 * Look up a resource instance by key, with a branded error listing the configured keys when absent.
 *
 * @param instances - The keyed-map config (`Record<key, instance>`).
 * @param key - The instance key to resolve (the `use(key)` selector).
 * @param kind - The resource kind, for the error message.
 * @returns The instance at `key`.
 * @throws {Error} With a `[moku-worker]` prefix when `key` is not configured.
 * @example
 * ```ts
 * pickInstance(cfg, "analytics", "d1");
 * ```
 */
export const pickInstance = <T>(instances: Record<string, T>, key: string, kind: string): T => {
  const instance = instances[key];
  if (instance === undefined) {
    const configured = Object.keys(instances).join(", ") || "(none)";
    throw new Error(`[moku-worker] No ${kind} instance "${key}". Configured: ${configured}.`);
  }
  return instance;
};
