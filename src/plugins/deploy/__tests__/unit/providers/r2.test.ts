/**
 * Unit tests for the R2 provider adapter (provision + upload).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { provisionR2, uploadDirToR2 } from "../../../providers/r2";

vi.mock("../../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("r2 bucket created: ASSETS")
}));

import { runWrangler } from "../../../runner";

// ─────────────────────────────────────────────────────────────────────────────
// Temp directory for upload tests
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let uniqueDirId = 0;

beforeEach(async () => {
  uniqueDirId += 1;
  tmpDir = path.join(tmpdir(), `moku-r2-test-${Date.now()}-${uniqueDirId}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// provisionR2
// ─────────────────────────────────────────────────────────────────────────────

describe("provisionR2", () => {
  it("calls runWrangler with r2 bucket create args", async () => {
    await provisionR2({ kind: "r2", bucket: "ASSETS" }, false);

    expect(runWrangler).toHaveBeenCalledWith(
      expect.arrayContaining(["r2", "bucket", "create", "ASSETS"])
    );
  });

  it("resolves without throwing", async () => {
    await expect(provisionR2({ kind: "r2", bucket: "ASSETS" }, false)).resolves.toBeUndefined();
  });

  it("passes ci flag through (does not throw in ci mode)", async () => {
    await expect(provisionR2({ kind: "r2", bucket: "BUCKET" }, true)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uploadDirToR2
// ─────────────────────────────────────────────────────────────────────────────

describe("uploadDirToR2", () => {
  it("returns 0 when the directory is empty", async () => {
    const count = await uploadDirToR2("ASSETS", tmpDir);

    expect(count).toBe(0);
  });

  it("returns the number of files in the directory", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hello");
    await writeFile(path.join(tmpDir, "b.txt"), "world");

    const count = await uploadDirToR2("ASSETS", tmpDir);

    expect(count).toBe(2);
  });

  it("walks nested subdirectories and counts all files", async () => {
    const subDir = path.join(tmpDir, "sub");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(tmpDir, "root.txt"), "root");
    await writeFile(path.join(subDir, "nested.txt"), "nested");

    const count = await uploadDirToR2("ASSETS", tmpDir);

    expect(count).toBe(2);
  });

  it("calls runWrangler with r2 object put args for each file", async () => {
    await writeFile(path.join(tmpDir, "index.html"), "<html/>");

    await uploadDirToR2("ASSETS", tmpDir);

    expect(runWrangler).toHaveBeenCalledWith(expect.arrayContaining(["r2", "object", "put"]));
  });
});
