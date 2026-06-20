/**
 * Unit tests for the Cloudflare API token permission derivation (pure, table-driven).
 */
import { describe, expect, it } from "vitest";

import { ciToken, requiredToken } from "../../../auth/permissions";
import type { ExternalManifest } from "../../../types";

const manifest = (resources: ExternalManifest["resources"]): ExternalManifest => ({
  name: "w",
  compatibilityDate: "2026-06-17",
  resources
});

describe("requiredToken", () => {
  it("always requires Workers Scripts (deploy) and Account Settings (account)", () => {
    const groups = requiredToken(manifest([])).required.map(permission => permission.group);

    expect(groups).toContain("Account · Workers Scripts");
    expect(groups).toContain("Account · Account Settings");
  });

  it("requires nothing to add when only kv/r2 are present (covered by the stock template)", () => {
    const { toAdd } = requiredToken(
      manifest([
        { kind: "kv", binding: "KV" },
        { kind: "r2", bucket: "ASSETS" }
      ])
    );

    expect(toAdd).toEqual([]);
  });

  it("flags D1 as a permission to add (not in the stock template)", () => {
    const { required, toAdd } = requiredToken(manifest([{ kind: "d1", binding: "DB" }]));

    expect(required.map(permission => permission.group)).toContain("Account · D1");
    expect(toAdd.map(permission => permission.group)).toContain("Account · D1");
  });

  it("flags Queues as a permission to add", () => {
    const { toAdd } = requiredToken(manifest([{ kind: "queue", producers: ["orders"] }]));

    expect(toAdd.map(permission => permission.group)).toContain("Account · Queues");
  });

  it("requires nothing extra for durable objects (covered by Workers Scripts)", () => {
    const { required } = requiredToken(
      manifest([{ kind: "do", bindings: { counter: "COUNTER" } }])
    );

    // Only the two ALWAYS groups — DO ships with the script.
    expect(required).toHaveLength(2);
  });

  it("dedupes a permission when multiple resources of the same kind exist", () => {
    const { required } = requiredToken(
      manifest([
        { kind: "kv", binding: "A" },
        { kind: "kv", binding: "B" }
      ])
    );

    const kvGroups = required.filter(p => p.group === "Account · Workers KV Storage");
    expect(kvGroups).toHaveLength(1);
  });

  it("collects D1 + Queues in toAdd for a full app", () => {
    const { toAdd } = requiredToken(
      manifest([
        { kind: "kv", binding: "KV" },
        { kind: "d1", binding: "DB" },
        { kind: "queue", producers: ["q"] }
      ])
    );

    expect(toAdd.map(permission => permission.group).toSorted()).toEqual([
      "Account · D1",
      "Account · Queues"
    ]);
  });
});

describe("ciToken (reduced automation token)", () => {
  it("requires only Workers Scripts (Edit) for a bare app", () => {
    expect(ciToken(manifest([]))).toEqual([
      { group: "Account · Workers Scripts", scope: "Edit", reason: "deploy", inBaseTemplate: true }
    ]);
  });

  it("scopes data resources to Read — CI lists existing infra, never creates", () => {
    const byGroup = Object.fromEntries(
      ciToken(
        manifest([
          { kind: "kv", binding: "KV" },
          { kind: "d1", binding: "DB" },
          { kind: "queue", producers: ["q"] }
        ])
      ).map(permission => [permission.group, permission.scope])
    );

    expect(byGroup["Account · Workers KV Storage"]).toBe("Read");
    expect(byGroup["Account · D1"]).toBe("Read");
    expect(byGroup["Account · Queues"]).toBe("Read");
  });

  it("keeps R2 at Edit (asset upload writes objects)", () => {
    const r2 = ciToken(manifest([{ kind: "r2", bucket: "ASSETS" }])).find(
      permission => permission.group === "Account · Workers R2 Storage"
    );

    expect(r2?.scope).toBe("Edit");
  });

  it("omits Account Settings — CI pins CLOUDFLARE_ACCOUNT_ID (no account lookup)", () => {
    const groups = ciToken(manifest([{ kind: "kv", binding: "KV" }])).map(
      permission => permission.group
    );

    expect(groups).not.toContain("Account · Account Settings");
  });

  it("needs nothing extra for durable objects (ship with the script)", () => {
    expect(ciToken(manifest([{ kind: "do", bindings: { counter: "COUNTER" } }]))).toHaveLength(1);
  });
});
