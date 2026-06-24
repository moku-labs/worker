/**
 * @file deploy plugin — Worker script deletion adapter.
 *
 * Deletes the deployed Worker script itself (the counterpart to `wrangler deploy`). Deleting the
 * Worker also removes its routes and — critically — its Durable Object namespaces and all of their
 * stored data, which have no standalone `wrangler` delete command. Node-only; never imported by the
 * runtime Worker bundle.
 */

import { runWranglerYes } from "../runner";

/**
 * Delete the deployed Worker via `wrangler delete <name> --force`, auto-answering the confirmation
 * prompt (the verb has no `-y` flag). `--force` lets the delete proceed even if another Worker
 * depends on this one. Deleting the Worker removes its script, routes, and Durable Object namespaces
 * (with their stored data) — so Durable Objects need no separate teardown command.
 *
 * @param name - The stage-qualified Worker name (e.g. "tracker-worker-dev").
 * @returns Resolves once wrangler reports the Worker deleted.
 * @throws {Error} When wrangler exits non-zero (e.g. the Worker is not deployed).
 * @example
 * ```ts
 * await deleteWorker("tracker-worker-dev");
 * ```
 */
export const deleteWorker = async (name: string): Promise<void> => {
  await runWranglerYes(["delete", name, "--force"]);
};
