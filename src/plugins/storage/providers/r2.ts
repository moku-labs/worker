/**
 * @file storage plugin — real R2Bucket-backed provider.
 *
 * R2Bucket, R2Object, R2ObjectBody, R2Objects, R2ListOptions are ambient
 * globals from cloudflare/workers-types (tsconfig "types") — used
 * unqualified, never imported.
 */
import type { StorageProvider } from "./types";

/**
 * Minimal bindings-resolver shape needed by this provider. Structural (not a
 * cross-plugin type import) so this file has no compile-time dependency on the
 * bindings plugin's internal types. WorkerEnv = Record<string, unknown>
 * (framework-level alias from config.ts) — we inline the structural equivalent
 * to avoid importing across plugin dirs.
 */
type BindingsResolver = {
  /**
   * Resolve a named binding off the request env, narrowed to T. Throws a
   * `[worker]`-prefixed error when the binding is nullish.
   *
   * @param env - The per-request Cloudflare bindings object.
   * @param name - The binding name to resolve.
   * @returns {T} The binding value narrowed to T.
   */
  require<T>(env: Record<string, unknown>, name: string): T;
};

/**
 * Build a StorageProvider backed by the real R2Bucket resolved off the
 * per-request env via the bindings plugin. The bucket is resolved fresh on
 * EVERY method call — never cached, so concurrent requests stay isolated
 * (worker-api-design SB4; spec/08 §6).
 *
 * Each method is `async` so that synchronous throws from `bindings.require`
 * (e.g. missing binding) are automatically wrapped in rejected Promises —
 * callers can always use `await` / `.catch` instead of `try/catch`.
 *
 * @param bindings - The bindings plugin API (provides `require<T>`).
 * @param env - The per-request Cloudflare bindings object.
 * @param bucket - The R2 bucket binding name (e.g. "ASSETS").
 * @returns {StorageProvider} A provider that delegates to the resolved R2Bucket.
 * @example
 * ```typescript
 * const provider = resolveR2Provider(ctx.require(bindingsPlugin), env, ctx.config.bucket);
 * const body = await provider.get("my-object");
 * ```
 */
export const resolveR2Provider = (
  bindings: BindingsResolver,
  env: Record<string, unknown>,
  bucket: string
): StorageProvider => {
  /**
   * Resolve the R2Bucket for this request's env. Throws on missing binding.
   *
   * @returns {R2Bucket} The resolved R2Bucket binding.
   * @example
   * ```typescript
   * const bucket = b();
   * ```
   */
  const b = (): R2Bucket => bindings.require<R2Bucket>(env, bucket);

  return {
    /**
     * Read an object from the bucket.
     *
     * @param key - The object key.
     * @returns {Promise<R2ObjectBody | null>} The R2ObjectBody, or null if the key is absent.
     * @example
     * ```typescript
     * const body = await provider.get("assets/logo.png");
     * ```
     */
    async get(key: string): Promise<R2ObjectBody | null> {
      return b().get(key);
    },

    /**
     * Write an object to the bucket.
     *
     * @param key - The object key.
     * @param value - The object contents (any R2-accepted type).
     * @returns {Promise<R2Object>} The R2Object metadata for the written object.
     * @example
     * ```typescript
     * const obj = await provider.put("assets/logo.png", buffer);
     * ```
     */
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
    ): Promise<R2Object> {
      // R2Bucket.put() can return null in @cloudflare/workers-types when the
      // upload is rejected; in practice a successful put always yields R2Object.
      // The non-null assertion keeps StorageProvider's public `Promise<R2Object>`
      // contract without widening the API to callers.
      return b().put(key, value) as Promise<R2Object>;
    },

    /**
     * Remove one or more objects from the bucket. No-op when a key is absent.
     *
     * @param key - A single key or array of keys to remove.
     * @returns {Promise<void>} Resolves once removed.
     * @example
     * ```typescript
     * await provider.delete("assets/old.png");
     * ```
     */
    async delete(key: string | string[]): Promise<void> {
      return b().delete(key);
    },

    /**
     * List objects, optionally filtered by R2ListOptions.
     *
     * @param opts - Optional list options (prefix, limit, cursor, delimiter).
     * @returns {Promise<R2Objects>} The R2Objects list result.
     * @example
     * ```typescript
     * const { objects } = await provider.list({ prefix: "images/" });
     * ```
     */
    async list(opts?: R2ListOptions): Promise<R2Objects> {
      return b().list(opts);
    }
  };
};
