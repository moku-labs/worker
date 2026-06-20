/**
 * @file server plugin — state factory.
 *
 * Owns the compiled endpoint table and the `match(method, path)` function
 * that resolves each incoming request to its best-matching endpoint.
 *
 * Matching rules (highest priority first):
 *   1. More literal segments beat fewer (specificity score).
 *   2. Method-specific endpoint beats an `ALL` endpoint on the same path.
 *   3. Required `{id}` beats optional `{id:?}` (score difference).
 *   4. Optional `{id:?}` allows the segment to be absent.
 */
import type { CompiledEndpoint, Endpoint, MatchResult, PathSegment, ServerState } from "./types";

/** Specificity weight for a literal path segment. */
const LITERAL_WEIGHT = 2;
/** Specificity weight for a required param segment `{name}`. */
const REQUIRED_PARAM_WEIGHT = 1;
/** Specificity weight for an optional param segment `{name:?}`. */
const OPTIONAL_PARAM_WEIGHT = 0;

/**
 * Parse one path segment string into a typed `PathSegment`.
 *
 * `{name}` → required param; `{name:?}` → optional param; anything else → literal.
 * The `:?` optional suffix matches the `@moku-labs/web` router pattern.
 *
 * @param raw - A single path segment token (no leading slash).
 * @returns The parsed `PathSegment`.
 * @example
 * ```typescript
 * parseSegment("{id}")   // → { value: "id", param: true, optional: false }
 * parseSegment("{id:?}") // → { value: "id", param: true, optional: true }
 * parseSegment("api")    // → { value: "api", param: false, optional: false }
 * ```
 */
const parseSegment = (raw: string): PathSegment => {
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1);
    if (inner.endsWith(":?")) {
      return { value: inner.slice(0, -2), param: true, optional: true };
    }
    return { value: inner, param: true, optional: false };
  }
  return { value: raw, param: false, optional: false };
};

/**
 * Compute the specificity weight for a single `PathSegment`.
 *
 * @param segment - The parsed segment to score.
 * @returns `2` for literal, `1` for required param, `0` for optional param.
 * @example
 * ```typescript
 * segmentWeight({ value: "api", param: false, optional: false }) // 2
 * segmentWeight({ value: "id",  param: true,  optional: false }) // 1
 * segmentWeight({ value: "q",   param: true,  optional: true  }) // 0
 * ```
 */
const segmentWeight = (segment: PathSegment): number => {
  if (!segment.param) return LITERAL_WEIGHT;
  if (!segment.optional) return REQUIRED_PARAM_WEIGHT;
  return OPTIONAL_PARAM_WEIGHT;
};

/**
 * Convert an `Endpoint` to its compiled form (parsed segments + specificity score).
 *
 * @param endpoint - The declarative endpoint value from config.
 * @returns A `CompiledEndpoint` ready for the matcher table.
 * @example
 * ```typescript
 * const compiled = compileEndpoint(endpoint("/api/{id}").get(handler));
 * // compiled.specificity === 3 (literal "api" = 2, required "{id}" = 1)
 * ```
 */
const compileEndpoint = (endpoint: Endpoint): CompiledEndpoint => {
  const parts = endpoint.path.split("/").filter(Boolean);
  const segments = parts.map(part => parseSegment(part));
  const specificity = segments.reduce((total, segment) => total + segmentWeight(segment), 0);
  return { endpoint, segments, specificity };
};

/**
 * Try to match one compiled endpoint against a request method and split path tokens.
 *
 * Returns the extracted params map on success, or `undefined` if the endpoint
 * does not match. Uses `undefined` (not `null`) per the unicorn/no-null rule.
 *
 * @param compiled - A single compiled endpoint.
 * @param method - The request method string (e.g. `"GET"`).
 * @param tokens - The request path split into non-empty segments.
 * @returns Extracted params record on match, or `undefined` for no match.
 * @example
 * ```typescript
 * const compiled = compileEndpoint(endpoint("/users/{id}").get(handler));
 * tryMatchEndpoint(compiled, "GET", ["users", "42"]) // → { id: "42" }
 * tryMatchEndpoint(compiled, "POST", ["users"])      // → undefined
 * ```
 */
const tryMatchEndpoint = (
  compiled: CompiledEndpoint,
  method: string,
  tokens: string[]
): Record<string, string | undefined> | undefined => {
  // Method guard: an `ALL` endpoint matches any verb; otherwise the verb must match exactly.
  if (compiled.endpoint.method !== "ALL" && compiled.endpoint.method !== method) {
    return undefined;
  }

  // Arity guard: reject token counts below the mandatory segments or above the total.
  const { segments } = compiled;
  const mandatoryCount = segments.filter(segment => !segment.optional).length;
  if (tokens.length < mandatoryCount || tokens.length > segments.length) {
    return undefined;
  }

  // Named-param extraction: walk segments and tokens in lockstep, bailing on any literal mismatch.
  const params: Record<string, string | undefined> = {};
  for (const [index, segment] of segments.entries()) {
    const token = tokens[index];

    if (segment.param) {
      if (token === undefined) {
        if (!segment.optional) return undefined;
        params[segment.value] = undefined;
      } else {
        params[segment.value] = token;
      }
    } else if (token !== segment.value) {
      return undefined;
    }
  }

  return params;
};

