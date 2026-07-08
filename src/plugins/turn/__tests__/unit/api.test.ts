/**
 * Unit tests for createTurnApi — keyed-map config → deploy manifest (binding defaults resolved).
 */
import { describe, expect, it, vi } from "vitest";
import { type Context, createTurnApi } from "../../api";

/** Build a turn plugin context over the given keyed-map config. */
const makeCtx = (config: Context["config"]): Context =>
  ({ config, state: {}, emit: vi.fn() }) as unknown as Context;

describe("createTurnApi", () => {
  it("returns one turn descriptor per configured instance with binding defaults resolved", () => {
    const api = createTurnApi(makeCtx({ relay: { name: "myapp-turn" } }));

    expect(api.deployManifest()).toEqual([
      {
        kind: "turn",
        name: "myapp-turn",
        keyIdBinding: "TURN_KEY_ID",
        apiTokenBinding: "TURN_KEY_API_TOKEN",
        verifyPath: "/api/ice" // the room-hub default
      }
    ]);
  });

  it("honors explicit binding overrides", () => {
    const api = createTurnApi(
      makeCtx({
        relay: { name: "myapp-turn", keyIdBinding: "MY_KEY", apiTokenBinding: "MY_TOKEN" }
      })
    );

    expect(api.deployManifest()).toEqual([
      {
        kind: "turn",
        name: "myapp-turn",
        keyIdBinding: "MY_KEY",
        apiTokenBinding: "MY_TOKEN",
        verifyPath: "/api/ice"
      }
    ]);
  });

  it("an empty keyed map (the default) declares nothing", () => {
    expect(createTurnApi(makeCtx({})).deployManifest()).toEqual([]);
  });
});
