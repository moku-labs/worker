/**
 * Unit tests for the moku-worker bin dispatcher (pure; stub app).
 */
import { describe, expect, it, vi } from "vitest";

import { type CliApp, dispatch, HELP, parseArgv } from "../../dispatch";

const makeApp = () => {
  const cli = {
    dev: vi.fn<(opts?: { port?: number }) => Promise<void>>().mockResolvedValue(undefined),
    deploy: vi
      .fn<(opts?: { guided?: boolean; yes?: boolean }) => Promise<void>>()
      .mockResolvedValue(undefined),
    auth: vi.fn<(sub?: "setup") => Promise<void>>().mockResolvedValue(undefined),
    doctor: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    whoami: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    wrangler: vi.fn<(args: string[]) => Promise<void>>().mockResolvedValue(undefined)
  };
  return { app: { cli } satisfies CliApp, cli };
};

describe("parseArgv", () => {
  it("splits the verb from the rest", () => {
    expect(parseArgv(["dev", "--port", "3000"])).toEqual({ verb: "dev", rest: ["--port", "3000"] });
  });

  it("defaults to help when empty", () => {
    expect(parseArgv([])).toEqual({ verb: "help", rest: [] });
  });
});

describe("dispatch", () => {
  it("dev forwards --port", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "dev", ["--port", "3000"]);
    expect(cli.dev).toHaveBeenCalledWith({ port: 3000 });
  });

  it("dev with no port passes undefined", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "dev", []);
    expect(cli.dev).toHaveBeenCalledWith(undefined);
  });

  it("deploy defaults to guided", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "deploy", []);
    expect(cli.deploy).toHaveBeenCalledWith({ guided: true });
  });

  it("deploy --yes / --ci skips prompts", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "deploy", ["--yes"]);
    expect(cli.deploy).toHaveBeenCalledWith({ yes: true });
  });

  it("auth setup forwards 'setup'; bare auth forwards undefined", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "auth", ["setup"]);
    await dispatch(app, "auth", []);
    expect(cli.auth).toHaveBeenNthCalledWith(1, "setup");
    expect(cli.auth).toHaveBeenNthCalledWith(2, undefined);
  });

  it("wrangler forwards all args", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "wrangler", ["kv", "namespace", "list"]);
    expect(cli.wrangler).toHaveBeenCalledWith(["kv", "namespace", "list"]);
  });

  it("doctor and whoami dispatch", async () => {
    const { app, cli } = makeApp();
    await dispatch(app, "doctor", []);
    await dispatch(app, "whoami", []);
    expect(cli.doctor).toHaveBeenCalled();
    expect(cli.whoami).toHaveBeenCalled();
  });

  it("help returns the command tree", async () => {
    const { app } = makeApp();
    expect(await dispatch(app, "help", [])).toBe(HELP);
  });

  it("an unknown verb returns an error + help", async () => {
    const { app } = makeApp();
    const out = await dispatch(app, "bogus", []);
    expect(out).toContain("Unknown command: bogus");
  });
});
