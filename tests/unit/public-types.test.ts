import type { PluginCtx as CorePluginCtx } from "@moku-labs/core";
import { describe, expectTypeOf, it } from "vitest";

import type { PluginCtx, WorkerEvents, WorkerPluginCtx } from "../../src/index";

// Shapes a Layer-3 consumer plugin would use to type its own context.
type SampleConfig = { binding: string };
type SampleState = Record<string, never>;
type SampleEvents = { "sample:done": { id: string } };

describe("public type surface: PluginCtx / WorkerPluginCtx", () => {
  it("re-exports PluginCtx identically to @moku-labs/core (no Layer-1 import needed)", () => {
    // The motivating guarantee: a consumer can import PluginCtx from the framework
    // and get exactly core's type, so it never reaches into @moku-labs/core.
    expectTypeOf<PluginCtx<SampleConfig, SampleState, SampleEvents>>().toEqualTypeOf<
      CorePluginCtx<SampleConfig, SampleState, SampleEvents>
    >();
  });

  it("WorkerPluginCtx pre-merges the global WorkerEvents into the event map", () => {
    expectTypeOf<WorkerPluginCtx<SampleConfig, SampleState, SampleEvents>>().toEqualTypeOf<
      CorePluginCtx<SampleConfig, SampleState, WorkerEvents & SampleEvents>
    >();
  });

  it("WorkerPluginCtx defaults to only WorkerEvents when no own events are given", () => {
    expectTypeOf<WorkerPluginCtx<SampleConfig, SampleState>>().toEqualTypeOf<
      CorePluginCtx<SampleConfig, SampleState, WorkerEvents>
    >();
  });
});
