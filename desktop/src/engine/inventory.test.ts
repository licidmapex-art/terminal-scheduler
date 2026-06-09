/**
 * Inventory timeline behaviour (pipeline baseline vs physical floor).
 */

import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  getProjectedInventory,
  simulationPeriodHoursFloored,
  tallyPipelineTonnesFromSimulationLog,
  tallyRefusedTonnesAtTankExtremes,
  applySharedInventoryPipelineHour,
  sharedInventoryPipelineOutboundTakeCap,
  planSharedInventoryPipelineOutboundHour,
  theoreticalInventoryDeltaWithoutTankClamp,
  replaySharedShippingTerminalFlowTotals,
  attributeSharedShippingFlowsToCustomers,
  attributeSharedShippingFlowsForAnalytics,
  customerStorageShareFrac
} from "./inventory";
import { runScheduler } from "./scheduler";
import type { Customer, Resource, SimulationConfig } from "../types";

describe("simulationPeriodHoursFloored", () => {
  it("floors partial-hour ranges to match scheduler / buildTimeline", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-01T03:30:00Z");
    const config = makeConfig({ startDate: start, endDate: end });
    expect(simulationPeriodHoursFloored(config)).toBe(3);
  });
});

describe("theoreticalInventoryDeltaWithoutTankClamp", () => {
  it("matches pipeline + slot integral minus tank clamp effect on delta (fixed_band)", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-01T05:00:00Z");
    const config = makeConfig({
      startDate: start,
      endDate: end,
      pipelineDirection: "inbound",
      storageMode: "fixed_band"
    });
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 100,
        pipelineFlowPerHour: 10,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 0
      }
    ];
    const slots: import("../types").ScheduledSlot[] = [];
    const clamped = buildTimeline(customers, config, slots);
    const arr = clamped.get("c1")!;
    const deltaClamped = arr[arr.length - 1]! - arr[0]!;
    const theoryMap = theoreticalInventoryDeltaWithoutTankClamp(customers, config, slots);
    const deltaTheory = theoryMap?.get("c1") ?? 0;
    expect(deltaTheory).toBe(50);
    expect(deltaClamped).toBe(50);
  });
});

describe("tallyPipelineTonnesFromSimulationLog", () => {
  it("skips hour 0 and splits signed flow into inbound vs outbound tonnes", () => {
    const rows = [
      { hour: 0, pipelineFlow: { c1: 100, c2: -50 } },
      { hour: 1, pipelineFlow: { c1: 10, c2: -5 } },
      { hour: 2, pipelineFlow: { c1: 10, c2: -5 } }
    ];
    const m = tallyPipelineTonnesFromSimulationLog(rows);
    expect(m.get("c1")).toEqual({ inbound: 20, outbound: 0 });
    expect(m.get("c2")).toEqual({ inbound: 0, outbound: 10 });
  });
});

