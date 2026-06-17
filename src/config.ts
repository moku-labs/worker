/**
 * @file Framework configuration — Config + Events types, core plugin registration.
 */
import { envPlugin, logPlugin } from "@moku-labs/common";
import { createCoreConfig } from "@moku-labs/core";
import { stagePlugin } from "./plugins/stage";

/** Per-request Cloudflare bindings object (env). Framework-level shared type. */
export type WorkerEnv = Record<string, unknown>;

/** Global framework config — flat, with complete defaults. */
export type WorkerConfig = {
  stage: "production" | "development" | "test";
  name: string;
  compatibilityDate: string;
};

/** Global framework events — declared once, visible to every plugin. */
export type WorkerEvents = {
  "request:start": { method: string; path: string; requestId: string };
  "request:end": { method: string; path: string; status: number; ms: number };
  "deploy:phase": { phase: string; detail?: string };
  "deploy:complete": { url: string };
  "provision:resource": { kind: "kv" | "r2" | "d1" | "queue" | "do"; name: string };
};

const defaultConfig: WorkerConfig = {
  stage: "production",
  name: "moku-worker",
  compatibilityDate: ""
};

export const coreConfig = createCoreConfig<
  WorkerConfig,
  WorkerEvents,
  [typeof logPlugin, typeof envPlugin, typeof stagePlugin]
>("moku-worker", {
  config: defaultConfig,
  plugins: [logPlugin, envPlugin, stagePlugin]
});

export const { createPlugin, createCore } = coreConfig;
