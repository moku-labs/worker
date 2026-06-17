/**
 * @file storage plugin — in-memory Map-backed test double provider.
 *
 * R2Object, R2ObjectBody, R2Objects, R2ListOptions, R2Checksums are ambient
 * globals from \@cloudflare/workers-types (tsconfig "types") — used
 * unqualified, never imported.
 *
 * This is a TEST DOUBLE. R2Object, R2ObjectBody, R2Objects, and R2Checksums are
 * `declare abstract class` in \@cloudflare/workers-types and cannot be satisfied
 * by plain object literals. Each helper builds the minimal required fields and
 * casts via `as unknown as R2Xxx`. The casts are intentional and localised to
 * this provider — they do not violate R6 (which applies to createState/config).
 */
import type { StorageProvider } from "./types";

/** Stored entry shape — value kept as the raw input for later introspection. */
type MemEntry = {
  key: string;
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null;
};

/** Empty checksum JSON shape (all optional fields absent). */
type EmptyChecksumJson = Record<string, never>;

// ---------------------------------------------------------------------------
// Minimal R2 shape helpers (return-type annotated — no inline `as` needed)
// ---------------------------------------------------------------------------

/**
 * No-op write-http-metadata stub satisfying the R2Object/R2ObjectBody interface.
 *
 * @returns {void} Nothing.
 * @example
 * ```typescript
 * noopWriteHttpMetadata();
 * ```
 */
const noopWriteHttpMetadata = (): void => {
  // test double — metadata not tracked in the in-memory store
};

/**
 * Stub toJSON that returns an empty object, satisfying R2Checksums.toJSON.
 *
 * @returns {EmptyChecksumJson} An empty JSON-serialisable object.
 * @example
 * ```typescript
 * const json = emptyChecksumToJson();
 * ```
 */
const emptyChecksumToJson = (): EmptyChecksumJson => {
  const result: EmptyChecksumJson = Object.create(null) as EmptyChecksumJson;
  return result;
};

/**
 * Produce the smallest R2Checksums that satisfies the ambient type.
 * exactOptionalPropertyTypes forbids `md5: undefined` — omit all digest
 * fields and cast; R2Checksums is an abstract class.
 *
 * @returns {R2Checksums} An R2Checksums-compatible test double.
 * @example
 * ```typescript
 * const checksums = makeChecksums();
 * ```
 */
const makeChecksums = (): R2Checksums =>
  // test double: R2Checksums is an abstract class — minimal cast
  ({ toJSON: emptyChecksumToJson }) as unknown as R2Checksums;

/**
 * Produce a minimal R2Object-shaped value for a stored key.
 * R2Object is a declare abstract class — cast required for test doubles.
 *
 * @param key - The object key.
 * @returns {R2Object} An R2Object-compatible test double.
 * @example
 * ```typescript
 * const obj = makeR2Object("my-key");
 * ```
 */
const makeR2Object = (key: string): R2Object =>
  // test double: R2Object is an abstract class — minimal cast
  ({
    key,
    version: "mem-v1",
    size: 0,
    etag: "mem-etag",
    httpEtag: '"mem-etag"',
    storageClass: "Standard",
    checksums: makeChecksums(),
    uploaded: new Date(0),
    httpMetadata: {},
    customMetadata: {},
    writeHttpMetadata: noopWriteHttpMetadata
  }) as unknown as R2Object;

/**
 * Stub arrayBuffer decode for an R2ObjectBody test double.
 *
 * @returns {Promise<ArrayBuffer>} An empty ArrayBuffer.
 * @example
 * ```typescript
 * const buf = await stubArrayBuffer();
 * ```
 */
const stubArrayBuffer = async (): Promise<ArrayBuffer> => new ArrayBuffer(0);

/**
 * Stub blob decode for an R2ObjectBody test double.
 *
 * @returns {Promise<Blob>} An empty Blob.
 * @example
 * ```typescript
 * const blob = await stubBlob();
 * ```
 */
const stubBlob = async (): Promise<Blob> => new Blob();

/**
 * Stub JSON decode that resolves undefined (test double — data not decoded).
 * The generic T is required by R2ObjectBody.json<T>() — resolved as unknown.
 *
 * @returns {Promise<T>} Resolves to undefined cast through unknown to T.
 * @example
 * ```typescript
 * const val = await stubJson<string>();
 * ```
 */
const stubJson = async <T = unknown>(): Promise<T> => undefined as unknown as T;

/**
 * Produce a minimal R2ObjectBody-shaped value for a stored entry.
 * R2ObjectBody is a declare abstract class — cast required for test doubles.
 *
 * @param entry - The stored entry to wrap.
 * @returns {R2ObjectBody} An R2ObjectBody-compatible test double.
 * @example
 * ```typescript
 * const body = makeR2ObjectBody({ key: "k", value: "v" });
 * ```
 */
