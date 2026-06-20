/**
 * Unit tests for the branded `auth setup` renderer — real BrandConsole, capturing sink, color off
 * (so the asserted text is the plain content the panels frame).
 */
import { createBrandConsole } from "@moku-labs/common/cli";
import { describe, expect, it } from "vitest";

import { ciToken, requiredToken } from "../../../auth/permissions";
import { renderAuthSetup } from "../../../auth/render";
import type { ExternalManifest } from "../../../types";

const manifest = (resources: ExternalManifest["resources"]): ExternalManifest => ({
  name: "w",
  compatibilityDate: "2026-06-17",
  resources
});

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

describe("renderAuthSetup", () => {
  it("renders a heading and the LOCAL token panel with permissions + create-token steps", () => {
    const { ui, text } = capture();

    renderAuthSetup(ui, requiredToken(manifest([{ kind: "kv", name: "cache", binding: "KV" }])));
    const out = text();

    expect(out).toContain("Cloudflare API token");
    expect(out).toContain("LOCAL — first deploy");
    expect(out).toContain("Account · Workers KV Storage : Edit");
    expect(out).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(out).toContain(".env.local");
  });

  it("highlights D1/Queues as additions to the template when present", () => {
    const { ui, text } = capture();

    renderAuthSetup(
      ui,
      requiredToken(
        manifest([
          { kind: "d1", name: "db", binding: "DB" },
          { kind: "queue", name: "q", binding: "Q" }
        ])
      )
    );
    const out = text();

    expect(out).toMatch(/ADD .*D1 → Edit/u);
    expect(out).toContain("Queues → Edit");
    expect(out).toContain("← add to template");
  });

  it("shows a pointer to `auth setup` for CI when ci groups are omitted (guided deploy)", () => {
    const { ui, text } = capture();

    renderAuthSetup(ui, requiredToken(manifest([{ kind: "kv", name: "cache", binding: "KV" }])));
    const out = text();

    expect(out).toContain("Need a CI token later?");
    expect(out).not.toContain("CI — automation redeploy");
  });

  it("renders the compact CI panel when ci groups are supplied (`auth setup` command)", () => {
    const { ui, text } = capture();
    const m = manifest([{ kind: "d1", name: "db", binding: "DB" }]);

    renderAuthSetup(ui, requiredToken(m), { ci: ciToken(m) });
    const out = text();

    expect(out).toContain("CI — automation redeploy");
    expect(out).toContain("Account · D1 : Read"); // CI scopes data resources to Read
    expect(out).not.toContain("Need a CI token later?");
  });
});
