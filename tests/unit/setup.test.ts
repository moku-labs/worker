import { describe, expect, it } from "vitest";

import { createPlugin } from "../../src/index";

describe("setup", () => {
  it("exposes createPlugin as the consumer plugin factory", () => {
    expect(createPlugin).toBeTypeOf("function");
  });
});
