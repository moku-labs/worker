/**
 * Unit tests for the inline typed text prompt (promptLine), driven via injected streams.
 */
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { promptLine } from "../../prompt";

describe("promptLine", () => {
  it("resolves the line the user typed", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = promptLine(`Type the stage name "dev" to confirm: `, { input, output });
    input.write("dev\n");

    await expect(answer).resolves.toBe("dev");
  });

  it("trims surrounding whitespace from the answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = promptLine("Type: ", { input, output });
    input.write("  production  \n");

    await expect(answer).resolves.toBe("production");
  });

  it("resolves an empty string when the user just hits enter", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = promptLine("Type: ", { input, output });
    input.write("\n");

    await expect(answer).resolves.toBe("");
  });

  it("echoes the question to the output stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString("utf8");
    });

    const answer = promptLine("Type the stage name: ", { input, output });
    input.write("dev\n");
    await answer;

    expect(written).toContain("Type the stage name:");
  });
});
