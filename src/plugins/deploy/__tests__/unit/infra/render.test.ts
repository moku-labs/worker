/**
 * Unit tests for the branded infra panels (plan + provision result) — real BrandConsole, capturing
 * sink, color off (so the asserted text is the plain content the boxes frame).
 */
import { createBrandConsole } from "@moku-labs/common/cli";
import { describe, expect, it } from "vitest";

import {
  renderDeploySummary,
  renderPlan,
  renderProvisionResult,
  resourceName
} from "../../../infra/render";
import type { InfraPlan, ProvisionResult } from "../../../types";

/** A BrandConsole wired to a capturing sink (color off → plain text) + a joined-output reader. */
const capture = (): { ui: ReturnType<typeof createBrandConsole>; text: () => string } => {
  const lines: string[] = [];
  const ui = createBrandConsole({
    write: line => lines.push(line),
    writeError: line => lines.push(line),
    color: false
  });
  return { ui, text: () => lines.join("\n") };
};

describe("resourceName", () => {
  it("names kv/r2/d1/queue by resource name and do by className", () => {
    expect(resourceName({ kind: "kv", name: "tracker-cache", binding: "CACHE" })).toBe(
      "tracker-cache"
    );
    expect(resourceName({ kind: "r2", name: "tracker-assets", binding: "ASSETS" })).toBe(
      "tracker-assets"
    );
    expect(resourceName({ kind: "d1", name: "tracker-db", binding: "DB" })).toBe("tracker-db");
    expect(resourceName({ kind: "queue", name: "tracker-jobs", binding: "JOBS" })).toBe(
      "tracker-jobs"
    );
    expect(resourceName({ kind: "do", binding: "COUNTER", className: "Counter" })).toBe("Counter");
  });
});

describe("renderPlan", () => {
  it("lists resources to create (+), existing ones (~ exists), and DOs (~ ships with worker)", () => {
    const { ui, text } = capture();
    const plan: InfraPlan = {
      account: "acct-123",
      accountId: "acct-123",
      exists: [{ resource: { kind: "r2", name: "tracker-assets", binding: "ASSETS" } }],
      missing: [
        { kind: "kv", name: "tracker-kv", binding: "KV" },
        { kind: "d1", name: "tracker-db", binding: "DB" }
      ],
      ships: [{ kind: "do", binding: "BOARD", className: "BoardChannel" }]
    };

    renderPlan(ui, plan);
    const out = text();

    expect(out).toContain("Infra plan");
    // The DO counts under "with worker", never under "exist".
    expect(out).toContain("2 to create · 1 exist · 1 with worker · acct-123");
    expect(out).toContain("+ kv");
    expect(out).toContain("tracker-kv");
    expect(out).toContain("~ r2");
    expect(out).toContain("(exists)");
    // The DO row is labelled "ships with worker", not "(exists)".
    expect(out).toContain("~ do");
    expect(out).toContain("BoardChannel");
    expect(out).toContain("(ships with worker)");
  });

  it("omits the 'with worker' segment when no DOs ship", () => {
    const { ui, text } = capture();
    const plan: InfraPlan = {
      account: "acct-123",
      accountId: "acct-123",
      exists: [],
      missing: [{ kind: "kv", name: "tracker-kv", binding: "KV" }],
      ships: []
    };

    renderPlan(ui, plan);
    const out = text();

    expect(out).toContain("1 to create · 0 exist · acct-123");
    expect(out).not.toContain("with worker");
    expect(out).not.toContain("ships with worker");
  });
});

