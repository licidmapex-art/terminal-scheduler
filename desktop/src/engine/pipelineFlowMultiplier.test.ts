import { describe, expect, it } from "vitest";
import type { StochasticEvent } from "../types";
import {
  pipelineBarHeightPx,
  pipelineFlowMultiplierAtHour,
  pipelineFlowMultiplierSeries
} from "./pipelineFlowMultiplier";
import type { SimulationLogRow } from "./simulationLog";

function ev(kind: StochasticEvent["kind"], magnitude?: number): StochasticEvent {
  return {
    id: "test",
    kind,
    hourStart: 0,
    hourEnd: 1,
    magnitude,
    label: kind
  };
}

describe("pipelineFlowMultiplierAtHour", () => {
  it("returns 0 at tank top for inbound", () => {
    expect(pipelineFlowMultiplierAtHour("inbound", 100_000, 100_000, [], false)).toBe(0);
  });

  it("returns 0 at tank bottom for outbound", () => {
    expect(pipelineFlowMultiplierAtHour("outbound", 0, 100_000, [], false)).toBe(0);
  });

  it("applies stochastic stop and reduction", () => {
    expect(
      pipelineFlowMultiplierAtHour("inbound", 50_000, 100_000, [ev("pipeline_stop")], true)
    ).toBe(0);
    expect(
      pipelineFlowMultiplierAtHour(
        "inbound",
        50_000,
        100_000,
        [ev("pipeline_reduction", 0.4)],
        true
      )
    ).toBe(0.4);
  });
});

describe("pipelineFlowMultiplierSeries", () => {
  it("builds per-hour multipliers from simulation log", () => {
    const log: Pick<SimulationLogRow, "terminalTotal" | "customerInventories" | "stochasticEvents">[] =
      [
        { terminalTotal: 1000, customerInventories: {}, stochasticEvents: [] },
        {
          terminalTotal: 2000,
          customerInventories: {},
          stochasticEvents: [ev("pipeline_reduction", 0.5)]
        }
      ];
    const series = pipelineFlowMultiplierSeries("inbound", log, 100_000, true);
    expect(series).toEqual([1, 0.5]);
  });
});

describe("pipelineBarHeightPx", () => {
  it("matches Gantt pipeline bar heights", () => {
    expect(pipelineBarHeightPx(1)).toBe(12);
    expect(pipelineBarHeightPx(0)).toBe(12);
    expect(pipelineBarHeightPx(0.5)).toBe(10);
  });
});
