/**
 * Unit tests for the hour-by-hour scheduling engine.
 */

import { describe, it, expect } from "vitest";
import { runScheduler } from "./scheduler";
import { replaySimulation } from "./replaySimulation";
import { cargoTonnesInSimulationHour, getCargoWindowMs, laytimeFromConfig } from "./slotLaytime";
import type { Customer, Resource, SimulationConfig } from "../types";

function makeConfig(overrides?: Partial<SimulationConfig>): SimulationConfig {
  const start = new Date("2025-01-01T00:00:00Z");
  const end = new Date("2025-01-08T00:00:00Z"); // 7 days
  return {
    startDate: start,
    endDate: end,
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100000,
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

function makeCustomer(overrides: Partial<Customer> & Pick<Customer, "id" | "name">): Customer {
  return {
    declaredInboundThroughput: 0,
    currentInventory: 0,
    storageShare: 20,
    pipelineFlowPerHour: 0,
    inboundMEPS: 0,
    inboundMode: "ship",
    outboundMEPS: 0,
    outboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    ...overrides
  };
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 60 * 60 * 1000);
}

describe("runScheduler", () => {
  it("two outbound slots on same berth: sequential, not overlapping", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 5000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(2);
    expect(result.scheduledSlots.every((s) => s.direction === "outbound" && s.mode === "ship")).toBe(true);
    expect(result.scheduledSlots.every((s) => s.volume === 500)).toBe(true);

    const [slot1, slot2] = [...result.scheduledSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    expect(slot1!.end.getTime()).toBeLessThanOrEqual(slot2!.start.getTime());
    expect(slot1!.resourceId).toBe("berth-1");
    expect(slot2!.resourceId).toBe("berth-1");
  });

  it("outbound when inventory is insufficient: no slots scheduled", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 500,
        currentInventory: 100,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(0);
    const blocked = result.simulationLog.some((row) =>
      row.transportStatus.some(
        (t) => t.customerId === "c1" && t.blockingConstraint === "insufficient_inventory"
      )
    );
    expect(blocked).toBe(true);
  });

  it("barge uses berth_large when berth_small is in blackout", () => {
    const config = makeConfig();
    const start = config.startDate;
    const blackoutStart = addHours(start, 4);
    const blackoutEnd = addHours(start, 200);

    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 300,
        currentInventory: 10000,
        outboundMEPS: 150,
        outboundMode: "barge"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-small",
        name: "Berth Small",
        type: "berth_small",
        flowRate: 50,
        blackouts: [
          {
            id: "b1",
            resourceId: "berth-small",
            start: blackoutStart,
            end: blackoutEnd
          }
        ]
      },
      {
        id: "berth-large",
        name: "Berth Large",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(2);
    expect(result.scheduledSlots.every((s) => s.mode === "barge" && s.direction === "outbound")).toBe(true);

    const resourceIds = result.scheduledSlots.map((s) => s.resourceId);
    expect(resourceIds).toContain("berth-small");
    expect(resourceIds).toContain("berth-large");
  });

  it("barge small_only: uses only small berths when both are available", () => {
    const config = makeConfig({ bargeBerthAllocation: "small_only" });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 600,
        currentInventory: 10000,
        outboundMEPS: 150,
        outboundMode: "barge"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-small",
        name: "Berth Small",
        type: "berth_small",
        flowRate: 50,
        blackouts: []
      },
      {
        id: "berth-large",
        name: "Berth Large",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots.length).toBeGreaterThan(0);
    expect(result.scheduledSlots.every((s) => s.resourceId === "berth-small")).toBe(true);
  });

  it("barge prefer_small: uses small when free and large when small is blocked", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const config = makeConfig({ bargeBerthAllocation: "prefer_small", startDate: start });
    const blackoutStart = addHours(start, 0);
    const blackoutEnd = addHours(start, 200);

    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 300,
        currentInventory: 10000,
        outboundMEPS: 150,
        outboundMode: "barge"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-small",
        name: "Berth Small",
        type: "berth_small",
        flowRate: 50,
        blackouts: [
          {
            id: "b1",
            resourceId: "berth-small",
            start: blackoutStart,
            end: blackoutEnd
          }
        ]
      },
      {
        id: "berth-large",
        name: "Berth Large",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      }
    ];

    const blocked = runScheduler(customers, resources, config);
    expect(blocked.scheduledSlots.every((s) => s.resourceId === "berth-large")).toBe(true);

    const freeSmall = runScheduler(
      customers,
      resources.map((r) =>
        r.id === "berth-small" ? { ...r, blackouts: [] } : r
      ),
      config
    );
    expect(freeSmall.scheduledSlots.length).toBeGreaterThan(0);
    expect(freeSmall.scheduledSlots.every((s) => s.resourceId === "berth-small")).toBe(true);
  });

  it("shared_inventory: distributes inbound ship slots across customers without roundtrip", () => {
    const config = makeConfig({ storageMode: "shared_inventory", totalStorageCapacity: 100000 });
    const customers: Customer[] = [
      makeCustomer({
        id: "c-a",
        name: "Alpha",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      }),
      makeCustomer({
        id: "c-b",
        name: "Beta",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      })
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

    const result = runScheduler(customers, resources, config);
    const slotsA = result.scheduledSlots.filter(
      (s) => s.customerId === "c-a" && s.direction === "inbound"
    );
    const slotsB = result.scheduledSlots.filter(
      (s) => s.customerId === "c-b" && s.direction === "inbound"
    );

    expect(slotsA.length).toBeGreaterThan(0);
    expect(slotsB.length).toBeGreaterThan(0);
    expect(slotsA.length).toBe(slotsB.length);

    const ordered = [...result.scheduledSlots]
      .filter((s) => s.direction === "inbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    if (ordered.length >= 2) {
      expect(ordered[0]!.customerId).not.toBe(ordered[1]!.customerId);
    }
  });

  it("shared_shipping: distributes inbound ship slots across customers without roundtrip", () => {
    const config = makeConfig({ storageMode: "shared_shipping" });
    const customers: Customer[] = [
      makeCustomer({
        id: "c-a",
        name: "Alpha",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      }),
      makeCustomer({
        id: "c-b",
        name: "Beta",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      })
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

    const result = runScheduler(customers, resources, config);
    const slotsA = result.scheduledSlots.filter((s) => s.customerId === "c-a");
    const slotsB = result.scheduledSlots.filter((s) => s.customerId === "c-b");

    expect(slotsA.length).toBeGreaterThan(0);
    expect(slotsB.length).toBeGreaterThan(0);
    expect(slotsA.length).toBe(slotsB.length);

    const ordered = [...result.scheduledSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    if (ordered.length >= 2) {
      expect(ordered[0]!.customerId).not.toBe(ordered[1]!.customerId);
    }
  });

  it("shared_shipping: distributes outbound barge slots across customers without roundtrip", () => {
    const config = makeConfig({ storageMode: "shared_shipping" });
    const customers: Customer[] = [
      makeCustomer({
        id: "c-a",
        name: "Alpha",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        outboundMEPS: 150,
        outboundMode: "barge",
        outboundRoundtripHours: 0,
        currentInventory: 25000
      }),
      makeCustomer({
        id: "c-b",
        name: "Beta",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        outboundMEPS: 150,
        outboundMode: "barge",
        outboundRoundtripHours: 0,
        currentInventory: 25000
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-small",
        name: "Berth Small",
        type: "berth_small",
        flowRate: 50,
        blackouts: []
      },
      {
        id: "berth-large",
        name: "Berth Large",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);
    const outboundBarge = result.scheduledSlots.filter(
      (s) => s.direction === "outbound" && s.mode === "barge"
    );
    expect(outboundBarge.filter((s) => s.customerId === "c-a").length).toBeGreaterThan(0);
    expect(outboundBarge.filter((s) => s.customerId === "c-b").length).toBeGreaterThan(0);
  });

  it("barge alternate: balances across large and small berths", () => {
    const config = makeConfig({ bargeBerthAllocation: "alternate" });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 900,
        currentInventory: 10000,
        outboundMEPS: 150,
        outboundMode: "barge"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-small",
        name: "Berth Small",
        type: "berth_small",
        flowRate: 50,
        blackouts: []
      },
      {
        id: "berth-large",
        name: "Berth Large",
        type: "berth_large",
        flowRate: 50,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    const resourceIds = new Set(result.scheduledSlots.map((s) => s.resourceId));
    expect(resourceIds.has("berth-small")).toBe(true);
    expect(resourceIds.has("berth-large")).toBe(true);
  });

  it("two customers on one berth: sequential, not overlapping", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 500,
        currentInventory: 10000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      }),
      makeCustomer({
        id: "c2",
        name: "Customer 2",
        declaredInboundThroughput: 500,
        currentInventory: 10000,
        pipelineFlowPerHour: 0,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(2);
    const ordered = [...result.scheduledSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    expect(ordered[0]!.end.getTime()).toBeLessThanOrEqual(ordered[1]!.start.getTime());
    expect(ordered[0]!.resourceId).toBe("berth-1");
    expect(ordered[1]!.resourceId).toBe("berth-1");
    expect(ordered[0]!.customerId).not.toBe(ordered[1]!.customerId);
  });

  it("minSlotIntervalHours: second slot starts at least gap after first ends", () => {
    const config = makeConfig({ minSlotIntervalHours: 12 });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 10000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(2);
    const [slot1, slot2] = [...result.scheduledSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    const gapMs = new Date(slot2!.start).getTime() - new Date(slot1!.end).getTime();
    const gapHours = gapMs / (60 * 60 * 1000);
    expect(gapHours).toBeGreaterThanOrEqual(12);
    expect(slot1!.resourceId).toBe("berth-1");
    expect(slot2!.resourceId).toBe("berth-1");
  });

  it("preOpsHours and postOpsHours extend slot occupation duration", () => {
    const config = makeConfig({ preOpsHours: 2, postOpsHours: 1 });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "C",
        declaredInboundThroughput: 5000,
        currentInventory: 10_000,
        storageShare: 100,
        inboundMEPS: 1000,
        inboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 1000,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);
    expect(result.scheduledSlots.length).toBeGreaterThan(0);
    const s = result.scheduledSlots[0]!;
    const durH = (s.end.getTime() - s.start.getTime()) / (60 * 60 * 1000);
    expect(durH).toBeCloseTo(4, 5);
  });

  it("slot starts after blackout window on same resource", () => {
    const config = makeConfig();
    const start = config.startDate;
    const blackoutStart = addHours(start, 2);
    const blackoutEnd = addHours(start, 10);

    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 500,
        currentInventory: 10000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 100,
        blackouts: [
          {
            id: "blackout-1",
            resourceId: "berth-1",
            start: blackoutStart,
            end: blackoutEnd
          }
        ]
      }
    ];

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(1);
    const slot = result.scheduledSlots[0]!;
    expect(slot.start.getTime()).toBeGreaterThanOrEqual(blackoutEnd.getTime());
    expect(slot.end.getTime()).toBeGreaterThanOrEqual(blackoutEnd.getTime());
  });

  it("outbound pipeline: barge can schedule at simulation start when inventory allows", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-08T00:00:00Z");
    const config = makeConfig({
      startDate: start,
      endDate: end,
      pipelineFlowRate: 0,
      pipelineDirection: "outbound",
      totalStorageCapacity: 200000
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Terminal A",
        declaredInboundThroughput: 50000,
        currentInventory: 50000,
        pipelineFlowPerHour: 50,
        storageShare: 100,
        inboundMEPS: 50000,
        inboundMode: "ship",
        outboundMEPS: 4000,
        outboundMode: "barge"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-large",
        name: "Large",
        type: "berth_large",
        flowRate: 5000,
        blackouts: []
      },
      {
        id: "berth-small",
        name: "Small",
        type: "berth_small",
        flowRate: 2000,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    const bargeSlots = result.scheduledSlots.filter((s) => s.mode === "barge" && s.direction === "outbound");
    expect(bargeSlots.length).toBeGreaterThan(0);
    const firstBarge = bargeSlots.reduce((earliest, s) =>
      new Date(s.start).getTime() < new Date(earliest.start).getTime() ? s : earliest
    );
    expect(new Date(firstBarge.start).getTime()).toBe(start.getTime());
  });

  it("least recently used resource is selected when multiple are free", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 5000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-a",
        name: "Kade A",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      },
      {
        id: "berth-b",
        name: "Kade B",
        type: "berth_large",
        flowRate: 100,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    expect(result.scheduledSlots).toHaveLength(2);
    const slots = [...result.scheduledSlots].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    expect(slots[0]!.resourceId).not.toBe(slots[1]!.resourceId);
  });

  it("outbound slots respect pace spread across the horizon", () => {
    const simStart = new Date("2025-01-01T00:00:00Z");
    const simEnd = new Date(simStart.getTime() + 100 * 60 * 60 * 1000);
    const config: SimulationConfig = {
      startDate: simStart,
      endDate: simEnd,
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
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 5000,
        currentInventory: 1_000_000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);

    const outboundSlots = result.scheduledSlots
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    expect(outboundSlots).toHaveLength(10);

    // 0.5-slot look-ahead still allows some front-loading; allow 12h tolerance vs strict T/N.
    outboundSlots.forEach((slot, i) => {
      const slotHour = (new Date(slot.start).getTime() - simStart.getTime()) / 3600000;
      const minHour = (i / 10) * 100;
      expect(slotHour).toBeGreaterThanOrEqual(minHour - 12);
    });
  });

  it("pacer decile threshold delays next slot when set higher", () => {
    const baseCustomers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000, // target outbound slots = 2 over 7 days
        currentInventory: 1_000_000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const earlyConfig = makeConfig({ pacerOutboundRoundAtDecile: 1 });
    const lateConfig = makeConfig({ pacerOutboundRoundAtDecile: 8 });

    const early = runScheduler(baseCustomers, resources, earlyConfig);
    const late = runScheduler(baseCustomers, resources, lateConfig);

    const secondEarly = [...early.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;
    const secondLate = [...late.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;

    const earlyHour = (new Date(secondEarly.start).getTime() - earlyConfig.startDate.getTime()) / 3600000;
    const lateHour = (new Date(secondLate.start).getTime() - lateConfig.startDate.getTime()) / 3600000;
    expect(lateHour).toBeGreaterThan(earlyHour);
  });

  it("lower outbound allowance delays outbound relative to inbound pacing", () => {
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 1_000_000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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
    const looseOutbound = makeConfig({ pacerOutboundAllowance: 0.5, pacerInboundAllowance: 0.5 });
    const tightOutbound = makeConfig({ pacerOutboundAllowance: 0, pacerInboundAllowance: 0.5 });

    const loose = runScheduler(customers, resources, looseOutbound);
    const tight = runScheduler(customers, resources, tightOutbound);

    const secondLoose = [...loose.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;
    const secondTight = [...tight.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;

    const looseHour =
      (new Date(secondLoose.start).getTime() - looseOutbound.startDate.getTime()) / 3600000;
    const tightHour =
      (new Date(secondTight.start).getTime() - tightOutbound.startDate.getTime()) / 3600000;
    expect(tightHour).toBeGreaterThanOrEqual(looseHour);
  });

  it("relative optimizer: disabled at 0 keeps existing scheduling behavior", () => {
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 90_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      }),
      makeCustomer({
        id: "c2",
        name: "Customer 2",
        declaredInboundThroughput: 1000,
        currentInventory: 5_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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
    const baseline = runScheduler(customers, resources, makeConfig());
    const optimizerDisabled = runScheduler(
      customers,
      resources,
      makeConfig({ optimizerRelativeDocMultiplier: 0 })
    );
    expect(optimizerDisabled.scheduledSlots.length).toBe(baseline.scheduledSlots.length);
  });

  it("relative fulfillment optimizer: ahead customer yields in shared_inventory inbound pool", () => {
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: 100_000,
      optimizerRelativeFulfillmentMultiplier: 1
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "c-a",
        name: "Alpha",
        storageShare: 50,
        declaredInboundThroughput: 450,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      }),
      makeCustomer({
        id: "c-b",
        name: "Beta",
        storageShare: 50,
        declaredInboundThroughput: 600,
        inboundMEPS: 150,
        inboundMode: "ship",
        inboundRoundtripHours: 0,
        currentInventory: 0
      })
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

    const result = runScheduler(customers, resources, config);
    const hasFulfillmentYield = result.simulationLog.some((row) =>
      row.transportStatus.some(
        (s) =>
          s.customerId === "c-a" &&
          s.blockingConstraint === "optimizer_fulfillment" &&
          s.direction === "inbound"
      )
    );
    expect(hasFulfillmentYield).toBe(true);
  });

  it("relative optimizer: high-DoC customer yields so peer can schedule", () => {
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "HighStock",
        declaredInboundThroughput: 1000,
        currentInventory: 90_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      }),
      makeCustomer({
        id: "c2",
        name: "LowStock",
        declaredInboundThroughput: 1000,
        currentInventory: 5_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(
      customers,
      resources,
      makeConfig({ optimizerRelativeDocMultiplier: 1 })
    );
    const c2OptimizerBlock = result.simulationLog.some((row) =>
      row.transportStatus.some(
        (s) => s.customerId === "c2" && s.blockingConstraint === "optimizer_days_of_cover"
      )
    );
    expect(c2OptimizerBlock).toBe(true);
    const c1Slots = result.scheduledSlots.filter((s) => s.customerId === "c1");
    expect(c1Slots.length).toBeGreaterThan(0);
  });

  it("relative optimizer in shared_inventory uses terminal inventory context", () => {
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: 100_000,
      optimizerRelativeDocMultiplier: 1
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "LowStockShipper",
        declaredInboundThroughput: 1000,
        currentInventory: 1_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      }),
      makeCustomer({
        id: "c2",
        name: "HighStockPeer",
        declaredInboundThroughput: 1000,
        currentInventory: 89_000,
        storageShare: 50,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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

    const result = runScheduler(customers, resources, config);
    const c1Outbound = result.scheduledSlots.filter(
      (s) => s.customerId === "c1" && s.direction === "outbound"
    );
    const c2Outbound = result.scheduledSlots.filter(
      (s) => s.customerId === "c2" && s.direction === "outbound"
    );
    expect(c2Outbound.length).toBeGreaterThan(c1Outbound.length);
    const c1OptimizerBlock = result.simulationLog.some((row) =>
      row.transportStatus.some(
        (s) =>
          s.customerId === "c1" &&
          s.direction === "outbound" &&
          s.blockingConstraint === "optimizer_days_of_cover"
      )
    );
    expect(c1OptimizerBlock).toBe(true);
  });

  it("inventory timeline has no negative values", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 1000,
        currentInventory: 5000,
        outboundMEPS: 500,
        outboundMode: "ship"
      })
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
    const result = runScheduler(customers, resources, config);
    const arr = result.inventoryTimeline.get("c1") ?? [];
    for (const v of arr) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("shared_inventory: terminalTotal never exceeds storage capacity with inbound pipeline", () => {
    const cap = 100_000;
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: cap,
      pipelineDirection: "inbound"
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "A",
        currentInventory: 45_000,
        storageShare: 50,
        pipelineFlowPerHour: 300
      }),
      makeCustomer({
        id: "c2",
        name: "B",
        currentInventory: 40_000,
        storageShare: 50,
        pipelineFlowPerHour: 300
      })
    ];
    const result = runScheduler(customers, [], config);
    for (const row of result.simulationLog) {
      expect(row.terminalTotal).toBeLessThanOrEqual(cap);
      const sumRounded =
        (row.customerInventories["c1"] ?? 0) + (row.customerInventories["c2"] ?? 0);
      expect(sumRounded).toBe(row.terminalTotal);
    }
  });

  it("shared_inventory: at tank top inbound pipeline is fully curtailed (log shows zero effective flow)", () => {
    const cap = 100_000;
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: cap,
      pipelineDirection: "inbound"
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "A",
        currentInventory: 50_000,
        storageShare: 50,
        pipelineFlowPerHour: 400
      }),
      makeCustomer({
        id: "c2",
        name: "B",
        currentInventory: 50_000,
        storageShare: 50,
        pipelineFlowPerHour: 400
      })
    ];
    const result = runScheduler(customers, [], config);
    for (const row of result.simulationLog) {
      if (row.hour === 0) continue;
      expect(row.pipelineFlow["c1"]).toBe(0);
      expect(row.pipelineFlow["c2"]).toBe(0);
    }
    const last = result.simulationLog[result.simulationLog.length - 1]!;
    expect(last.terminalTotal).toBe(cap);
  });

  it("shared_inventory: pooled outbound load splits by inventory share across members", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 10000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inv: number) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 0,
        currentInventory: inv,
        storageShare: 50,
        outboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 10000,
            roundtripHours: 48,
            poolId: "pool-ship"
          }
        ]
      });
    const customers = [mk("a", 60_000), mk("b", 40_000)];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      }
    ];
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: 200_000,
      sharedInventoryCustomerDeficitLimitTonnes: 0
    });
    const result = runScheduler(customers, resources, config, [shipPool]);
    const simStartMs = new Date(config.startDate).getTime();
    const { preOps, postOps } = laytimeFromConfig(config);

    for (const slot of result.scheduledSlots.filter(
      (s) => s.customerId === "a" && s.direction === "outbound"
    )) {
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      for (let h = 0; h < result.simulationLog.length; h++) {
        const tonnes = cargoTonnesInSimulationHour(
          h,
          simStartMs,
          cargoStartMs,
          cargoEndMs,
          slot.volume
        );
        if (tonnes <= 0) continue;
        const prevB =
          result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.b ?? 40_000;
        const curB = result.simulationLog[h]?.customerInventories?.b ?? 40_000;
        expect(curB).toBeLessThan(prevB);
      }
    }
  });

  it("shared_inventory: booking customer floor −x blocks outbound when attributed stock would breach", () => {
    const baseCustomers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Stockholder",
        currentInventory: 50_000,
        storageShare: 50,
        pipelineFlowPerHour: 0,
        inboundMEPS: 0,
        outboundMEPS: 0,
        outboundMode: "ship",
        declaredInboundThroughput: 0
      }),
      makeCustomer({
        id: "c2",
        name: "Shipper",
        currentInventory: 5_000,
        storageShare: 50,
        pipelineFlowPerHour: 0,
        inboundMEPS: 0,
        outboundMEPS: 10_000,
        outboundMode: "ship",
        declaredInboundThroughput: 500_000
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      }
    ];
    const withX0 = runScheduler(
      baseCustomers,
      resources,
      makeConfig({
        storageMode: "shared_inventory",
        totalStorageCapacity: 100_000,
        pipelineDirection: "outbound",
        sharedInventoryCustomerDeficitLimitTonnes: 0
      })
    );
    expect(
      withX0.scheduledSlots.filter((s) => s.direction === "outbound" && s.customerId === "c2")
    ).toHaveLength(5);

    const withX1k = runScheduler(
      baseCustomers,
      resources,
      makeConfig({
        storageMode: "shared_inventory",
        totalStorageCapacity: 100_000,
        pipelineDirection: "outbound",
        sharedInventoryCustomerDeficitLimitTonnes: 1_000
      })
    );
    expect(
      withX1k.scheduledSlots.filter((s) => s.direction === "outbound" && s.customerId === "c2")
    ).toHaveLength(0);

    const c2Series = withX0.inventoryTimeline.get("c2") ?? [];
    expect(c2Series.some((v) => v < 0)).toBe(true);
  });

  it("simulation log shows tank_full for inbound leg when another customer schedules outbound same hour (shared_inventory)", () => {
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: 100_000
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "ineos",
        name: "Ineos",
        declaredInboundThroughput: 50_000,
        currentInventory: 45_000,
        storageShare: 50,
        inboundMEPS: 5000,
        inboundMode: "ship"
      }),
      makeCustomer({
        id: "alpha",
        name: "Alpha",
        declaredInboundThroughput: 500,
        currentInventory: 55_000,
        storageShare: 50,
        outboundMEPS: 5000,
        outboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);

    const hasIneosInboundTankFull = result.simulationLog.some((row) =>
      row.transportStatus.some(
        (t) =>
          t.customerId === "ineos" &&
          t.direction === "inbound" &&
          t.action === "idle" &&
          t.blockingConstraint === "tank_full"
      )
    );
    expect(hasIneosInboundTankFull).toBe(true);
    expect(result.scheduledSlots.some((s) => s.customerId === "alpha" && s.direction === "outbound")).toBe(
      true
    );
  });

  it("simulation log shows annual_target_met when customer inbound ship target is fulfilled", () => {
    const config = makeConfig({
      storageMode: "shared_inventory",
      totalStorageCapacity: 100_000
    });
    const customers: Customer[] = [
      makeCustomer({
        id: "ineos",
        name: "Ineos",
        declaredInboundThroughput: 30_000,
        currentInventory: 0,
        storageShare: 100,
        inboundMEPS: 30_000,
        inboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      }
    ];

    const result = runScheduler(customers, resources, config);
    expect(result.scheduledSlots.filter((s) => s.customerId === "ineos" && s.direction === "inbound")).toHaveLength(
      1
    );

    const lastRow = result.simulationLog[result.simulationLog.length - 1]!;
    const status = lastRow.transportStatus.find(
      (t) => t.customerId === "ineos" && t.direction === "inbound" && t.mode === "ship"
    );
    expect(status?.action).toBe("idle");
    expect(status?.blockingConstraint).toBe("annual_target_met");
  });

  it("creates separate lanes for same mode when outbound transports are split", () => {
    const config = makeConfig();
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Customer 1",
        declaredInboundThroughput: 4000,
        currentInventory: 8000,
        outboundTransports: [
          { mode: "ship", sharePct: 50, meps: 1000, roundtripHours: 0 },
          { mode: "ship", sharePct: 50, meps: 1000, roundtripHours: 0 }
        ],
        outboundMEPS: 1000,
        outboundMode: "ship"
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const result = runScheduler(customers, resources, config);
    expect(result.scheduledSlots).toHaveLength(4);
    const legKeys = new Set(result.scheduledSlots.map((s) => s.legKey));
    expect(legKeys.size).toBe(2);
    const laneStatusKeys = new Set(
      result.simulationLog.flatMap((r) => r.transportStatus.map((s) => s.legKey).filter(Boolean))
    );
    expect(laneStatusKeys.size).toBeGreaterThanOrEqual(2);
  });

  it("schedules all customers on a shared transport pool (fixed_band)", () => {
    const trainPool = {
      id: "pool-train",
      name: "Train pool",
      mode: "train" as const,
      roundtripHours: 12,
      meps: 1000,
      inventoryAllocation: "attributed" as const
    };
    const customers: Customer[] = ["a", "b", "c", "d"].map((id) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 5000,
        currentInventory: 2000,
        storageShare: 25,
        inboundTransports: [
          { mode: "train", sharePct: 100, meps: 1000, roundtripHours: 12, poolId: "pool-train" }
        ]
      })
    );
    const resources: Resource[] = [
      {
        id: "rail-1",
        name: "Rail 1",
        type: "rail_siding",
        flowRate: 200,
        blackouts: []
      }
    ];
    const result = runScheduler(customers, resources, makeConfig(), [trainPool]);
    const inboundByCustomer = new Map<string, number>();
    for (const s of result.scheduledSlots) {
      if (s.direction === "inbound" && s.mode === "train") {
        inboundByCustomer.set(s.customerId, (inboundByCustomer.get(s.customerId) ?? 0) + 1);
      }
    }
    for (const c of customers) {
      expect(inboundByCustomer.get(c.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it("proportional ship pool: independent roundtrip per customer", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ship fleet",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const customers: Customer[] = ["a", "b", "c", "d"].map((id) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 8000,
        currentInventory: 2000,
        storageShare: 25,
        inboundTransports: [
          { mode: "ship", sharePct: 100, meps: 2000, roundtripHours: 48, poolId: "pool-ship" }
        ]
      })
    );
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth 1",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const result = runScheduler(customers, resources, makeConfig(), [shipPool]);
    const firstStartByCustomer = new Map<string, number>();
    for (const s of result.scheduledSlots) {
      if (s.direction !== "inbound") continue;
      const t = new Date(s.start).getTime();
      const prev = firstStartByCustomer.get(s.customerId);
      if (prev === undefined || t < prev) firstStartByCustomer.set(s.customerId, t);
    }
    expect(firstStartByCustomer.size).toBe(4);
    const firstStarts = [...firstStartByCustomer.values()].sort((a, b) => a - b);
    const gapHours = (firstStarts[3]! - firstStarts[0]!) / (60 * 60 * 1000);
    expect(gapHours).toBeLessThan(48 * 3);
  });

  it("schedules each inbound transport mode for one customer (fixed_band)", () => {
    const customers: Customer[] = [
      makeCustomer({
        id: "c1",
        name: "Multi-mode",
        declaredInboundThroughput: 8000,
        currentInventory: 1000,
        storageShare: 100,
        inboundTransports: [
          { mode: "ship", sharePct: 25, meps: 1500, roundtripHours: 48 },
          { mode: "barge", sharePct: 25, meps: 800, roundtripHours: 24 },
          { mode: "train", sharePct: 25, meps: 900, roundtripHours: 12 },
          { mode: "barge", sharePct: 25, meps: 700, roundtripHours: 18 }
        ]
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Large berth",
        type: "berth_large",
        flowRate: 200,
        blackouts: []
      },
      {
        id: "berth-2",
        name: "Small berth",
        type: "berth_small",
        flowRate: 150,
        blackouts: []
      },
      {
        id: "rail-1",
        name: "Rail siding",
        type: "rail_siding",
        flowRate: 180,
        blackouts: []
      }
    ];
    const result = runScheduler(customers, resources, makeConfig());
    const byLegKey = new Map<string, number>();
    for (const s of result.scheduledSlots) {
      if (s.direction === "inbound" && s.legKey) {
        byLegKey.set(s.legKey, (byLegKey.get(s.legKey) ?? 0) + 1);
      }
    }
    const inboundModes = new Set(
      result.scheduledSlots.filter((s) => s.direction === "inbound").map((s) => s.mode)
    );
    expect(inboundModes.has("ship")).toBe(true);
    expect(inboundModes.has("train")).toBe(true);
    expect(inboundModes.has("barge")).toBe(true);
    expect((byLegKey.get("inbound-barge-1") ?? 0) + (byLegKey.get("inbound-barge-2") ?? 0)).toBeGreaterThan(0);
  });

  it("pool members with equal inventory split berth flows equally", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inv: number) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 6000,
        currentInventory: inv,
        storageShare: 25,
        outboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            poolId: "pool-ship"
          }
        ]
      });
    const customers = [mk("a", 10000), mk("b", 10000)];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig();
    const result = runScheduler(customers, resources, config, [shipPool]);
    const simStartMs = new Date(config.startDate).getTime();
    const { preOps, postOps } = laytimeFromConfig(config);

    for (const slot of result.scheduledSlots.filter(
      (s) => s.customerId === "a" && s.direction === "outbound"
    )) {
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      for (let h = 0; h < result.simulationLog.length; h++) {
        const tonnes = cargoTonnesInSimulationHour(
          h,
          simStartMs,
          cargoStartMs,
          cargoEndMs,
          slot.volume
        );
        if (tonnes <= 0) continue;
        const prevA =
          result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.a ?? 10000;
        const prevB =
          result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.b ?? 10000;
        const curA = result.simulationLog[h]?.customerInventories?.a ?? 10000;
        const curB = result.simulationLog[h]?.customerInventories?.b ?? 10000;
        expect(Math.abs(prevA - curA)).toBeCloseTo(Math.abs(prevB - curB), 0);
      }
    }
  });

  it("proportional pool outbound load draws from all pool members", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, share: number) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 0,
        currentInventory: 10000,
        storageShare: share,
        outboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            poolId: "pool-ship"
          }
        ]
      });
    const customers = [mk("a", 50), mk("b", 50)];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig();
    const result = runScheduler(customers, resources, config, [shipPool]);
    const simStartMs = new Date(config.startDate).getTime();
    const { preOps, postOps } = laytimeFromConfig(config);

    for (const slot of result.scheduledSlots.filter(
      (s) => s.customerId === "a" && s.direction === "outbound"
    )) {
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      for (let h = 0; h < result.simulationLog.length; h++) {
        const tonnes = cargoTonnesInSimulationHour(
          h,
          simStartMs,
          cargoStartMs,
          cargoEndMs,
          slot.volume
        );
        if (tonnes <= 0) continue;
        const prevB =
          result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.b ?? 10000;
        const curB = result.simulationLog[h]?.customerInventories?.b ?? 10000;
        expect(curB).toBeLessThan(prevB);
      }
    }
  });

  it("opt-out customer unchanged when another customer's pool slot loads", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inPool: boolean, share: number) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 8000,
        currentInventory: 2000,
        storageShare: share,
        inboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            ...(inPool ? { poolId: "pool-ship" } : {})
          }
        ]
      });
    const poolMembers = [mk("a", true, 40), mk("b", true, 30), mk("c", true, 20)];
    const basfOut = [...poolMembers, mk("d", false, 10)];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig();
    const result = runScheduler(basfOut, resources, config, [shipPool]);
    const simStartMs = new Date(config.startDate).getTime();
    const { preOps, postOps } = laytimeFromConfig(config);
    const openingD = 2000;

    for (const slot of result.scheduledSlots.filter(
      (s) => s.customerId === "a" && s.direction === "inbound"
    )) {
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      for (let h = 0; h < result.simulationLog.length; h++) {
        const tonnes = cargoTonnesInSimulationHour(
          h,
          simStartMs,
          cargoStartMs,
          cargoEndMs,
          slot.volume
        );
        if (tonnes <= 0) continue;
        const prevD =
          result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.d ?? openingD;
        const curD = result.simulationLog[h]?.customerInventories?.d ?? openingD;
        expect(curD).toBe(prevD);
      }
    }
  });

  it("opt-out customer gets 100% private attribution; pool members split pro-rata", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inPool: boolean, share: number) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 8000,
        currentInventory: 2000,
        storageShare: share,
        inboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            ...(inPool ? { poolId: "pool-ship" } : {})
          }
        ]
      });
    const allIn = [mk("a", true, 40), mk("b", true, 30), mk("c", true, 20), mk("d", true, 10)];
    const dOut = [mk("a", true, 40), mk("b", true, 30), mk("c", true, 20), mk("d", false, 10)];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig();
    const fullPool = runScheduler(allIn, resources, config, [shipPool]);
    const dOptOut = runScheduler(dOut, resources, config, [shipPool]);

    const dFull = fullPool.inventoryTimeline.get("d") ?? [];
    const dOutSeries = dOptOut.inventoryTimeline.get("d") ?? [];
    expect(dFull.some((v, h) => v !== (dOutSeries[h] ?? 0))).toBe(true);
  });

  it("replay after opt-out updates inventory attribution without re-booking slots", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inPool: boolean) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 6000,
        currentInventory: 2500,
        storageShare: 25,
        inboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            ...(inPool ? { poolId: "pool-ship" } : {})
          }
        ]
      });
    const allIn = ["a", "b", "c", "d"].map((id) => mk(id, true));
    const dOut = ["a", "b", "c", "d"].map((id) => mk(id, id !== "d"));
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig();
    const baseline = runScheduler(allIn, resources, config, [shipPool]);
    const replayed = replaySimulation(dOut, resources, config, baseline.scheduledSlots, [shipPool]);

    expect(replayed.scheduledSlots.map((s) => s.id).sort().join(",")).toBe(
      baseline.scheduledSlots.map((s) => s.id).sort().join(",")
    );

    const hour = 60;
    expect(replayed.inventoryTimeline.get("d")?.[hour] ?? 0).toBeLessThan(
      baseline.inventoryTimeline.get("d")?.[hour] ?? 0
    );
  });

  it("shared_shipping with proportional transport pool: opted-out customer gets no pool share", () => {
    const shipPool = {
      id: "pool-ship",
      name: "Ships",
      mode: "ship" as const,
      roundtripHours: 48,
      meps: 2000,
      inventoryAllocation: "proportional" as const
    };
    const mk = (id: string, inPool: boolean) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 6000,
        currentInventory: 2000,
        storageShare: 25,
        inboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps: 2000,
            roundtripHours: 48,
            ...(inPool ? { poolId: "pool-ship" } : {})
          }
        ]
      });
    const allIn = ["a", "b", "c", "d"].map((id) => mk(id, true));
    const basfOut = ["a", "b", "c", "d"].map((id) => mk(id, id !== "d"));
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 500,
        blackouts: []
      }
    ];
    const config = makeConfig({ storageMode: "shared_shipping" });
    const fullPool = runScheduler(allIn, resources, config, [shipPool]);
    const basfOptOut = runScheduler(basfOut, resources, config, [shipPool]);

    const hour = 60;
    expect(basfOptOut.inventoryTimeline.get("d")?.[hour] ?? 0).toBeLessThan(
      fullPool.inventoryTimeline.get("d")?.[hour] ?? 0
    );
  });

  it("pool-only member shares inventory without booking outbound slots", () => {
    const shipClub = { id: "club-ship", name: "Ship club" };
    const mkShip = (id: string, inv: number, meps: number, poolId: string | null) =>
      makeCustomer({
        id,
        name: id.toUpperCase(),
        declaredInboundThroughput: 500_000,
        currentInventory: inv,
        storageShare: 50,
        outboundMEPS: meps,
        outboundMode: "ship",
        outboundTransports: [
          {
            mode: "ship",
            sharePct: 100,
            meps,
            roundtripHours: 48,
            poolId
          }
        ]
      });
    const withPoolOnly = [
      mkShip("a", 60_000, 10_000, "club-ship"),
      makeCustomer({
        id: "b",
        name: "B",
        declaredInboundThroughput: 0,
        currentInventory: 40_000,
        storageShare: 50,
        outboundMEPS: 0,
        outboundTransports: [
          { mode: "pool", sharePct: 0, meps: 0, roundtripHours: 0, poolId: "club-ship" }
        ]
      })
    ];
    const resources: Resource[] = [
      {
        id: "berth-1",
        name: "Berth",
        type: "berth_large",
        flowRate: 2000,
        blackouts: []
      }
    ];
    const config = makeConfig({ storageMode: "shared_inventory", totalStorageCapacity: 200_000 });
    const result = runScheduler(withPoolOnly, resources, config, [shipClub]);
    expect(result.scheduledSlots.some((s) => s.direction === "outbound")).toBe(true);
    expect(result.scheduledSlots.every((s) => s.customerId === "a")).toBe(true);
    const simStartMs = new Date(config.startDate).getTime();
    const { preOps, postOps } = laytimeFromConfig(config);
    let bMoved = false;
    for (const slot of result.scheduledSlots.filter((s) => s.direction === "outbound")) {
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      for (let h = 0; h < result.simulationLog.length; h++) {
        const tonnes = cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, slot.volume);
        if (tonnes <= 0) continue;
        const prevB = result.simulationLog[h > 0 ? h - 1 : 0]?.customerInventories?.b ?? 40_000;
        const curB = result.simulationLog[h]?.customerInventories?.b ?? 40_000;
        if (curB < prevB) bMoved = true;
      }
    }
    expect(bMoved).toBe(true);
  });
});
