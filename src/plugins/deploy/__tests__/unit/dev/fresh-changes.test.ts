/**
 * Unit tests for the dev-watcher freshness guard (`dev/fresh-changes.ts`) — real fs, no mocks. A
 * stale watch echo (e.g. an APFS clone echo) reports a path as "changed" while leaving its inode
 * untouched (mtime AND ctime unchanged), so `hasFreshChange` must reject batches of such paths —
 * and accept every batch that carries a real write, a metadata change, or a deletion. These
 * invariants are what keep the dev watcher from feeding itself (rebuild → copy → echo → rebuild).
 * NOTE: an old ctime cannot be fabricated (utimes resets ctime to now) — the metadata case moves
 * ctime alone via chmod instead.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { hasFreshChange } from "../../../dev/fresh-changes";

const root = mkdtempSync(path.join(tmpdir(), "fresh-changes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Small real-clock pause so file timestamps land strictly on one side of a threshold. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 15));

describe("hasFreshChange", () => {
  it("rejects an echo-only batch — paths exist but predate the threshold", async () => {
    const echo = path.join(root, "echo.mp3");
    writeFileSync(echo, "unchanged");
    await settle();

    expect(hasFreshChange([echo], Date.now())).toBe(false);
  });

  it("accepts a batch whose file was written after the threshold", async () => {
    const edited = path.join(root, "edited.mp3");
    const since = Date.now();
    await settle();
    writeFileSync(edited, "fresh bytes");

    expect(hasFreshChange([edited], since)).toBe(true);
  });

  it("accepts a metadata-only change (ctime moves even when mtime does not)", async () => {
    const chmodded = path.join(root, "chmodded.mp3");
    writeFileSync(chmodded, "same bytes");
    await settle();
    const since = Date.now();
    await settle();
    chmodSync(chmodded, 0o600);

    expect(hasFreshChange([chmodded], since)).toBe(true);
  });

  it("accepts a batch containing a deleted path — echoes never remove the source", () => {
    expect(hasFreshChange([path.join(root, "gone.mp3")], Date.now())).toBe(true);
  });

  it("accepts a mixed batch when ANY path is really fresh", async () => {
    const stale = path.join(root, "stale.mp3");
    const live = path.join(root, "live.ts");
    writeFileSync(stale, "old");
    await settle();
    const since = Date.now();
    await settle();
    writeFileSync(live, "new");

    expect(hasFreshChange([stale, live], since)).toBe(true);
  });

  it("rejects an empty batch — nothing to rebuild for", () => {
    expect(hasFreshChange([], 0)).toBe(false);
  });
});
