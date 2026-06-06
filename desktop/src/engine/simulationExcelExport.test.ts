import { describe, it, expect } from "vitest";
import {
  computeHourlyBerthTonnesByBucket,
  tallyBerthTonnesByCustomerFromSlots
} from "./simulationExcelExport";
import type { ScheduledSlot, SimulationConfig } from "../types";

describe("computeHourlyBerthTonnesByBucket", () => {
  it("sums hourly berth flow to slot volume when cargo window fits whole hours", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const config: SimulationConfig = {
      startDate: start,
      endDate: new Date("2025-01-05T00:00:00.000Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "inbound",
      totalStorageCapacity: 100000,
      storageMode: "fixed_band",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    // 10h loading, 1000 t/h → 10000 t; cargo [0, 10h) from sim start
    const slot: ScheduledSlot = {
      id: "s1",
      customerId: "c1",
      resourceId: "r1",
      direction: "outbound",
      mode: "ship",
      volume: 10000,
      start: start,
      end: new Date(start.getTime() + 10 * 3600 * 1000),
      status: "scheduled",
      conflictReason: null
    };
    const maxH = 24;
    const byHour = computeHourlyBerthTonnesByBucket([slot], config, maxH);
    let total = 0;
    const key = "c1|outbound|ship";
    for (let h = 0; h <= maxH; h++) {
      total += byHour.get(h)?.[key] ?? 0;
    }
    expect(total).toBeCloseTo(10000, 5);
  });
});

describe("tallyBerthTonnesByCustomerFromSlots", () => {
  it("aggregates all mode buckets to inbound/outbound per customer", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const config: SimulationConfig = {
      startDate: start,
      endDate: new Date("2025-01-05T00:00:00.000Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "inbound",
      totalStorageCapacity: 100000,
      storageMode: "fixed_band",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const outbound: ScheduledSlot = {
      id: "s1",
      customerId: "c1",
      resourceId: "r1",
      direction: "outbound",
      mode: "ship",
      volume: 5000,
      start: start,
      end: new Date(start.getTime() + 5 * 3600 * 1000),
      status: "scheduled",
      conflictReason: null
    };
    const inbound: ScheduledSlot = {
      id: "s2",
      customerId: "c1",
      resourceId: "r1",
      direction: "inbound",
      mode: "barge",
      volume: 3000,
      start: start,
      end: new Date(start.getTime() + 3 * 3600 * 1000),
      status: "scheduled",
      conflictReason: null
    };
    const m = tallyBerthTonnesByCustomerFromSlots([outbound, inbound], config, 24);
    expect(m.get("c1")).toEqual({ inbound: 3000, outbound: 5000 });
  });
});
