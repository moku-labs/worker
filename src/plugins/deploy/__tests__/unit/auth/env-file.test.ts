/**
 * Unit tests for the `.env.local` scaffolder (real fs in a temp dir).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureEnvLocal } from "../../../auth/env-file";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "moku-envfile-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensureEnvLocal", () => {
  it("creates .env.local with the given content when absent", async () => {
    const result = await ensureEnvLocal(dir, "CLOUDFLARE_API_TOKEN=\n");

    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(dir, ".env.local"));
    expect(await readFile(result.path, "utf8")).toBe("CLOUDFLARE_API_TOKEN=\n");
  });

  it("never overwrites an existing .env.local (it may hold real secrets)", async () => {
    const filePath = path.join(dir, ".env.local");
    await writeFile(filePath, "CLOUDFLARE_API_TOKEN=real-secret\n", "utf8");

    const result = await ensureEnvLocal(dir, "CLOUDFLARE_API_TOKEN=\n");

    expect(result.created).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("CLOUDFLARE_API_TOKEN=real-secret\n");
  });
});
