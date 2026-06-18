/**
 * @file storage plugin — provider adapter seam (the StorageProvider interface).
 *
 * R2ListOptions / R2Object / R2ObjectBody / R2Objects are ambient globals from
 * `@cloudflare/workers-types` (tsconfig "types") — used unqualified, never imported.
 */

/**
 * The adapter seam. Both the real R2 provider and the in-memory test double
 * implement this so api.ts is provider-agnostic.
 *
 * @example
 * ```ts
 * // every StorageProvider (the real R2 adapter or an in-memory test double) exposes:
 * await provider.put("k", "v");
 * const obj = await provider.get("k");
 * ```
 */
export type StorageProvider = {
  /** Read an object; null when absent. */
  get(key: string): Promise<R2ObjectBody | null>;
  /** Write an object. */
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
  ): Promise<R2Object>;
  /** Remove an object (or keys). */
  delete(key: string | string[]): Promise<void>;
  /** List objects. */
  list(opts?: R2ListOptions): Promise<R2Objects>;
};
