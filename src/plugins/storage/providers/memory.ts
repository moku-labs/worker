/**
 * @file storage plugin — in-memory Map-backed test double provider skeleton.
 */
import type { StorageProvider } from "./types";

/**
 * Build an in-memory StorageProvider (a Map-backed test double) used in tests
 * and as a missing-binding fallback in non-production stages.
 *
 * @example
 * ```ts
 * const provider = createMemoryProvider();
 * ```
 */
export function createMemoryProvider(): StorageProvider {
  throw new Error("not implemented");
}
