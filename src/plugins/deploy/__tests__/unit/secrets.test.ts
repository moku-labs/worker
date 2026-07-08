/**
 * Unit tests for the post-deploy secrets helpers — runner stubbed, parser exercised on real
 * wrangler `secret list` output shapes (clean JSON, surrounding log noise, garbage).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../runner", () => ({
  runWrangler: vi.fn().mockResolvedValue("[]"),
  runWranglerStdin: vi.fn().mockResolvedValue("")
}));

import { runWrangler, runWranglerStdin } from "../../runner";
import { createPostDeploySecrets, parseSecretNames } from "../../secrets";

describe("parseSecretNames", () => {
  it("parses a clean wrangler secret list JSON array", () => {
    const output =
      '[\n  { "name": "TURN_KEY_ID", "type": "secret_text" },\n  { "name": "TURN_KEY_API_TOKEN", "type": "secret_text" }\n]';
    expect(parseSecretNames(output)).toEqual(["TURN_KEY_ID", "TURN_KEY_API_TOKEN"]);
  });

  it("slices the array out of surrounding wrangler log lines", () => {
    const output = ' ⛅️ wrangler 4.20.0\n[ { "name": "API_KEY", "type": "secret_text" } ]\nDone.';
    expect(parseSecretNames(output)).toEqual(["API_KEY"]);
  });

  it("returns [] for no secrets, garbage, and rows without a string name", () => {
    expect(parseSecretNames("[]")).toEqual([]);
    expect(parseSecretNames("no json here")).toEqual([]);
    expect(parseSecretNames("[ { not json ]")).toEqual([]);
    expect(parseSecretNames('[ { "type": "secret_text" }, 42, null ]')).toEqual([]);
  });
});

describe("createPostDeploySecrets", () => {
  it("list runs wrangler secret list against the given config and parses the names", async () => {
    vi.mocked(runWrangler).mockResolvedValueOnce('[ { "name": "TURN_KEY_ID" } ]');
    const secrets = createPostDeploySecrets("wrangler.custom.jsonc");

    const names = await secrets.list();

    expect(runWrangler).toHaveBeenCalledWith([
      "secret",
      "list",
      "--config",
      "wrangler.custom.jsonc"
    ]);
    expect(names).toEqual(["TURN_KEY_ID"]);
  });

  it("putBulk pipes the secrets JSON to wrangler secret bulk over stdin", async () => {
    const secrets = createPostDeploySecrets("wrangler.jsonc");

    await secrets.putBulk({ TURN_KEY_ID: "uid-1", TURN_KEY_API_TOKEN: "s3cret" });

    expect(runWranglerStdin).toHaveBeenCalledWith(
      ["secret", "bulk", "--config", "wrangler.jsonc"],
      JSON.stringify({ TURN_KEY_ID: "uid-1", TURN_KEY_API_TOKEN: "s3cret" })
    );
  });
});
