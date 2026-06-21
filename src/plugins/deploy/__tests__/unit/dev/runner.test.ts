/**
 * Unit tests for the dev watch/recompile orchestrator (injected deps; no real processes).
 */
import { describe, expect, it, type Mock, vi } from "vitest";

import { type DevDeps, runDev } from "../../../dev/runner";
import type { Ctx, SeedConfig } from "../../../types";

/** Build a mock deploy ctx with the config + has/require surface runDev uses. */
const makeCtx = (overrides?: { hasD1?: boolean; migrateLocal?: boolean; seed?: SeedConfig }): Ctx =>
  ({
    emit: vi.fn(),
    config: {
      configFile: "wrangler.jsonc",
      ci: false,
      watch: ["src/**/*"],
      buildCommand: "",
      migrateLocal: overrides?.migrateLocal ?? true,
      debounceMs: 120,
      ...(overrides?.seed === undefined ? {} : { seed: overrides.seed })
    },
    has: (name: string) => name === "d1" && (overrides?.hasD1 ?? false),
    require: () => ({
      deployManifest: () => [
        { kind: "d1", name: "tracker-db", binding: "DB", migrations: "db/migrations" }
      ]
    })
  }) as unknown as Ctx;

type Captured = {
  onChange?: (changedPaths: string[]) => unknown;
  close: Mock<() => void>;
  stop: Mock<() => Promise<void>>;
};

