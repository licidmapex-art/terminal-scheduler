import { describe, expect, it } from "vitest";
import { runScheduler } from "../scheduler";
import { replaySimulation } from "../replaySimulation";
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

describe("replaySimulation stochastic", () => {
  it("matches plain replay when stochastic is disabled", () => {
    const config = makeConfig();
    const scheduled = runScheduler(customers, resources, config);
    const plain = replaySimulation(customers, resources, config, scheduled.scheduledSlots);
    const withDisabled = replaySimulation(customers, resources, config, scheduled.scheduledSlots, [], {
      stochasticConfig: { enabled: false, legDelays: [], pipeline: { flowMultiplier: { kind: "fixed", value: 1 } }, immobilisation: { events: [] } }
    });
    expect(withDisabled.simulationLog.length).toBe(plain.simulationLog.length);
    expect(withDisabled.scheduledSlots.length).toBe(plain.scheduledSlots.length);
  });

  it("pipeline stop at hour 1 reduces inventory vs baseline replay", () => {
    const config = makeConfig();
    const scheduled = runScheduler(customers, resources, config);
    const baseline = replaySimulation(customers, resources, config, scheduled.scheduledSlots);

    const stopped = replaySimulation(customers, resources, config, scheduled.scheduledSlots, [], {
      simulationOverrides: {
        slotAdjustments: [],
        immobilisationWindows: [],
        pipelineMultiplierByHour: { 1: { c1: 0 } }
      }
    });

    const invBaselineH2 = baseline.simulationLog[2]?.customerInventories.c1 ?? 0;
    const invStoppedH2 = stopped.simulationLog[2]?.customerInventories.c1 ?? 0;
    expect(invStoppedH2).toBeLessThan(invBaselineH2);
    expect(stopped.simulationLog[1]?.pipelineFlow.c1).toBe(0);
  });

  it("samples reproducibly with a fixed seed", () => {
    const config = makeConfig();
    const scheduled = runScheduler(customers, resources, config);
    const slot = scheduled.scheduledSlots[0];
    if (!slot) return;

    const stoch: StochasticConfig = {
      enabled: true,
      seed: 777,
      legDelays: [
        {
          customerId: slot.customerId,
          direction: slot.direction,
          delayProbability: 1,
          delayHours: { kind: "fixed", value: 3 }
        }
      ],
      pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
      immobilisation: { events: [] }
    };

    const a = replaySimulation(customers, resources, config, scheduled.scheduledSlots, [], {
      stochasticConfig: stoch,
      seed: 777
    });
    const b = replaySimulation(customers, resources, config, scheduled.scheduledSlots, [], {
      stochasticConfig: stoch,
      seed: 777
    });

    expect(a.stochasticSeed).toBe(777);
    expect(a.simulationOverrides?.slotAdjustments).toEqual(b.simulationOverrides?.slotAdjustments);
    expect(a.scheduledSlots[0]?.start.getTime()).toBe(b.scheduledSlots[0]?.start.getTime());
  });
});
