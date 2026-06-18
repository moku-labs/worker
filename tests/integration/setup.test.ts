import { describe, expect, it } from "vitest";

import { createApp } from "../../src/index";

describe("setup", () => {
  it("exposes createApp as the Layer-3 entry factory", () => {
    expect(createApp).toBeTypeOf("function");
  });
});