describe("renderProvisionResult", () => {
  it("shows short rows in the box and prints the FULL, ANSI-stripped reason below", () => {
    const { ui, text } = capture();
    const esc = String.fromCodePoint(27); // build a realistic colorized wrangler error
    const result: ProvisionResult = {
      created: [{ resource: { kind: "kv", name: "tracker-kv", binding: "KV" } }],
      skipped: [{ resource: { kind: "d1", name: "tracker-db", binding: "DB" } }],
      bundled: [{ kind: "do", binding: "BOARD", className: "BoardChannel" }],
      failed: [
        {
          resource: { kind: "r2", name: "ATTACHMENTS", binding: "ATTACHMENTS" },
          error: `[moku-worker] wrangler exited with code 1.\n  ${esc}[31m✘ [ERROR]${esc}[0m The bucket name "ATTACHMENTS" is invalid. Bucket names must be between 3 and 63 characters long.\n\n🪵 Logs were written to "/tmp/wrangler.log"`
        }
      ],
      ids: {}
    };

    renderProvisionResult(ui, result);
    const out = text();
    const flat = out.replaceAll(/\s+/gu, " "); // de-wrap to assert the full sentence is intact

    expect(out).toContain("Provisioned");
    expect(out).toContain("✓ kv");
    expect(out).toContain("~ d1");
    expect(out).toContain("✗ r2");
    // The DO is reported as bundled (ships with worker), not created/skipped-as-existing.
    expect(out).toContain("~ do");
    expect(out).toContain("BoardChannel");
    expect(out).toContain("(ships with worker)");
    expect(out).toContain("1 created · 1 exist · 1 with worker · 1 failed");

    // The full reason is printed below the box — not truncated, ANSI + wrapper + [ERROR] stripped.
    expect(flat).toContain(
      'The bucket name "ATTACHMENTS" is invalid. Bucket names must be between 3 and 63 characters long.'
    );
    expect(out).not.toContain("…"); // never truncated
    expect(out).not.toContain("[ERROR]"); // wrangler marker stripped
    expect(out).not.toContain(esc); // no ANSI escapes leaked into the output
    expect(out).not.toContain("Logs were written to"); // wrangler's log-file pointer dropped
  });

  it("reports 0 failed cleanly when everything provisioned (and omits 'with worker' with no DOs)", () => {
    const { ui, text } = capture();
    const result: ProvisionResult = {
      created: [{ resource: { kind: "kv", name: "tracker-kv", binding: "KV" } }],
      skipped: [],
      bundled: [],
      failed: [],
      ids: {}
    };

    renderProvisionResult(ui, result);

    expect(text()).toContain("1 created · 0 exist · 0 failed");
    expect(text()).not.toContain("with worker");
  });
});

describe("renderDeploySummary", () => {
  it("leads with the URL, then stage, the resource tally, and elapsed time", () => {
    const { ui, text } = capture();

    renderDeploySummary(ui, {
      url: "https://tracker.example.workers.dev",
      stage: "production",
      created: 0,
      exists: 4,
      bundled: 1,
      failed: 0,
      elapsedMs: 4234
    });
    const out = text();

    expect(out).toContain("Deployed"); // the panel heading
    expect(out).toContain("https://tracker.example.workers.dev"); // the URL headline
    expect(out).toContain("production"); // the target stage
    expect(out).toContain("4 exist · 0 created · 1 with worker"); // the resource tally incl. DOs
    expect(out).toContain("4.2s"); // elapsed, one-decimal seconds
  });

  it("formats sub-second + multi-minute durations and surfaces a failed count", () => {
    const sub = capture();
    renderDeploySummary(sub.ui, {
      url: "https://x.workers.dev",
      stage: "staging",
      created: 2,
      exists: 1,
      bundled: 0,
      failed: 1,
      elapsedMs: 820
    });
    expect(sub.text()).toContain("820ms"); // sub-second
    expect(sub.text()).toContain("1 failed"); // failed count surfaced in the tally
    expect(sub.text()).not.toContain("with worker"); // omitted when no DOs ship

    const long = capture();
    renderDeploySummary(long.ui, {
      url: "https://x.workers.dev",
      stage: "production",
      created: 0,
      exists: 0,
      bundled: 0,
      failed: 0,
      elapsedMs: 64_000
    });
    expect(long.text()).toContain("1m04s"); // minutes once past 60s
  });
});