describe("shared_shipping flow attribution", () => {
  it("splits terminal berth tonnes by storage share, not slot owner", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-08T00:00:00Z");
    const config = makeConfig({ startDate: start, endDate: end, storageMode: "shared_shipping" });
    const customers: Customer[] = [
      {
        id: "c-a",
        name: "Alpha",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        storageShare: 50,
        pipelineFlowPerHour: 0,
        inboundMEPS: 300,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "c-b",
        name: "Beta",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        storageShare: 50,
        pipelineFlowPerHour: 0,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const slots: import("../types").ScheduledSlot[] = [
      {
        id: "s1",
        customerId: "c-a",
        resourceId: "berth-1",
        direction: "inbound",
        mode: "ship",
        legKey: null,
        volume: 600,
        start: start,
        end: new Date(start.getTime() + 6 * 60 * 60 * 1000),
        status: "scheduled",
        conflictReason: null
      }
    ];
    const totals = replaySharedShippingTerminalFlowTotals(customers, config, slots);
    expect(totals.berthInbound).toBeCloseTo(600, 0);
    const attr = attributeSharedShippingFlowsToCustomers(customers, totals);
    expect(attr.get("c-a")?.berthInbound).toBeCloseTo(300, 0);
    expect(attr.get("c-b")?.berthInbound).toBeCloseTo(300, 0);
    const timeline = buildTimeline(customers, config, slots);
    const scaled = attributeSharedShippingFlowsForAnalytics(customers, timeline, totals);
    for (const c of customers) {
      const arr = timeline.get(c.id)!;
      const delta = arr[arr.length - 1]! - arr[0]!;
      expect(scaled.get(c.id)?.berthInbound).toBeCloseTo(delta, 0);
    }
    expect(customerStorageShareFrac(customers[0]!, customers)).toBe(0.5);
  });

  it("attributed flows reconcile with proportional inventory delta", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-03T00:00:00Z");
    const config = makeConfig({ startDate: start, endDate: end, storageMode: "shared_shipping" });
    const customers: Customer[] = [
      {
        id: "c-a",
        name: "Alpha",
        declaredInboundThroughput: 0,
        currentInventory: 1000,
        storageShare: 60,
        pipelineFlowPerHour: 0,
        inboundMEPS: 200,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "c-b",
        name: "Beta",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        storageShare: 40,
        pipelineFlowPerHour: 0,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const slots: import("../types").ScheduledSlot[] = [
      {
        id: "s1",
        customerId: "c-a",
        resourceId: "berth-1",
        direction: "inbound",
        mode: "ship",
        legKey: null,
        volume: 400,
        start: start,
        end: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        status: "scheduled",
        conflictReason: null
      }
    ];
    const timeline = buildTimeline(customers, config, slots);
    const totals = replaySharedShippingTerminalFlowTotals(customers, config, slots);
    const attr = attributeSharedShippingFlowsForAnalytics(customers, timeline, totals);
    for (const c of customers) {
      const a = attr.get(c.id)!;
      const massNet = a.berthInbound + a.pipelineInbound - a.berthOutbound - a.pipelineOutbound;
      const arr = timeline.get(c.id)!;
      const delta = arr[arr.length - 1]! - arr[0]!;
      expect(massNet).toBeCloseTo(delta, 0);
    }
  });
});

describe("tallyRefusedTonnesAtTankExtremes", () => {
  it("counts curtailed inbound pipeline at tank top (shared_inventory)", () => {
    const config = makeConfig({
      storageMode: "shared_inventory",
      pipelineDirection: "inbound",
      totalStorageCapacity: 1000
    });
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 1000,
        pipelineFlowPerHour: 100,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        outboundMEPS: 0,
        outboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const log = [
      {
        hour: 0,
        datetime: "2025-01-01T00:00:00.000Z",
        customerInventories: { c1: 1000 },
        terminalTotal: 1000,
        pipelineFlow: { c1: 0 },
        transportStatus: []
      },
      {
        hour: 1,
        datetime: "2025-01-01T01:00:00.000Z",
        customerInventories: { c1: 1000 },
        terminalTotal: 1000,
        pipelineFlow: { c1: 0 },
        transportStatus: []
      }
    ];
    const m = tallyRefusedTonnesAtTankExtremes(customers, config, log);
    expect(m.get("c1")?.refusedAtTopTonnes).toBe(100);
    expect(m.get("c1")?.refusedAtBottomTonnes).toBe(0);
  });

  it("counts outbound pipeline refused at tank bottom interruption hours", () => {
    const config = makeConfig({
      pipelineDirection: "outbound",
      totalStorageCapacity: 1000
    });
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        pipelineFlowPerHour: 67,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        outboundMEPS: 0,
        outboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const log = [
      {
        hour: 0,
        datetime: "2025-01-01T00:00:00.000Z",
        customerInventories: { c1: 0 },
        terminalTotal: 0,
        pipelineFlow: { c1: 0 },
        transportStatus: []
      },
      {
        hour: 1,
        datetime: "2025-01-01T01:00:00.000Z",
        customerInventories: { c1: 0 },
        terminalTotal: 0,
        pipelineFlow: { c1: 0 },
        transportStatus: []
      }
    ];
    const m = tallyRefusedTonnesAtTankExtremes(customers, config, log);
    expect(m.get("c1")?.refusedAtBottomTonnes).toBe(67);
    expect(m.get("c1")?.refusedAtTopTonnes).toBe(0);
  });
});

function makeConfig(overrides?: Partial<SimulationConfig>): SimulationConfig {
  const start = new Date("2025-01-01T00:00:00Z");
  const end = new Date("2026-01-01T00:00:00Z");
  return {
    startDate: start,
    endDate: end,
    pipelineFlowRate: 0,
    pipelineDirection: "outbound",
    totalStorageCapacity: 2_000_000,
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

describe("buildTimeline (fixed_band)", () => {
  it("keeps hourly values >= 0 for a full year of outbound pipeline drain (no slots)", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 50_000,
        pipelineFlowPerHour: 50,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "barge",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const tl = buildTimeline(customers, config, []);
    const arr = tl.get("c1")!;
    expect(arr.length).toBeGreaterThan(8000);
    for (let h = 0; h < arr.length; h++) {
      expect(arr[h]).toBeGreaterThanOrEqual(0);
    }
    expect(Math.min(...arr)).toBe(0);
  });

  it("after scheduling ships and barges, projected inventory never reads below zero", () => {
    const config = makeConfig({
      pipelineFlowRate: 0,
      pipelineDirection: "outbound"
    });
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 800_000,
        currentInventory: 400_000,
        pipelineFlowPerHour: 50,
        storageShare: 100,
        inboundMEPS: 800_000,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 4000,
        outboundMode: "barge",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const resources: Resource[] = [
      {
        id: "bl",
        name: "L",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      },
      {
        id: "bs",
        name: "S",
        type: "berth_small",
        flowRate: 500,
        blackouts: []
      }
    ];
    const result = runScheduler(customers, resources, config);
    const arr = result.inventoryTimeline.get("c1")!;
    const simStart = config.startDate;
    for (let h = 0; h < arr.length; h += 168) {
      const dt = new Date(simStart.getTime() + h * 60 * 60 * 1000);
      const inv = getProjectedInventory(
        "c1",
        dt,
        result.inventoryTimeline,
        config,
        customers
      );
      expect(inv).toBeGreaterThanOrEqual(0);
    }
  });

  it("hourly length is periodHours + 1 and per-customer pipeline rate scales outbound drain", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-03T00:00:00Z");
    const config: SimulationConfig = {
      startDate: start,
      endDate: end,
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100000,
      storageMode: "fixed_band",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 10_000,
        pipelineFlowPerHour: 50,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const tl = buildTimeline(customers, config, []);
    const arr = tl.get("c1")!;
    expect(arr.length).toBe(49);
    expect(arr[0]).toBe(10_000);
    expect(arr[1]).toBe(10_000 - 50);
  });
});

describe("buildTimeline (shared_inventory)", () => {
  it("hourly attributed inventories sum to at most terminal capacity under inbound pipeline", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-03T00:00:00Z");
    const capacity = 100_000;
    const config: SimulationConfig = {
      startDate: start,
      endDate: end,
      pipelineFlowRate: 0,
      pipelineDirection: "inbound",
      totalStorageCapacity: capacity,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 45_000,
        pipelineFlowPerHour: 250,
        storageShare: 60,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "c2",
        name: "B",
        declaredInboundThroughput: 0,
        currentInventory: 40_000,
        pipelineFlowPerHour: 250,
        storageShare: 40,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const tl = buildTimeline(customers, config, []);
    const a1 = tl.get("c1")!;
    const a2 = tl.get("c2")!;
    for (let h = 0; h < a1.length; h++) {
      expect(a1[h]! + a2[h]!).toBeLessThanOrEqual(capacity + 1e-6);
    }
  });

  it("at full terminal pool inbound pipeline adds no inventory", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-02T00:00:00Z");
    const capacity = 100_000;
    const config: SimulationConfig = {
      startDate: start,
      endDate: end,
      pipelineFlowRate: 0,
      pipelineDirection: "inbound",
      totalStorageCapacity: capacity,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 60_000,
        pipelineFlowPerHour: 500,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "c2",
        name: "B",
        declaredInboundThroughput: 0,
        currentInventory: 40_000,
        pipelineFlowPerHour: 500,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const tl = buildTimeline(customers, config, []);
    const a1 = tl.get("c1")!;
    const a2 = tl.get("c2")!;
    for (let h = 1; h < a1.length; h++) {
      expect(a1[h]!).toBe(60_000);
      expect(a2[h]!).toBe(40_000);
    }
  });

  it("outbound pipeline preserves borrower deficits instead of zeroing all attributions", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "c1",
        name: "Creditor",
        declaredInboundThroughput: 0,
        currentInventory: 5600,
        pipelineFlowPerHour: 600,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "c2",
        name: "Borrower",
        declaredInboundThroughput: 0,
        currentInventory: -5000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const invById: Record<string, number> = { c1: 5600, c2: -5000 };
    applySharedInventoryPipelineHour(invById, customers, config);
    // Terminal total reaches zero, but borrower deficit remains visible.
    expect(Math.round((invById.c1 + invById.c2) * 1000) / 1000).toBe(0);
    expect(invById.c2).toBe(-5000);
    expect(invById.c1).toBe(5000);
  });

  it("shared_inventory outbound pipeline drains each customer at their own rate only", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "pipe",
        name: "Pipeline",
        declaredInboundThroughput: 0,
        currentInventory: 10_000,
        pipelineFlowPerHour: 46,
        pipelineOutboundPerHour: 46,
        storageShare: 33,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "other",
        name: "Other",
        declaredInboundThroughput: 0,
        currentInventory: 90_000,
        pipelineFlowPerHour: 0,
        storageShare: 67,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const invById: Record<string, number> = { pipe: 10_000, other: 90_000 };
    const effective = applySharedInventoryPipelineHour(invById, customers, config);
    expect(effective.pipe).toBe(-46);
    expect(effective.other).toBe(0);
    expect(invById.pipe).toBe(10_000 - 46);
    expect(invById.other).toBe(90_000);
  });

  it("shared_inventory outbound pipeline borrows from zero at full rate down to −x", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 50_000,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "pipe",
        name: "Pipeline",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        pipelineFlowPerHour: 46,
        pipelineOutboundPerHour: 46,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "creditor",
        name: "Creditor",
        declaredInboundThroughput: 0,
        currentInventory: 50_000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const invById: Record<string, number> = { pipe: 0, creditor: 50_000 };
    const effective = applySharedInventoryPipelineHour(invById, customers, config);
    expect(effective.pipe).toBe(-46);
    expect(invById.pipe).toBe(-46);
    expect(invById.creditor).toBe(50_000);
  });

  it("shared_inventory outbound pipeline stops at customer deficit floor −x", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 1_000,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "pipe",
        name: "Pipeline",
        declaredInboundThroughput: 0,
        currentInventory: -980,
        pipelineFlowPerHour: 46,
        pipelineOutboundPerHour: 46,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "creditor",
        name: "Creditor",
        declaredInboundThroughput: 0,
        currentInventory: 5000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    expect(sharedInventoryPipelineOutboundTakeCap(-980, 46, config)).toBe(20);
    const invById: Record<string, number> = { pipe: -980, creditor: 5000 };
    const effective = applySharedInventoryPipelineHour(invById, customers, config);
    expect(effective.pipe).toBe(-20);
    expect(invById.pipe).toBe(-1000);

    invById.pipe = -1000;
    const blocked = applySharedInventoryPipelineHour(invById, customers, config);
    expect(blocked.pipe).toBe(0);
    expect(invById.pipe).toBe(-1000);
  });

  it("shared_inventory outbound pipeline cannot borrow when terminal physical stock is empty", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 50_000,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "pipe",
        name: "Pipeline",
        declaredInboundThroughput: 0,
        currentInventory: 0,
        pipelineFlowPerHour: 46,
        pipelineOutboundPerHour: 46,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      },
      {
        id: "borrower",
        name: "Borrower",
        declaredInboundThroughput: 0,
        currentInventory: -10_000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const invById: Record<string, number> = { pipe: 0, borrower: -10_000 };
    const effective = applySharedInventoryPipelineHour(invById, customers, config);
    expect(effective.pipe).toBe(0);
    expect(invById.pipe).toBe(0);
    expect(invById.borrower).toBe(-10_000);
  });

  it("shared_inventory outbound pipeline is capped by remaining terminal physical stock", () => {
    const config: SimulationConfig = {
      startDate: new Date("2025-01-01T00:00:00Z"),
      endDate: new Date("2025-01-02T00:00:00Z"),
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 100_000,
      storageMode: "shared_inventory",
      sharedInventoryCustomerDeficitLimitTonnes: 50_000,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    const customers: Customer[] = [
      {
        id: "pipe",
        name: "Pipeline",
        declaredInboundThroughput: 0,
        currentInventory: 30,
        pipelineFlowPerHour: 46,
        pipelineOutboundPerHour: 46,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const invById: Record<string, number> = { pipe: 30 };
    const { takes } = planSharedInventoryPipelineOutboundHour(invById, customers, config);
    expect(takes.pipe).toBe(30);
  });
});

describe("buildTimeline cargo window (pre/post ops)", () => {
  it("applies inbound flow only during cargo hours, not full occupation", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-02T00:00:00Z");
    const config = makeConfig({
      startDate: start,
      endDate: end,
      preOpsHours: 2,
      postOpsHours: 1
    });
    const customers: Customer[] = [
      {
        id: "c1",
        name: "A",
        declaredInboundThroughput: 0,
        currentInventory: 10_000,
        pipelineFlowPerHour: 0,
        storageShare: 100,
        inboundMEPS: 0,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        outboundRoundtripHours: 0,
        timeSharedMinBand: 0,
        timeSharedDuration: 24
      }
    ];
    const slot = {
      id: "s1",
      customerId: "c1",
      resourceId: "r1",
      direction: "inbound" as const,
      mode: "ship" as const,
      volume: 1000,
      start: start,
      end: new Date(start.getTime() + 4 * 60 * 60 * 1000),
      status: "scheduled" as const,
      conflictReason: null
    };
    const tl = buildTimeline(customers, config, [slot]);
    const arr = tl.get("c1")!;
    expect(arr[0]).toBe(10_000);
    expect(arr[1]).toBe(10_000);
    expect(arr[2]).toBe(11_000);
    expect(arr[3]).toBe(11_000);
  });
});
