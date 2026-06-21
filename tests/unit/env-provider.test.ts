/**
 * Unit tests for the default workerd-safe env provider + its createApp wiring.
 */
import { describe, expect, it } from "vitest";
import { workerSafeProcessEnv } from "../../src/env-provider";
import { createApp } from "../../src/index";

describe("workerSafeProcessEnv", () => {
  it("is named worker-process-env", () => {
    expect(workerSafeProcessEnv().name).toBe("worker-process-env");
  });

  it("reads the current process.env", () => {
    process.env.MOKU_PROVIDER_TEST = "abc123";
    try {
      expect(workerSafeProcessEnv().load().MOKU_PROVIDER_TEST).toBe("abc123");
    } finally {
      delete process.env.MOKU_PROVIDER_TEST;
    }
  });

  it("snapshots fresh on each load (not a live reference)", () => {
    const provider = workerSafeProcessEnv();
    const before = provider.load();
    process.env.MOKU_PROVIDER_FRESH = "x";
    try {
      expect(before.MOKU_PROVIDER_FRESH).toBeUndefined(); // captured before the set
      expect(provider.load().MOKU_PROVIDER_FRESH).toBe("x"); // re-read picks it up
    } finally {
      delete process.env.MOKU_PROVIDER_FRESH;
    }
  });
});

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