const makeR2ObjectBody = (entry: MemEntry): R2ObjectBody =>
  // test double: R2ObjectBody is an abstract class — minimal cast
  ({
    key: entry.key,
    version: "mem-v1",
    size: 0,
    etag: "mem-etag",
    httpEtag: '"mem-etag"',
    storageClass: "Standard",
    checksums: makeChecksums(),
    uploaded: new Date(0),
    httpMetadata: {},
    customMetadata: {},
    body: new ReadableStream(),
    bodyUsed: false,
    bytes: stubArrayBuffer,
    writeHttpMetadata: noopWriteHttpMetadata,
    arrayBuffer: stubArrayBuffer,
    blob: stubBlob,
    json: stubJson,
    /**
     * Return the stored value as a string (test double — no stream decoding).
     *
     * @returns {Promise<string>} The stored value coerced to a string.
     * @example
     * ```typescript
     * const text = await body.text();
     * ```
     */
    text: async () => String(entry.value ?? "")
  }) as unknown as R2ObjectBody;

/**
 * Produce a minimal R2Objects result from an array of stored entries.
 * R2Objects is a union type; `truncated: false` must not carry a `cursor`
 * field. exactOptionalPropertyTypes forbids `cursor: undefined` — omit it
 * and cast the whole result.
 *
 * @param entries - The filtered and sliced entries to include.
 * @param truncated - Whether the result was limited by a `limit` option.
 * @returns {R2Objects} An R2Objects-compatible test double.
 * @example
 * ```typescript
 * const result = makeR2Objects([entry], false);
 * ```
 */
const makeR2Objects = (entries: MemEntry[], truncated: boolean): R2Objects =>
  // test double: R2Objects is an abstract class — minimal cast; omit cursor (exactOptionalPropertyTypes)
  ({
    objects: entries.map(entry => makeR2Object(entry.key)),
    truncated,
    delimitedPrefixes: []
  }) as unknown as R2Objects;

/**
 * Build an in-memory StorageProvider (a Map-backed test double). Used in tests
 * and as a missing-binding fallback in non-production stages.
 *
 * Each call to `createMemoryProvider()` produces an independent store. Methods
 * satisfy the `StorageProvider` interface using helper functions with explicit
 * return-type annotations that satisfy the ambient Cloudflare types.
 *
 * @returns {StorageProvider} An in-memory provider backed by a Map.
 * @example
 * ```typescript
 * const provider = createMemoryProvider();
 * await provider.put("k", "v");
 * const body = await provider.get("k"); // R2ObjectBody | null
 * ```
 */
export const createMemoryProvider = (): StorageProvider => {
  const store = new Map<string, MemEntry>();

  return {
    /**
     * Read an object; returns null when the key is absent.
     *
     * @param key - The object key to retrieve.
     * @returns {Promise<R2ObjectBody | null>} An R2ObjectBody-shaped value, or null.
     * @example
     * ```typescript
     * const body = await provider.get("my-key");
     * ```
     */
    async get(key: string): Promise<R2ObjectBody | null> {
      const entry = store.get(key);
      // eslint-disable-next-line unicorn/no-null
      if (entry === undefined) return null;
      return makeR2ObjectBody(entry);
    },

    /**
     * Write an object to the store.
     *
     * @param key - The object key.
     * @param value - The object contents (any R2-accepted type).
     * @returns {Promise<R2Object>} An R2Object-shaped record for the written object.
     * @example
     * ```typescript
     * const obj = await provider.put("my-key", "content");
     * ```
     */
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null
    ): Promise<R2Object> {
      store.set(key, { key, value });
      return makeR2Object(key);
    },

    /**
     * Remove one or more objects. No-op when a key is absent.
     *
     * @param key - A single key or array of keys to remove.
     * @returns {Promise<void>} Resolves when deletion is complete.
     * @example
     * ```typescript
     * await provider.delete("my-key");
     * await provider.delete(["key-a", "key-b"]);
     * ```
     */
    async delete(key: string | string[]): Promise<void> {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) {
        store.delete(k);
      }
    },

    /**
     * List objects, optionally filtered by prefix, with limit support.
     *
     * @param opts - Optional R2ListOptions (`prefix`, `limit`, `cursor`).
     * @returns {Promise<R2Objects>} An R2Objects-shaped result.
     * @example
     * ```typescript
     * const result = await provider.list({ prefix: "images/" });
     * ```
     */
    async list(opts?: R2ListOptions): Promise<R2Objects> {
      let entries = [...store.values()];

      if (opts?.prefix !== undefined) {
        const prefix = opts.prefix;
        entries = entries.filter(entry => entry.key.startsWith(prefix));
      }

      const limit = opts?.limit;
      const sliced = limit === undefined ? entries : entries.slice(0, limit);
      const truncated = limit !== undefined && entries.length > limit;

      return makeR2Objects(sliced, truncated);
    }
  };
};
