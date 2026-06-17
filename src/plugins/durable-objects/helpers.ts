/**
 * @file durableObjects plugin — defineDurableObject base-class factory skeleton (pure, no ctx).
 */
import type { WorkerEnv as WorkerEnvironment } from "../../config";

/** Constructor contract of the base class returned by defineDurableObject. */
export type DurableObjectBase = {
  /** Cloudflare per-object storage/alarm context. */
  readonly ctx: DurableObjectState;
  /** Per-object Cloudflare bindings. */
  readonly env: WorkerEnvironment;
};

/** Constructor type produced by defineDurableObject (consumer extends it). */
export type DurableObjectBaseConstructor = new (
  ctx: DurableObjectState,
  env: WorkerEnvironment
) => DurableObjectBase;

/**
 * Returns a base class the consumer extends & exports from worker.ts. PURE: no ctx,
 * no lifecycle, no side effects; runs before createApp. The plugin never generates
 * the class — the consumer owns the exported class.
 *
 * @param _name - Captured for diagnostics / binding correlation.
 * @example
 * ```ts
 * export class Counter extends defineDurableObject("Counter") {}
 * ```
 */
export function defineDurableObject(_name: string): DurableObjectBaseConstructor {
  throw new Error("not implemented");
}
