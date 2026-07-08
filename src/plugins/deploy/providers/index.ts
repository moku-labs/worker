/**
 * @file deploy plugin — provider dispatch (kind → provision* adapter).
 *
 * Dispatches a resource descriptor to the matching per-kind provisioning routine and returns
 * its outcome (the captured Cloudflare id for kv/d1; an empty outcome for r2/queue/do, which
 * are referenced by name). Node-only; never imported by the runtime Worker bundle.
 */
import type { ProvisionedRef, ProvisionOutcome, ResourceManifest } from "../types";
import { deleteD1, provisionD1 } from "./d1";
import { provisionDurableObject } from "./do";
import { deleteKv, provisionKv } from "./kv";
import { deleteQueue, provisionQueue } from "./queues";
import { deleteR2, provisionR2 } from "./r2";

/**
 * Dispatch a resource descriptor to the matching provider's provisioning routine.
 *
 * @param resource - The resource descriptor to provision.
 * @param ci - Whether running non-interactively.
 * @returns The provisioning outcome — `{ id }` for kv/d1, `{}` for r2/queue/do.
 * @example
 * ```ts
 * const { id } = await provisionResource({ kind: "kv", binding: "CACHE" }, false);
 * await provisionResource({ kind: "r2", bucket: "ASSETS" }, false); // {}
 * ```
 */
export const provisionResource = async (
  resource: ResourceManifest,
  ci: boolean
): Promise<ProvisionOutcome> => {
  switch (resource.kind) {
    case "kv": {
      return provisionKv(resource, ci);
    }
    case "d1": {
      return provisionD1(resource, ci);
    }
    case "r2": {
      await provisionR2(resource, ci);
      return {};
    }
    case "queue": {
      await provisionQueue(resource, ci);
      return {};
    }
    case "do": {
      await provisionDurableObject(resource, ci);
      return {};
    }
    case "turn": {
      // TURN keys are ensured in the built-in post-deploy phase (worker secrets need an existing
      // script) — the infra plan never routes them here; a no-op keeps the dispatch total.
      return {};
    }
  }
};

/**
 * Dispatch an existing resource (discovered by the infra preflight) to the matching provider's
 * deletion routine — the inverse of {@link provisionResource}. KV deletes by its captured namespace
 * id; d1/r2/queue delete by their stage-qualified name. Durable Objects never reach here (they ship
 * with the Worker and are removed when it is deleted), so a `do` ref is a programming error.
 *
 * @param ref - The existing resource to delete (descriptor + captured Cloudflare id for kv/d1).
 * @returns Resolves once the resource is deleted.
 * @throws {Error} When a KV ref carries no captured id, a Durable Object is passed, or wrangler fails.
 * @example
 * ```ts
 * await destroyResource({ resource: { kind: "kv", name: "cache-dev", binding: "CACHE" }, id: "ns123" });
 * ```
 */
export const destroyResource = async (ref: ProvisionedRef): Promise<void> => {
  const { resource } = ref;
  switch (resource.kind) {
    case "kv": {
      if (ref.id === undefined) {
        throw new Error(
          `[worker] Cannot delete KV namespace "${resource.name}" — no namespace id was captured.`
        );
      }
      await deleteKv(ref.id);
      return;
    }
    case "d1": {
      await deleteD1(resource.name);
      return;
    }
    case "r2": {
      await deleteR2(resource.name);
      return;
    }
    case "queue": {
      await deleteQueue(resource.name);
      return;
    }
    case "do": {
      throw new Error(
        `[worker] Durable Object "${resource.className}" is removed with the Worker, not individually.`
      );
    }
    case "turn": {
      // The account-level TURN key is deliberately left in place (its worker secrets die with the
      // Worker; the key is harmless and its secret is unrecoverable anyway). Never planned here.
      return;
    }
  }
};
