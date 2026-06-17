/**
 * @file deploy plugin — provider dispatch (kind → provision* adapter).
 *
 * Dispatches a resource descriptor to the matching per-kind provisioning routine.
 * Node-only; never imported by the runtime Worker bundle.
 */
import type { ResourceManifest } from "../types";
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
 * @returns Resolves once the resource is provisioned.
 * @example
 * ```ts
 * await provisionResource({ kind: "kv", binding: "CACHE" }, false);
 * await provisionResource({ kind: "r2", bucket: "ASSETS" }, false);
 * ```
 */
export const provisionResource = async (resource: ResourceManifest, ci: boolean): Promise<void> => {
  switch (resource.kind) {
    case "kv": {
      await provisionKv(resource, ci);
      break;
    }
    case "r2": {
      await provisionR2(resource, ci);
      break;
    }
    case "d1": {
      await provisionD1(resource, ci);
      break;
    }
    case "queue": {
      await provisionQueue(resource, ci);
      break;
    }
    case "do": {
      await provisionDurableObject(resource, ci);
      break;
    }
  }
};
