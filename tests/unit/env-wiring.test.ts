/**
 * Unit tests for the framework's env wiring: `config.ts` seeds the workerd-safe
 * `process.env` provider (now `workerSafeProcessEnv` from `@moku-labs/common`) as
 * the `env` core-plugin default, so `app.env` resolves `process.env` out of the box.
 * The provider itself is unit-tested in `@moku-labs/common`.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/index";

describe("createApp env wiring", () => {
  it("resolves a process.env var via app.env (the default provider is wired)", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tok-wired";
    try {
      const app = createApp();
      expect(app.env.get("CLOUDFLARE_API_TOKEN")).toBe("tok-wired");
    } finally {
      delete process.env.CLOUDFLARE_API_TOKEN;
    }
  });

  it("a consumer-supplied env provider array is respected over the default", () => {
    const app = createApp({
      pluginConfigs: {
        // The `env` core-plugin key is sealed from the public `pluginConfigs` type (spec/05 §1b),
        // but the kernel honors a level-4 override at runtime over the config.ts default. The cast
        // reaches that sealed channel to prove a consumer-supplied provider array wins.
        env: { providers: [{ name: "fixed", load: () => ({ FIXED_ONLY: "yes" }) }] }
      }
    } as Parameters<typeof createApp>[0]);

    expect(app.env.get("FIXED_ONLY")).toBe("yes");
  });
});
