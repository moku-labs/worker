/**
 * @file deploy plugin — provider dispatch (kind → provision* adapter).
 *
 * Dispatches a resource descriptor to the matching per-kind provisioning routine and returns
 * its outcome (the captured Cloudflare id for kv/d1; an empty outcome for r2/queue/do, which
 * are referenced by name). Node-only; never imported by the runtime Worker bundle.
 */
import type { ProvisionOutcome, ResourceManifest } from "../types";
import { provisionD1 } from "./d1";
import { provisionDurableObject } from "./do";
import { provisionKv } from "./kv";
import { provisionQueue } from "./queues";
import { provisionR2 } from "./r2";

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
  }
};
