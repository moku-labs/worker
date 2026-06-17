/**
 * @file durableObjects plugin — defineDurableObject base-class factory (pure, no ctx).
 *
 * SPEC BOUNDARY #1 (design §9): a Moku plugin produces values/APIs, never a top-level
 * exported class. This helper returns a BASE CLASS the consumer extends and exports
 * from worker.ts. Pure (spec/03 §1): no ctx, no lifecycle, no side effects, runs before createApp.
 */
import type { WorkerEnv } from "../../config";

/**
 * Constructor contract of the base class returned by `defineDurableObject`.
 *
 * @example
 * ```typescript
 * class Counter extends defineDurableObject("Counter") implements DurableObjectBase {
 *   async fetch(): Promise<Response> { return new Response("ok"); }
 * }
 * ```
 */
export interface DurableObjectBase {
  /** Cloudflare per-object storage/alarm context. */
  readonly ctx: DurableObjectState;
  /** Per-object Cloudflare bindings (per-request env). */
  readonly env: WorkerEnv;
}

/**
 * Constructor type produced by `defineDurableObject`. The consumer `extends` this
 * and exports the resulting class from `worker.ts`.
 *
 * @example
 * ```typescript
 * const Base: DurableObjectBaseConstructor = defineDurableObject("Counter");
 * class Counter extends Base {}
 * ```
 */
export type DurableObjectBaseConstructor = new (
  ctx: DurableObjectState,
  env: WorkerEnv
) => DurableObjectBase;

/**
 * Returns a base class the consumer extends and exports from `worker.ts`.
 *
 * PURE (spec/03 §1): takes no `ctx`, has no side effects, and may be called before
 * `createApp`. The static `doName` property captures `name` for diagnostics and
 * binding correlation. The constructor stores `(state, env)` as `this.ctx` / `this.env`,
 * satisfying the Cloudflare Durable Object constructor contract. The plugin NEVER
 * generates the final exported class — the consumer owns that class.
 *
 * @param name - Logical DO name; captured as `static doName` for diagnostics.
 * @returns A base class (constructor) the consumer extends.
 * @example
 * ```typescript
 * // src/counter.ts
 * import { defineDurableObject } from "@moku-labs/worker";
 *
 * export class Counter extends defineDurableObject("Counter") {
 *   async fetch(): Promise<Response> {
 *     const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
 *     await this.ctx.storage.put("n", n);
 *     return Response.json({ n });
 *   }
 * }
 * ```
 */
export const defineDurableObject = (
  name: string
): DurableObjectBaseConstructor & {
  readonly doName: string;
} => {
  /**
   * Base implementation of the Cloudflare Durable Object constructor contract.
   * Stores `(ctx, env)` as readonly properties for consumer subclasses to use.
   */
  class DurableObjectBaseImpl implements DurableObjectBase {
    /**
     * Cloudflare per-object storage/alarm context (DurableObjectState).
     * Use `this.ctx.storage` to read/write durable storage and `this.ctx.id` to inspect the DO id.
     */
    readonly ctx: DurableObjectState;

    /**
     * Per-object Cloudflare bindings (per-request WorkerEnv).
     * Mirrors the env passed at construction time; never cached across requests.
     */
    readonly env: WorkerEnv;

    /**
     * Logical DO name captured from `defineDurableObject(name)`.
     * Used for diagnostics and binding correlation.
     */
    static readonly doName: string = name;

    /**
     * Constructs the base Durable Object with Cloudflare's required signature.
     *
     * @param ctx - Cloudflare DurableObjectState (storage, id, blockConcurrencyWhile, …).
     * @param env - Per-request Cloudflare bindings object (WorkerEnv).
     * @example
     * ```typescript
     * class Counter extends Base {
     *   constructor(ctx: DurableObjectState, env: WorkerEnv) { super(ctx, env); }
     * }
     * ```
     */
    constructor(ctx: DurableObjectState, env: WorkerEnv) {
      this.ctx = ctx;
      this.env = env;
    }
  }

  return DurableObjectBaseImpl;
};
