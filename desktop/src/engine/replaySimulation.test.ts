import { describe, expect, it } from "vitest";
import { runScheduler } from "./scheduler";
import { replaySimulation } from "./replaySimulation";
import type { Customer, Resource, SimulationConfig } from "../types";

function makeConfig(): SimulationConfig {
  return {
    startDate: new Date("2025-01-01T00:00:00Z"),
    endDate: new Date("2025-01-08T00:00:00Z"),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100_000,
    storageMode: "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000
  };
}

describe("replaySimulation", () => {
  it("replays the same slot list without adding bookings", () => {
    const customers: Customer[] = [
      {
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 5000,
        storageShare: 20,
        pipelineFlowPerHour: 0,
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
    const config = makeConfig();
    const scheduled = runScheduler(customers, resources, config);
    expect(scheduled.scheduledSlots.length).toBeGreaterThan(0);

    const replayed = replaySimulation(customers, resources, config, scheduled.scheduledSlots);
    expect(replayed.scheduledSlots.length).toBe(scheduled.scheduledSlots.length);
    expect(replayed.simulationLog.length).toBeGreaterThan(0);
    expect(replayed.inventoryTimeline.size).toBe(customers.length);
  });
});
