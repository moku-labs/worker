/**
 * @file server plugin — state factory skeleton. Owns the compiled endpoint table
 * and its specificity-sorted match(method, path) matcher (literal beats param,
 * method-specific beats ALL).
 */
import type { Endpoint, ServerState } from "./types";

/**
 * Creates the initial server state by copying config.endpoints into a fresh
 * uncompiled matcher table. The returned table object exposes match(method, path),
 * which resolves a request method + pathname to its endpoint + params (or null).
 *
 * @param _endpoints - The frozen declarative endpoint table from config.
 * @example
 * ```ts
 * const state = createServerState(config.endpoints);
 * const hit = state.match("GET", "/api/data");
 * ```
 */
export function createServerState(_endpoints: Endpoint[]): ServerState {
  throw new Error("not implemented");
}
