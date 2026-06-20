/**
 * Unit tests for dev site-rebuild resolution (child_process + fs stubbed).
 */
import { describe, expect, it, vi } from "vitest";

import { buildSite } from "../../../dev/build";
import type { Ctx } from "../../../types";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(() => false) }));

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** A child stub that immediately reports a 0 exit when its "close" listener is registered. */
const okChild = () => {
  const child = {
    on: vi.fn((event: string, cb: (code?: number) => void) => {
      if (event === "close") cb(0);
      return child;
    })
  };
  return child as unknown as ReturnType<typeof spawn>;
};

const makeCtx = (config: Partial<Ctx["config"]>): Ctx =>
  ({
    emit: vi.fn(),
    config: {
      configFile: "wrangler.jsonc",
      ci: false,
      watch: [],
      buildCommand: "",
      migrateLocal: true,
      debounceMs: 120,
      ...config
    }
  }) as unknown as Ctx;

describe("buildSite", () => {
  it("calls the config webBuild hook when configured", async () => {
    const hook = vi.fn().mockResolvedValue({ files: 7 });

    const result = await buildSite(makeCtx({ webBuild: hook }));

    expect(hook).toHaveBeenCalled();
    expect(result).toEqual({ files: 7 });
  });

  it("prefers the call-time webBuild param over the config webBuild", async () => {
    const configHook = vi.fn().mockResolvedValue({ files: 1 });
    const paramHook = vi.fn().mockResolvedValue({ files: 9 });

    const result = await buildSite(makeCtx({ webBuild: configHook }), paramHook);

    expect(paramHook).toHaveBeenCalled();
    expect(configHook).not.toHaveBeenCalled();
    expect(result).toEqual({ files: 9 });
  });

  it("normalizes a countless (void) hook result to files: 0", async () => {
    const hook = vi.fn().mockResolvedValue(undefined);

    const result = await buildSite(makeCtx({}), hook);

    expect(hook).toHaveBeenCalled();
    expect(result).toEqual({ files: 0 });
  });

  it("emits dev:error and no-ops when nothing is configured", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const ctx = makeCtx({ buildCommand: "" });

    const result = await buildSite(ctx);

    expect(ctx.emit).toHaveBeenCalledWith(
      "dev:error",
      expect.objectContaining({ message: expect.stringContaining("No site build") })
    );
    expect(result).toEqual({ files: 0 });
  });

  it("spawns the configured buildCommand", async () => {
    vi.mocked(spawn).mockReturnValue(okChild());

    await buildSite(makeCtx({ buildCommand: "bun run build" }));

    expect(spawn).toHaveBeenCalledWith("bun run build", expect.objectContaining({ shell: true }));
  });

  it("auto-detects scripts/build.ts when present and no command is set", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(okChild());

    await buildSite(makeCtx({ buildCommand: "" }));

    expect(spawn).toHaveBeenCalledWith(
      "bun run scripts/build.ts",
      expect.objectContaining({ shell: true })
    );
  });
});
