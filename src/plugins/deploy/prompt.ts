/**
 * @file deploy plugin — inline typed text prompt (node:readline).
 *
 * `@moku-labs/common/cli` only ships a y/N `confirm` and a one-of-N `select`; teardown needs a free
 * TEXT prompt (the user types the stage name to confirm a destroy). This is that primitive, kept
 * local to the worker plugin for now. The input/output streams are injectable so tests drive it
 * without a real TTY. Node-only; never imported by the runtime Worker bundle.
 */
import { createInterface } from "node:readline";

/**
 * Ask a free-text question and resolve the user's trimmed answer. Built on `node:readline`; the
 * input/output streams default to `process.stdin`/`process.stdout` but are injectable for tests.
 * Only meaningful on an interactive TTY (callers gate on that before prompting).
 *
 * @param question - The prompt to display (e.g. `Type the stage name "dev" to confirm: `).
 * @param io - Optional injectable streams.
 * @param io.input - Readable stream the answer is read from. Defaults to `process.stdin`.
 * @param io.output - Writable stream the prompt echoes to. Defaults to `process.stdout`.
 * @returns Resolves with the entered line, trimmed.
 * @example
 * ```ts
 * const typed = await promptLine(`Type the stage name "dev" to confirm: `);
 * if (typed !== "dev") abort();
 * ```
 */
export const promptLine = (
  question: string,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}
): Promise<string> =>
  new Promise<string>(resolve => {
    const readline = createInterface({
      input: io.input ?? process.stdin,
      output: io.output ?? process.stdout
    });
    readline.question(question, answer => {
      readline.close();
      resolve(answer.trim());
    });
  });