/**
 * Sort comparator placing higher-specificity endpoints first.
 * Tie-break: method-specific endpoints before `ALL` so explicit methods win.
 *
 * @param a - First compiled endpoint.
 * @param b - Second compiled endpoint.
 * @returns Negative, zero, or positive sort key.
 * @example
 * ```typescript
 * const a = compileEndpoint(endpoint("/api/{id}").get(handler));   // specificity 3
 * const b = compileEndpoint(endpoint("/api/{id:?}").get(handler));  // specificity 2
 * [b, a].sort(bySpecificityDesc); // → [a, b] — higher specificity first
 * ```
 */
const bySpecificityDesc = (a: CompiledEndpoint, b: CompiledEndpoint): number => {
  const delta = b.specificity - a.specificity;
  if (delta !== 0) return delta;
  if (a.endpoint.method !== "ALL" && b.endpoint.method === "ALL") return -1;
  if (a.endpoint.method === "ALL" && b.endpoint.method !== "ALL") return 1;
  return 0;
};

/**
 * Find the best-matching compiled endpoint in the table for the given method + path.
 *
 * Iterates the table (assumed sorted high-to-low specificity) and returns the
 * first match. Internally re-sorts on every call so it is safe to call before
 * `onInit` compiles the table.
 *
 * @param table - The compiled endpoint table.
 * @param method - Request method string (e.g. `"GET"`, `"ALL"`).
 * @param tokens - Path split into non-empty string tokens.
 * @returns The match result, or `null` when no endpoint matches.
 * @example
 * ```typescript
 * const result = findBestMatch(state.table, "GET", ["api", "users"]);
 * ```
 */
const findBestMatch = (
  table: CompiledEndpoint[],
  method: string,
  tokens: string[]
): MatchResult | null => {
  // Create a sorted copy so this works even before onInit compilation.
  const sorted = table.toSorted(bySpecificityDesc);

  for (const compiled of sorted) {
    const params = tryMatchEndpoint(compiled, method, tokens);
    if (params !== undefined) {
      return { endpoint: compiled.endpoint, params };
    }
  }
  // eslint-disable-next-line unicorn/no-null -- MatchResult | null is the public contract for "no match"
  return null;
};

/**
 * Compile and sort the endpoint table in-place.
 *
 * Called by `onInit` — the one-time per-isolate setup. Sorts `state.table` by
 * specificity (descending), validates that no endpoint path contains duplicate
 * `{param}` names or the retired `{name?}` optional syntax, and sets
 * `state.compiled = true` to guard re-entry.
 *
 * @param state - The mutable server state whose `table` should be compiled.
 * @throws {Error} With `[moku-worker]` prefix when a path has duplicate param
 *   names, or uses the old `{name?}` optional syntax (now `{name:?}`).
 * @example
 * ```typescript
 * // Called inside serverPlugin.onInit:
 * compileServerState(ctx.state);
 * ```
 */
export const compileServerState = (state: ServerState): void => {
  // Idempotence guard: onInit runs once per isolate — never compile the table twice.
  if (state.compiled) return;

  // Sort by specificity so the matcher returns the first hit (literal beats param, method beats ALL).
  state.table.sort(bySpecificityDesc);

  // Validate each endpoint path: reject the retired `{name?}` syntax and duplicate param names.
  for (const compiled of state.table) {
    const seen = new Set<string>();
    for (const segment of compiled.segments) {
      if (!segment.param) continue;
      // The new parser strips only `:?`; a trailing `?` means the old `{name?}`
      // optional syntax leaked through — flag it loudly instead of registering a
      // param literally named "name?".
      if (segment.value.endsWith("?")) {
        const name = segment.value.slice(0, -1);
        throw new Error(
          `[moku-worker] endpoint path "${compiled.endpoint.path}" uses the old optional-param syntax "{${segment.value}}".\n` +
            `  Optional params now use the colon form (matching @moku-labs/web): write "{${name}:?}" instead of "{${name}?}".`
        );
      }
      if (seen.has(segment.value)) {
        throw new Error(
          `[moku-worker] endpoint path "${compiled.endpoint.path}" has duplicate param "{${segment.value}}".\n` +
            `  Each {param} name in a path must be unique.`
        );
      }
      seen.add(segment.value);
    }
  }

  // Mark compiled so a repeat onInit (or a pre-init match() re-sort) is a no-op.
  state.compiled = true;
};

/**
 * Creates the initial (uncompiled) server state from a declarative endpoint list.
 *
 * Copies `endpoints` into a fresh mutable `CompiledEndpoint[]` — does NOT mutate
 * the frozen config array. Sets `compiled = false`; `onInit` calls
 * `compileServerState` to sort/validate and set `compiled = true`.
 *
 * The `match(method, path)` method is safe to call before `onInit` because
 * `findBestMatch` re-sorts on every invocation.
 *
 * @param endpoints - The frozen declarative endpoint table from `config.endpoints`.
 * @returns A fresh `ServerState` with `compiled = false`.
 * @example
 * ```typescript
 * const state = createServerState(config.endpoints);
 * const hit = state.match("GET", "/api/users");
 * ```
 */
export const createServerState = (endpoints: Endpoint[]): ServerState => {
  const table: CompiledEndpoint[] = endpoints.map(ep => compileEndpoint(ep));

  /**
   * Match a method + pathname against the compiled table.
   *
   * @param method - Request method (or `"ALL"` for cron dispatch).
   * @param path - Request URL pathname (or cron expression string).
   * @returns Matched endpoint + extracted params, or `null` for no match.
   * @example
   * ```typescript
   * state.match("GET", "/api/users");
   * ```
   */
  const match = (method: string, path: string): MatchResult | null => {
    const tokens = path.split("/").filter(Boolean);
    return findBestMatch(table, method, tokens);
  };

  return { table, compiled: false, match };
};
