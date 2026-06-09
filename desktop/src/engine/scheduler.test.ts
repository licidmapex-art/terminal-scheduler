/**
 * Unit tests for the hour-by-hour scheduling engine.
 */

import { describe, it, expect } from "vitest";
import { runScheduler } from "./scheduler";
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

    // With the corrected (no-Math.floor) pacer the +1 look-ahead buffer allows two
    // slots to be front-loaded before the continuous pace target throttles back to
    // T/N cadence.  Allow a 12h tolerance instead of the old 1h.
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

    const earlyConfig = makeConfig({ pacerRoundingDirection: "up", pacerRoundAtDecile: 1 });
    const lateConfig = makeConfig({ pacerRoundingDirection: "up", pacerRoundAtDecile: 8 });

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

  it("pacer down mode is stricter than up mode for same decile", () => {
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
    const upConfig = makeConfig({ pacerRoundingDirection: "up", pacerRoundAtDecile: 3 });
    const downConfig = makeConfig({ pacerRoundingDirection: "down", pacerRoundAtDecile: 3 });

    const up = runScheduler(customers, resources, upConfig);
    const down = runScheduler(customers, resources, downConfig);

    const secondUp = [...up.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;
    const secondDown = [...down.scheduledSlots]
      .filter((s) => s.direction === "outbound")
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[1]!;

    const upHour = (new Date(secondUp.start).getTime() - upConfig.startDate.getTime()) / 3600000;
    const downHour = (new Date(secondDown.start).getTime() - downConfig.startDate.getTime()) / 3600000;
    expect(downHour).toBeGreaterThan(upHour);
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
});