/** Build injected dev deps plus a `captured` handle exposing the watch callback + teardown spies. */
const makeDeps = (overrides?: Partial<DevDeps>): { deps: DevDeps; captured: Captured } => {
  const captured: Captured = {
    close: vi.fn<() => void>(),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  };
  const deps: DevDeps = {
    build: vi.fn().mockResolvedValue({ files: 3 }),
    runWrangler: vi.fn().mockResolvedValue(""),
    // whenExited never resolves by default, so teardown is driven by untilSignal (the SIGINT path).
    spawnDev: vi.fn(() => ({
      stop: captured.stop,
      whenExited: new Promise<void>(() => undefined)
    })),
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
    expect(captured.stop).toHaveBeenCalled();
  });

  it("ends the session when wrangler exits on its own (whenExited wins the race, no SIGINT)", async () => {
    const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const close = vi.fn<() => void>();
    const deps: DevDeps = {
      build: vi.fn().mockResolvedValue({ files: 1 }),
      runWrangler: vi.fn().mockResolvedValue(""),
      // wrangler exits immediately on its own; untilSignal never fires (no Ctrl+C).
      spawnDev: vi.fn(() => ({ stop, whenExited: Promise.resolve() })),
      watch: vi.fn(() => ({ close })),
      untilSignal: () => new Promise<void>(() => undefined),
      now: vi.fn(() => 0)
    };

    // Would hang forever without the untilSignal-vs-whenExited race in runDev.
    await runDev(makeCtx(), {}, deps);

    expect(stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
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

  it("loads the configured LOCAL seed (execute + KV reset) before serving when seed is set", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({
      hasD1: true,
      seed: { file: "db/seed.sql", resetKv: [{ binding: "BOARDS_KV", key: "boards:index" }] }
    });

    await runDev(ctx, { seed: true }, deps);

    // migrate (schema) → execute (seed) → kv reset, all local.
    expect(deps.runWrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--local"]);
    expect(deps.runWrangler).toHaveBeenCalledWith([
      "d1",
      "execute",
      "DB",
      "--local",
      "--file",
      "db/seed.sql"
    ]);
    expect(deps.runWrangler).toHaveBeenCalledWith([
      "kv",
      "key",
      "delete",
      "boards:index",
      "--binding",
      "BOARDS_KV",
      "--local"
    ]);
    expect(ctx.emit).toHaveBeenCalledWith("dev:phase", { phase: "seed", detail: "db/seed.sql" });
  });

  it("forces local migrations when seed is set even if migrateLocal is off", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({ hasD1: true, migrateLocal: false, seed: { file: "db/seed.sql" } });

    await runDev(ctx, { seed: true }, deps);

    expect(deps.runWrangler).toHaveBeenCalledWith(["d1", "migrations", "apply", "DB", "--local"]);
  });

  it("does NOT seed when the seed flag is absent", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({ hasD1: true, seed: { file: "db/seed.sql" } });

    await runDev(ctx, {}, deps);

    expect(deps.runWrangler).not.toHaveBeenCalledWith(
      expect.arrayContaining(["execute", "--file", "db/seed.sql"])
    );
  });

  it("throws when seed is set but no seed is configured", async () => {
    const { deps } = makeDeps();

    await expect(runDev(makeCtx({ hasD1: true }), { seed: true }, deps)).rejects.toThrow(
      "no seed is configured"
    );
  });

  it("throws when seed is set but no d1 database is configured", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx({ hasD1: false, seed: { file: "db/seed.sql" } });

    await expect(runDev(ctx, { seed: true }, deps)).rejects.toThrow("no d1 database is configured");
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
    await captured.onChange?.(["src/app.tsx"]);
    resolveSignal?.();
    await promise;

    expect(deps.build).toHaveBeenCalledTimes(2); // cold + rebuild
    expect(ctx.emit).toHaveBeenCalledWith("dev:rebuilt", expect.objectContaining({ files: 3 }));
  });

  it("threads the opts.webBuild hook into both the cold build and each rebuild", async () => {
    let resolveSignal: (() => void) | undefined;
    const { deps, captured } = makeDeps({
      untilSignal: () =>
        new Promise<void>(resolve => {
          resolveSignal = resolve;
        })
    });
    const ctx = makeCtx();
    const webBuild = vi.fn().mockResolvedValue({ files: 5 });

    const promise = runDev(ctx, { webBuild }, deps);
    await vi.waitFor(() => expect(captured.onChange).toBeDefined());
    await captured.onChange?.(["src/app.tsx"]);
    resolveSignal?.();
    await promise;

    expect(deps.build).toHaveBeenNthCalledWith(1, ctx, webBuild); // cold build
    expect(deps.build).toHaveBeenNthCalledWith(2, ctx, webBuild); // rebuild
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
    await captured.onChange?.(["src/app.tsx"]);
    resolveSignal?.();
    await promise;

    expect(ctx.emit).toHaveBeenCalledWith(
      "dev:error",
      expect.objectContaining({ message: "boom" })
    );
    expect(deps.spawnDev).toHaveBeenCalledTimes(1); // wrangler never restarted
  });

  it("calls opts.onChange with the changed set on a change — NOT a full webBuild rebuild", async () => {
    let resolveSignal: (() => void) | undefined;
    const { deps, captured } = makeDeps({
      untilSignal: () =>
        new Promise<void>(resolve => {
          resolveSignal = resolve;
        })
    });
    const ctx = makeCtx();
    const webBuild = vi.fn().mockResolvedValue({ files: 5 });
    const onChange = vi.fn().mockResolvedValue({ files: 7 });

    const promise = runDev(ctx, { webBuild, onChange }, deps);
    await vi.waitFor(() => expect(captured.onChange).toBeDefined());
    await captured.onChange?.(["src/islands/board.ts", "src/app.css"]);
    resolveSignal?.();
    await promise;

    // The incremental hook handles the rebuild with the full changed set …
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["src/islands/board.ts", "src/app.css"]);
    // … so deps.build runs ONLY for the cold build (no full webBuild rebuild), and the
    // dev:rebuilt count is read from the onChange result.
    expect(deps.build).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith("dev:rebuilt", expect.objectContaining({ files: 7 }));
  });

  it("still cold-builds via webBuild even when onChange is wired", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    const webBuild = vi.fn().mockResolvedValue({ files: 5 });
    const onChange = vi.fn().mockResolvedValue({ files: 7 });

    await runDev(ctx, { webBuild, onChange }, deps);

    // The cold build always uses webBuild; onChange is never called without a change.
    expect(deps.build).toHaveBeenNthCalledWith(1, ctx, webBuild);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits dev:error and keeps serving when an onChange rebuild fails", async () => {
    let resolveSignal: (() => void) | undefined;
    const { deps, captured } = makeDeps({
      untilSignal: () =>
        new Promise<void>(resolve => {
          resolveSignal = resolve;
        })
    });
    const ctx = makeCtx();
    const onChange = vi.fn().mockRejectedValue(new Error("update boom"));

    const promise = runDev(ctx, { onChange }, deps);
    await vi.waitFor(() => expect(captured.onChange).toBeDefined());
    await captured.onChange?.(["src/app.tsx"]);
    resolveSignal?.();
    await promise;

    expect(ctx.emit).toHaveBeenCalledWith(
      "dev:error",
      expect.objectContaining({ message: "update boom" })
    );
    expect(deps.spawnDev).toHaveBeenCalledTimes(1); // wrangler never restarted
  });
});
