/**
 * Unit tests for the dev watch/recompile orchestrator (injected deps; no real processes).
 */
import { describe, expect, it, type Mock, vi } from "vitest";

import { type DevDeps, runDev } from "../../../dev/runner";
import type { Ctx } from "../../../types";

/** Build a mock deploy ctx with the config + has/require surface runDev uses. */
const makeCtx = (overrides?: { hasD1?: boolean; migrateLocal?: boolean }): Ctx =>
  ({
    emit: vi.fn(),
    config: {
      configFile: "wrangler.jsonc",
      ci: false,
      watch: ["src/**/*"],
      buildCommand: "",
      migrateLocal: overrides?.migrateLocal ?? true,
      debounceMs: 120
    },
    has: (name: string) => name === "d1" && (overrides?.hasD1 ?? false),
    require: () => ({ deployManifest: () => ({ kind: "d1", binding: "DB" }) })
  }) as unknown as Ctx;

type Captured = {
  onChange?: (changedPath: string) => unknown;
  close: Mock<() => void>;
  kill: Mock<() => void>;
};

/** Build injected dev deps plus a `captured` handle exposing the watch callback + teardown spies. */
const makeDeps = (overrides?: Partial<DevDeps>): { deps: DevDeps; captured: Captured } => {
  const captured: Captured = { close: vi.fn<() => void>(), kill: vi.fn<() => void>() };
  const deps: DevDeps = {
    build: vi.fn().mockResolvedValue({ files: 3 }),
    runWrangler: vi.fn().mockResolvedValue(""),
    spawnDev: vi.fn(() => ({ kill: captured.kill })),
    watch: vi.fn((_globs, _ms, onChange) => {
      captured.onChange = onChange;
      return { close: captured.close };
    }),
    untilSignal: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 0),
    ...overrides
  };
  return { deps, captured };
};

describe("runDev", () => {
  it("cold-builds, spawns wrangler dev --live-reload, and tears down on signal", async () => {
    const { deps, captured } = makeDeps();
    const ctx = makeCtx();

    await runDev(ctx, { port: 8787 }, deps);

    expect(deps.build).toHaveBeenCalledTimes(1);
    expect(deps.spawnDev).toHaveBeenCalledWith(
      expect.arrayContaining([
        "dev",
        "--port",
        "8787",
        "--config",
        "wrangler.jsonc",
        "--live-reload"
      ])
    );
    expect(captured.close).toHaveBeenCalled();
    expect(captured.kill).toHaveBeenCalled();
  });

  it("applies local d1 migrations when a d1 plugin is present and migrateLocal is on", async () => {
    const { deps } = makeDeps();

    await runDev(makeCtx({ hasD1: true }), {}, deps);

    expect(deps.runWrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--local"]);
  });

  it("skips local migrations when no d1 plugin is present", async () => {
    const { deps } = makeDeps();

    await runDev(makeCtx({ hasD1: false }), {}, deps);

    expect(deps.runWrangler).not.toHaveBeenCalled();
  });

  it("rebuilds the site on a file change and emits dev:rebuilt", async () => {
    let resolveSignal: (() => void) | undefined;
    const { deps, captured } = makeDeps({
      untilSignal: () =>
        new Promise<void>(resolve => {
          resolveSignal = resolve;
        })
    });
    const ctx = makeCtx();

    const promise = runDev(ctx, {}, deps);
    await vi.waitFor(() => expect(captured.onChange).toBeDefined());
    await captured.onChange?.("src/app.tsx");
    resolveSignal?.();
    await promise;

    expect(deps.build).toHaveBeenCalledTimes(2); // cold + rebuild
    expect(ctx.emit).toHaveBeenCalledWith("dev:rebuilt", expect.objectContaining({ files: 3 }));
  });

  it("emits dev:error and keeps serving when a rebuild fails (no wrangler restart)", async () => {
    let resolveSignal: (() => void) | undefined;
    const build = vi
      .fn()
      .mockResolvedValueOnce({ files: 1 })
      .mockRejectedValueOnce(new Error("boom"));
    const { deps, captured } = makeDeps({
      build,
      untilSignal: () =>
        new Promise<void>(resolve => {
          resolveSignal = resolve;
        })
    });
    const ctx = makeCtx();

    const promise = runDev(ctx, {}, deps);
    await vi.waitFor(() => expect(captured.onChange).toBeDefined());
    await captured.onChange?.("src/app.tsx");
    resolveSignal?.();
    await promise;

    expect(ctx.emit).toHaveBeenCalledWith(
      "dev:error",
      expect.objectContaining({ message: "boom" })
    );
    expect(deps.spawnDev).toHaveBeenCalledTimes(1); // wrangler never restarted
  });
});
