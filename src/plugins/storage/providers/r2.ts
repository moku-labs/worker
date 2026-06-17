/**
 * @file storage plugin — real R2Bucket-backed provider skeleton.
 */
import type { StorageProvider } from "./types";

/** Minimal bindings-resolver shape this provider needs (avoids a cross-plugin type import). */
type BindingsResolver = {
  /** Resolve a binding off the request env, narrowed to T. */
  require<T>(env: Record<string, unknown>, name: string): T;
};

/**
 * Build a StorageProvider backed by the real R2Bucket resolved off the request env.
 *
 * @param _bindings - The bindings plugin api (resolves the bucket binding).
 * @param _env - The per-request Cloudflare bindings object.
 * @param _bucket - The R2 bucket binding name.
 * @example
 * ```ts
 * const provider = resolveR2Provider(ctx.require(bindingsPlugin), env, ctx.config.bucket);
 * ```
 */
export function resolveR2Provider(
  _bindings: BindingsResolver,
  _env: Record<string, unknown>,
  _bucket: string
): StorageProvider {
  throw new Error("not implemented");
}
