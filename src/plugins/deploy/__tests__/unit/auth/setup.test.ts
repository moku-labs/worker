/**
 * Unit tests for the `auth setup` guidance renderer (pure).
 */
import { describe, expect, it } from "vitest";

import { tokenInstructions } from "../../../auth/setup";
import type { ExternalManifest } from "../../../types";

const manifest = (resources: ExternalManifest["resources"]): ExternalManifest => ({
  name: "w",
  compatibilityDate: "2026-06-17",
  resources
});

const render = (resources: ExternalManifest["resources"]): string =>
  tokenInstructions(manifest(resources));

describe("tokenInstructions", () => {
  it("lists the required permissions and the create-token URL", () => {
    const text = render([{ kind: "kv", binding: "KV" }]);

    expect(text).toContain("Cloudflare API token");
    expect(text).toContain("dash.cloudflare.com/profile/api-tokens");
    expect(text).toContain("Account · Workers KV Storage");
  });

  it("flags D1/Queues as additions when present", () => {
    const text = render([
      { kind: "d1", binding: "DB" },
      { kind: "queue", producers: ["q"] }
    ]);

    expect(text).toContain("add to template");
    expect(text).toMatch(/ADD: .*D1 -> Edit/u);
    expect(text).toContain("Queues -> Edit");
  });

  it("says no changes are needed when the stock template suffices", () => {
    const text = render([{ kind: "kv", binding: "KV" }]);

    expect(text).toContain("no changes needed");
    expect(text).not.toContain("add to template");
  });

  it("includes the .env.local credential lines", () => {
    const text = render([]);

    expect(text).toContain("CLOUDFLARE_API_TOKEN=");
    expect(text).toContain("CLOUDFLARE_ACCOUNT_ID=");
  });

  it("renders both a LOCAL (first deploy) and a CI (automation) section", () => {
    const text = render([{ kind: "kv", binding: "KV" }]);

    expect(text).toContain("LOCAL — first deploy");
    expect(text).toContain("CI — automation redeploy");
    expect(text).toContain("Create Custom Token");
  });

  it("the CI section scopes data resources to Read (never Edit)", () => {
    const text = render([{ kind: "d1", binding: "DB" }]);
    const ciPart = text.slice(text.indexOf("CI — automation redeploy"));

    expect(ciPart).toContain("Account · D1 : Read");
    expect(ciPart).not.toContain("Account · Account Settings");
  });
});
