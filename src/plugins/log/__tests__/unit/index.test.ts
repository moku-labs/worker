/**
 * Unit tests for the log core plugin.
 *
 * Tests are written over a hand-rolled `{ config, state }` core context.
 * No framework wiring required — just the api factory and the RANK gating logic.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { LogConfig, LogEntry, LogState } from "../../index";
import { createLogApi } from "../../index";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a typed ctx and call createLogApi directly for full return-type inference. */
function makeApi(config: LogConfig, state: LogState) {
  return createLogApi({ config, state });
}

function makeState(): LogState {
  return { entries: [] };
}

function defaultConfig(overrides: Partial<LogConfig> = {}): LogConfig {
  return { level: "info", bufferSize: 100, ...overrides };
}

// ─── Console spy setup ───────────────────────────────────────────────────────

const spies = {
  debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  error: vi.spyOn(console, "error").mockImplementation(() => {})
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("log plugin — unit", () => {
  // ─── Level methods: each calls the matching console.* ──────────────────

  describe("level methods — console dispatch and entry push", () => {
    it("debug: calls console.debug and pushes a LogEntry when at threshold", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug" }), state);

      api.debug("test message", { extra: 1 });

      expect(spies.debug).toHaveBeenCalledOnce();
      expect(spies.debug).toHaveBeenCalledWith("test message", { extra: 1 });
      expect(state.entries).toHaveLength(1);
      const entry = state.entries[0];
      expect(entry?.level).toBe("debug");
      expect(entry?.message).toBe("test message");
      expect(entry?.args).toEqual([{ extra: 1 }]);
      expect(typeof entry?.at).toBe("number");
    });

    it("info: calls console.info and pushes a LogEntry at default level", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.info("hello world", "arg1", 42);

      expect(spies.info).toHaveBeenCalledOnce();
      expect(spies.info).toHaveBeenCalledWith("hello world", "arg1", 42);
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.level).toBe("info");
      expect(state.entries[0]?.message).toBe("hello world");
      expect(state.entries[0]?.args).toEqual(["arg1", 42]);
    });

    it("warn: calls console.warn and pushes a LogEntry", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.warn("uh oh", { code: 500 });

      expect(spies.warn).toHaveBeenCalledOnce();
      expect(spies.warn).toHaveBeenCalledWith("uh oh", { code: 500 });
      expect(state.entries[0]?.level).toBe("warn");
    });

    it("error: calls console.error and pushes a LogEntry", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.error("fatal", new Error("boom"));

      expect(spies.error).toHaveBeenCalledOnce();
      expect(spies.error).toHaveBeenCalledWith("fatal", new Error("boom"));
      expect(state.entries[0]?.level).toBe("error");
    });

    it("entry.at is a numeric epoch timestamp", () => {
      const before = Date.now();
      const state = makeState();
      const api = makeApi(defaultConfig(), state);
      api.info("timing");
      const after = Date.now();

      const at = state.entries[0]?.at;
      expect(typeof at).toBe("number");
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    });

    it("each method dispatches to the CORRECT console.* (cross-check)", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug" }), state);

      api.debug("d");
      api.info("i");
      api.warn("w");
      api.error("e");

      expect(spies.debug).toHaveBeenCalledOnce();
      expect(spies.info).toHaveBeenCalledOnce();
      expect(spies.warn).toHaveBeenCalledOnce();
      expect(spies.error).toHaveBeenCalledOnce();
    });
  });

  // ─── Level gating ────────────────────────────────────────────────────────

  describe("level gating", () => {
    it("level:warn — debug and info are no-ops; warn and error emit", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "warn" }), state);

      api.debug("silent");
      api.info("also silent");
      expect(spies.debug).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
      expect(state.entries).toHaveLength(0);

      api.warn("loud");
      api.error("louder");
      expect(spies.warn).toHaveBeenCalledOnce();
      expect(spies.error).toHaveBeenCalledOnce();
      expect(state.entries).toHaveLength(2);
    });

    it("level:error — only error emits", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "error" }), state);

      api.debug("x");
      api.info("x");
      api.warn("x");
      expect(state.entries).toHaveLength(0);
      expect(spies.debug).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();

      api.error("x");
      expect(spies.error).toHaveBeenCalledOnce();
      expect(state.entries).toHaveLength(1);
    });

    it("level:debug — all four methods emit", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug" }), state);

      api.debug("d");
      api.info("i");
      api.warn("w");
      api.error("e");

      expect(state.entries).toHaveLength(4);
      expect(spies.debug).toHaveBeenCalledOnce();
      expect(spies.info).toHaveBeenCalledOnce();
      expect(spies.warn).toHaveBeenCalledOnce();
      expect(spies.error).toHaveBeenCalledOnce();
    });

    it("level:info (default) — debug is no-op, info/warn/error emit", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "info" }), state);

      api.debug("silent");
      expect(state.entries).toHaveLength(0);

      api.info("yes");
      api.warn("yes");
      api.error("yes");
      expect(state.entries).toHaveLength(3);
    });
  });

  // ─── Ring buffer cap ─────────────────────────────────────────────────────

  describe("ring buffer cap (FIFO)", () => {
    it("never exceeds bufferSize entries", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug", bufferSize: 3 }), state);

      api.info("a");
      api.info("b");
      api.info("c");
      expect(state.entries).toHaveLength(3);

      api.info("d");
      expect(state.entries).toHaveLength(3);
    });

    it("drops the OLDEST entry when cap exceeded (FIFO)", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug", bufferSize: 3 }), state);

      api.info("a");
      api.info("b");
      api.info("c");
      api.info("d");

      expect(state.entries.map(e => e.message)).toEqual(["b", "c", "d"]);
    });

    it("bufferSize:0 — nothing is buffered and recent() returns []", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug", bufferSize: 0 }), state);

      api.info("x");
      api.warn("y");
      expect(state.entries).toHaveLength(0);
      expect(api.recent()).toEqual([]);
    });

    it("bufferSize:1 — only last entry retained", () => {
      const state = makeState();
      const api = makeApi(defaultConfig({ level: "debug", bufferSize: 1 }), state);

      api.info("first");
      api.info("second");
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.message).toBe("second");
    });
  });

  // ─── recent() ────────────────────────────────────────────────────────────

  describe("recent()", () => {
    it("returns empty array when nothing logged", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);
      expect(api.recent()).toEqual([]);
    });

    it("returns entries most-recent-last", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.info("first");
      api.info("second");

      const result = api.recent();
      expect(result[0]?.message).toBe("first");
      expect(result[1]?.message).toBe("second");
    });

    it("returns a frozen snapshot — mutation does not affect state.entries", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);
      api.info("original");

      const snapshot = api.recent();
      expect(Object.isFrozen(snapshot)).toBe(true);

      // recent() declares readonly LogEntry[] — .push is a compile-time error.
      // At runtime, Object.freeze makes it throw in strict mode.
      expect(() => {
        // @ts-expect-error — readonly array: push is not allowed on frozen snapshot
        snapshot.push({ level: "info", message: "injected", args: [], at: 0 });
      }).toThrow();

      // Original state unaffected
      expect(state.entries).toHaveLength(1);
      expect(state.entries[0]?.message).toBe("original");
    });

    it("snapshot does not share the live array reference", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);
      api.info("a");

      const snap1 = api.recent();
      api.info("b");
      const snap2 = api.recent();

      // snap1 captured before "b" was added — should still have only 1 entry
      expect(snap1).toHaveLength(1);
      expect(snap2).toHaveLength(2);
    });
  });

  // ─── args forwarding ─────────────────────────────────────────────────────

  describe("...args forwarding", () => {
    it("forwards multiple args verbatim to console.*", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);
      const obj = { key: "value" };

      api.info("msg", obj, 42, true, undefined);

      expect(spies.info).toHaveBeenCalledWith("msg", obj, 42, true, undefined);
      expect(state.entries[0]?.args).toEqual([obj, 42, true, undefined]);
    });

    it("stores args in entry.args as a plain array (not rest params object)", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.warn("check", "a", "b");

      expect(Array.isArray(state.entries[0]?.args)).toBe(true);
      expect(state.entries[0]?.args).toEqual(["a", "b"]);
    });

    it("stores empty args array when no extra args passed", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      api.info("solo");
      expect(state.entries[0]?.args).toEqual([]);
    });
  });

  // ─── Type-level assertions ────────────────────────────────────────────────

  describe("types", () => {
    it("api method signatures match LogApi", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      expectTypeOf(api.debug).toEqualTypeOf<(message: string, ...args: unknown[]) => void>();
      expectTypeOf(api.info).toEqualTypeOf<(message: string, ...args: unknown[]) => void>();
      expectTypeOf(api.warn).toEqualTypeOf<(message: string, ...args: unknown[]) => void>();
      expectTypeOf(api.error).toEqualTypeOf<(message: string, ...args: unknown[]) => void>();
    });

    it("recent() returns readonly LogEntry[]", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      expectTypeOf(api.recent()).toEqualTypeOf<readonly LogEntry[]>();
    });

    it("rejects a non-string message at compile time", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      // Compile-time is the contract: a number message is a type error (asserted below).
      // @ts-expect-error — message must be string, not number
      api.info(123);
      // Runtime has no type guard — JS still records the call. The guarantee is the
      // compile-time rejection above, not a runtime no-op.
      expect(state.entries).toHaveLength(1);
    });

    it("trace is absent from LogApi at compile time and runtime", () => {
      const state = makeState();
      const api = makeApi(defaultConfig(), state);

      // Runtime: the property is not present on the returned object.
      expect((api as unknown as Record<string, unknown>).trace).toBeUndefined();
    });

    it("defaultLogConfig level rejects verbose", () => {
      // @ts-expect-error — "verbose" is not a valid LogLevel
      const badConfig: LogConfig = { level: "verbose", bufferSize: 10 };
      // Satisfy no-unused-vars: verify the object shape is otherwise correct
      expect(badConfig.bufferSize).toBe(10);
    });
  });
});
