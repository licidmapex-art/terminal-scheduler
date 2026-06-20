import { describe, expect, it } from "vitest";
import { runScheduler } from "../scheduler";
import { runMonteCarlo } from "./runMonteCarlo";
import type { Customer, Resource, SimulationConfig, StochasticConfig } from "../../types";

function makeConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    startDate: new Date("2025-01-01T00:00:00Z"),
    endDate: new Date("2025-01-08T00:00:00Z"),
    pipelineFlowRate: 50,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100_000,
    storageMode: "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000,
    ...overrides
  };
}

const customers: Customer[] = [
  {
    id: "c1",
    name: "Customer 1",
    declaredInboundThroughput: 1000,
    currentInventory: 5000,
    storageShare: 100,
    pipelineFlowPerHour: 50,
    inboundMEPS: 0,
    inboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundMEPS: 500,
    outboundMode: "ship",
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24
  }
];

const resources: Resource[] = [
  {
    id: "berth-1",
    name: "Berth 1",
    type: "berth_large",
    flowRate: 100,
    blackouts: []
  }
];

describe("runMonteCarlo", () => {
  it("produces stable aggregates for fixed base seed", () => {
    const config = makeConfig();
    const scheduled = runScheduler(customers, resources, config);
    const stoch: StochasticConfig = {
      enabled: true,
      legDelays: [],
      pipeline: {
        flowMultiplier: { kind: "uniform", min: 0.5, max: 1.5 }
      },
      immobilisation: { events: [] }
    };

    const input = {
      workingSlots: scheduled.scheduledSlots,
      customers,
      resources,
      config,
      stochasticConfig: stoch
    };

    const a = runMonteCarlo(input, { iterations: 3, baseSeed: 42 });
    const b = runMonteCarlo(input, { iterations: 3, baseSeed: 42 });

    expect(a.runSeeds).toEqual(b.runSeeds);
    expect(a.aggregates.terminalInventory.p50).toEqual(b.aggregates.terminalInventory.p50);
    expect(a.runs?.length).toBe(3);
  });
});
