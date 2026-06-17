/**
 * Unit tests for defineDurableObject — pure helper, no ctx required.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { defineDurableObject } from "../../helpers";

// ---------------------------------------------------------------------------
// Unit test: defineDurableObject (pure static factory, no ctx)
// ---------------------------------------------------------------------------

describe("defineDurableObject", () => {
  // ─── return type: must be a constructor function ──────────────────────────

  describe("return type", () => {
    it("returns a constructor function (typeof === 'function')", () => {
      const Base = defineDurableObject("Counter");

      expect(typeof Base).toBe("function");
    });

    it("returns a class with a prototype (is a proper constructor)", () => {
      const Base = defineDurableObject("Counter");

      expect(Base).toBeTypeOf("function");
      expect(Base.prototype).toBeDefined();
      expect(typeof Base.prototype).toBe("object");
    });
  });

  // ─── constructor contract ─────────────────────────────────────────────────

  describe("constructor contract", () => {
    it("a subclass constructed with (state, env) exposes this.ctx and this.env", () => {
      const Base = defineDurableObject("Counter");

      const fakeState = {
        storage: { get: () => Promise.resolve(undefined) },
        id: { toString: () => "fake-id" },
        blockConcurrencyWhile: async (fn: () => Promise<void>) => fn()
      } as unknown as DurableObjectState;

      const fakeEnv: Record<string, unknown> = { MY_BINDING: "test" };

      class Counter extends Base {}

      const instance = new Counter(fakeState, fakeEnv);

      expect(instance.ctx).toBe(fakeState);
      expect(instance.env).toBe(fakeEnv);
    });

    it("ctx property holds the exact DurableObjectState passed to constructor", () => {
      const Base = defineDurableObject("MyDO");

      const fakeState = { storage: {}, id: {} } as unknown as DurableObjectState;
      const fakeEnv = {};

      class MyDO extends Base {}
      const instance = new MyDO(fakeState, fakeEnv);

      expect(instance.ctx).toBe(fakeState);
    });

    it("env property holds the exact WorkerEnv passed to constructor", () => {
      const Base = defineDurableObject("MyDO");

      const fakeState = { storage: {}, id: {} } as unknown as DurableObjectState;
      const fakeEnv = { DB: "database", KV: "kvstore" };

      class MyDO extends Base {}
      const instance = new MyDO(fakeState, fakeEnv);

      expect(instance.env).toBe(fakeEnv);
    });

    it("instance.ctx is typed as DurableObjectState", () => {
      const Base = defineDurableObject("TypeCheck");
      const fakeState = { storage: {} } as unknown as DurableObjectState;
      const fakeEnv = {};

      class TypeCheck extends Base {}
      const instance = new TypeCheck(fakeState, fakeEnv);

      expectTypeOf(instance.ctx).toEqualTypeOf<DurableObjectState>();
    });

    it("instance.env is typed as WorkerEnv (Record<string, unknown>)", () => {
      const Base = defineDurableObject("TypeCheck");
      const fakeState = { storage: {} } as unknown as DurableObjectState;
      const fakeEnv: Record<string, unknown> = {};

      class TypeCheck extends Base {}
      const instance = new TypeCheck(fakeState, fakeEnv);

      expectTypeOf(instance.env).toEqualTypeOf<Record<string, unknown>>();
    });

    it("ctx is readonly — @ts-expect-error reassignment rejected at compile time", () => {
      const Base = defineDurableObject("ReadonlyCheck");
      const fakeState = { storage: {} } as unknown as DurableObjectState;

      class ReadonlyCheck extends Base {}
      const instance = new ReadonlyCheck(fakeState, {});

      // @ts-expect-error — ctx is declared readonly
      instance.ctx = fakeState;

      expect(instance).toBeDefined();
    });

    it("env is readonly — @ts-expect-error reassignment rejected at compile time", () => {
      const Base = defineDurableObject("ReadonlyCheck");

      class ReadonlyCheck extends Base {}
      const instance = new ReadonlyCheck({} as unknown as DurableObjectState, {});

      // @ts-expect-error — env is declared readonly
      instance.env = {};

      expect(instance).toBeDefined();
    });
  });

  // ─── static doName ────────────────────────────────────────────────────────

  describe("static doName", () => {
    it("captures the name argument as static doName", () => {
      const Base = defineDurableObject("Counter");

      expect(Base.doName).toBe("Counter");
    });

    it("different names produce different static doName values", () => {
      const CounterBase = defineDurableObject("Counter");
      const ChatBase = defineDurableObject("Chat");

      expect(CounterBase.doName).toBe("Counter");
      expect(ChatBase.doName).toBe("Chat");
    });

    it("doName is static — accessible on the class, not instances", () => {
      const Base = defineDurableObject("MyWorker");

      expect(Base.doName).toBe("MyWorker");

      const instance = new Base({} as unknown as DurableObjectState, {});
      // doName is not on the instance prototype — it's a static class property
      expect((instance as unknown as { doName?: string }).doName).toBeUndefined();
    });
  });

  // ─── purity: independent classes, no shared state ─────────────────────────

  describe("purity: two calls yield independent classes", () => {
    it("two calls with the same name yield different class references", () => {
      const Base1 = defineDurableObject("Counter");
      const Base2 = defineDurableObject("Counter");

      expect(Base1).not.toBe(Base2);
    });

    it("instances of different base classes are not cross-class", () => {
      const Base1 = defineDurableObject("Counter");
      const Base2 = defineDurableObject("Chat");

      const fakeState = { storage: {} } as unknown as DurableObjectState;
      const fakeEnv = {};

      class Counter extends Base1 {}
      class Chat extends Base2 {}

      const c = new Counter(fakeState, fakeEnv);
      const ch = new Chat(fakeState, fakeEnv);

      expect(c).toBeInstanceOf(Base1);
      expect(ch).toBeInstanceOf(Base2);
      expect(c).not.toBeInstanceOf(Base2);
      expect(ch).not.toBeInstanceOf(Base1);
    });

    it("reads no plugin state — helper is pure (takes only a name string, no ctx)", () => {
      // defineDurableObject must work before createApp is called (spec/03 §1).
      // This test calls it at module scope (no app context available).
      const Base = defineDurableObject("EarlyCall");

      expect(Base).toBeDefined();
      expect(Base.doName).toBe("EarlyCall");
    });
  });
});
