import { describe, expect, it } from "vitest";
import { aggregateMonteCarloMetrics } from "./aggregateMonteCarlo";

describe("aggregateMonteCarloMetrics", () => {
  it("aggregates warning counts and event histograms", () => {
    const { aggregates, customerSummaries } = aggregateMonteCarloMetrics(
      [
        {
          seed: 1,
          terminalByHour: [100, 200],
          customerByHour: { c1: [50, 150] },
          pipelineInboundByHour: [1, 0.5],
          pipelineOutboundByHour: [1, 1],
          warningKeys: ["tank_full"],
          eventKinds: ["pipeline_stop"]
        },
        {
          seed: 2,
          terminalByHour: [80, 180],
          customerByHour: { c1: [40, 140] },
          pipelineInboundByHour: [1, 1],
          pipelineOutboundByHour: [1, 0],
          warningKeys: ["tank_full", "tank_full_c1"],
          eventKinds: ["pipeline_reduction", "pipeline_reduction"]
        }
      ],
      ["c1"]
    );

    expect(aggregates.warningCounts.tank_full).toBe(2);
    expect(aggregates.eventHistograms.pipeline_stop).toBe(1);
    expect(aggregates.eventHistograms.pipeline_reduction).toBe(2);
    expect(aggregates.terminalInventory.p50[0]).toBe(90);
    expect(aggregates.pipelineInbound.p50[1]).toBe(0.75);
    expect(aggregates.pipelineOutbound.p50[1]).toBe(0.5);
    expect(customerSummaries[0]?.customerId).toBe("c1");
    expect(customerSummaries[0]?.warningRate).toBe(0.5);
  });
});
