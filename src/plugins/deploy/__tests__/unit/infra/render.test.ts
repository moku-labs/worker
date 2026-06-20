/**
 * Unit tests for the branded infra panels (plan + provision result) — real BrandConsole, capturing
 * sink, color off (so the asserted text is the plain content the boxes frame).
 */
import { createBrandConsole } from "@moku-labs/common/cli";
import { describe, expect, it } from "vitest";

import { renderPlan, renderProvisionResult, resourceName } from "../../../infra/render";
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
  it("lists resources to create (+) and existing ones (~), with a counts + account summary", () => {
    const { ui, text } = capture();
    const plan: InfraPlan = {
      account: "acct-123",
      accountId: "acct-123",
      exists: [{ resource: { kind: "r2", name: "tracker-assets", binding: "ASSETS" } }],
      missing: [
        { kind: "kv", name: "tracker-kv", binding: "KV" },
        { kind: "d1", name: "tracker-db", binding: "DB" }
      ]
    };

    renderPlan(ui, plan);
    const out = text();

    expect(out).toContain("Infra plan");
    expect(out).toContain("2 to create · 1 exist · acct-123");
    expect(out).toContain("+ kv");
    expect(out).toContain("tracker-kv");
    expect(out).toContain("~ r2");
    expect(out).toContain("(exists)");
  });
});

describe("renderProvisionResult", () => {
  it("shows short rows in the box and prints the FULL, ANSI-stripped reason below", () => {
    const { ui, text } = capture();
    const esc = String.fromCodePoint(27); // build a realistic colorized wrangler error
    const result: ProvisionResult = {
      created: [{ resource: { kind: "kv", name: "tracker-kv", binding: "KV" } }],
      skipped: [{ resource: { kind: "d1", name: "tracker-db", binding: "DB" } }],
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
    expect(out).toContain("1 created · 1 exist · 1 failed");

    // The full reason is printed below the box — not truncated, ANSI + wrapper + [ERROR] stripped.
    expect(flat).toContain(
      'The bucket name "ATTACHMENTS" is invalid. Bucket names must be between 3 and 63 characters long.'
    );
    expect(out).not.toContain("…"); // never truncated
    expect(out).not.toContain("[ERROR]"); // wrangler marker stripped
    expect(out).not.toContain(esc); // no ANSI escapes leaked into the output
    expect(out).not.toContain("Logs were written to"); // wrangler's log-file pointer dropped
  });

  it("reports 0 failed cleanly when everything provisioned", () => {
    const { ui, text } = capture();
    const result: ProvisionResult = {
      created: [{ resource: { kind: "kv", name: "tracker-kv", binding: "KV" } }],
      skipped: [],
      failed: [],
      ids: {}
    };

    renderProvisionResult(ui, result);

    expect(text()).toContain("1 created · 0 exist · 0 failed");
  });
});
