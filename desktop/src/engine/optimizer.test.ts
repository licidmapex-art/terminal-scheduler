import { describe, it, expect } from "vitest";
import type { Customer, SimulationConfig } from "../types";
import type { SchedulingLeg } from "./feasibility";
import {
  averageCustomerDaysOfCoverAtHour,
  averagePoolFulfillmentRatioAtHour,
  combinedTerminalDaysOfCoverAtHour,
  compareSchedulingLegs,
  relativeFulfillmentOptimizerShouldYield,
  relativeOptimizerShouldYield
} from "./optimizer";

function makeLeg(
  customer: Customer,
  direction: "inbound" | "outbound",
  targetSlots: number,
  slotsScheduled = 0
): { leg: SchedulingLeg; slotsScheduled: number } {
  return {
    leg: {
      customer,
      direction,
      mode: "ship",
      laneKey: `${direction}-ship-1`,
      meps: 150,
      targetSlots,
      roundtripHours: 0
    },
    slotsScheduled
  };
}

describe("compareSchedulingLegs", () => {
  const alpha: Customer = {
    id: "c-a",
    name: "Alpha",
    declaredInboundThroughput: 600,
    currentInventory: 0,
    storageShare: 50,
    pipelineFlowPerHour: 0,
    inboundMEPS: 150,
    inboundMode: "ship",
    outboundMEPS: 0,
    outboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24
  };
  const beta: Customer = {
    ...alpha,
    id: "c-b",
    name: "Beta"
  };

  it("prefers the customer further behind their target in shared shipping", () => {
    const { leg: legA, slotsScheduled: slotsA } = makeLeg(alpha, "inbound", 4, 2);
    const { leg: legB, slotsScheduled: slotsB } = makeLeg(beta, "inbound", 4, 0);
    const cmp = compareSchedulingLegs(
      legB,
      legA,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      true,
      slotsB,
      slotsA
    );
    expect(cmp).toBeLessThan(0);
  });

  it("prefers the customer further behind their target in shared inventory inbound pool", () => {
    const { leg: legA, slotsScheduled: slotsA } = makeLeg(alpha, "inbound", 4, 2);
    const { leg: legB, slotsScheduled: slotsB } = makeLeg(beta, "inbound", 4, 0);
    const cmp = compareSchedulingLegs(
      legB,
      legA,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      false,
      slotsB,
      slotsA,
      true
    );
    expect(cmp).toBeLessThan(0);
  });
});

function makeConfig(overrides?: Partial<SimulationConfig>): SimulationConfig {
  return {
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-02-01T00:00:00.000Z"),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 10000,
    storageMode: "shared_shipping",
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000,
    pacerRoundAtDecile: 1,
    optimizerRelativeDocMultiplier: 0,
    ...overrides
  };
}

describe("terminal days of cover", () => {
  const config = makeConfig();

  const alpha: Customer = {
    id: "c-a",
    name: "Alpha",
    declaredInboundThroughput: 0,
    currentInventory: 6000,
    storageShare: 60,
    pipelineFlowPerHour: 0,
    inboundMEPS: 0,
    inboundMode: "ship",
    outboundMEPS: 300,
    outboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24
  };
  const beta: Customer = {
    ...alpha,
    id: "c-b",
    name: "Beta",
    currentInventory: 4000,
    storageShare: 40,
    outboundMEPS: 100
  };

  const legs: SchedulingLeg[] = [
    {
      customer: alpha,
      direction: "outbound",
      mode: "ship",
      laneKey: "out-ship-1",
      meps: 300,
      targetSlots: 4,
      roundtripHours: 0
    },
    {
      customer: beta,
      direction: "outbound",
      mode: "ship",
      laneKey: "out-ship-1",
      meps: 100,
      targetSlots: 4,
      roundtripHours: 0
    }
  ];

  it("combined DoC uses terminal inventory over summed pressure", () => {
    const invById = { "c-a": 6000, "c-b": 4000 };
    const combined = combinedTerminalDaysOfCoverAtHour(
      [alpha, beta],
      legs,
      config,
      744,
      invById,
      10000,
      true
    );
    const average = averageCustomerDaysOfCoverAtHour(
      [alpha, beta],
      legs,
      config,
      744,
      invById,
      10000,
      true
    );
    expect(combined).not.toBeNull();
    expect(average).not.toBeNull();
    expect(combined).not.toBeCloseTo(average!, 1);
  });
});

describe("relativeFulfillmentOptimizerShouldYield", () => {
  it("disabled when multiplier is 0", () => {
    expect(relativeFulfillmentOptimizerShouldYield(0.8, 0.4, 0)).toBe(false);
  });

  it("yields when leg fulfilment exceeds multiplier times pool average", () => {
    expect(relativeFulfillmentOptimizerShouldYield(0.5, 0.25, 1)).toBe(true);
    expect(relativeFulfillmentOptimizerShouldYield(0.36, 0.25, 1.4)).toBe(true);
  });

  it("does not yield when at or below threshold", () => {
    expect(relativeFulfillmentOptimizerShouldYield(0.25, 0.25, 1)).toBe(false);
    expect(relativeFulfillmentOptimizerShouldYield(0.2, 0.25, 1)).toBe(false);
    expect(relativeFulfillmentOptimizerShouldYield(0.34, 0.25, 1.4)).toBe(false);
  });
});

describe("averagePoolFulfillmentRatioAtHour", () => {
  it("averages fulfilment ratios for legs in the same direction+mode pool", () => {
    const simStart = new Date("2026-01-01T00:00:00.000Z").getTime();
    const customerA: Customer = {
      id: "c-a",
      name: "Alpha",
      declaredInboundThroughput: 600,
      currentInventory: 0,
      storageShare: 50,
      pipelineFlowPerHour: 0,
      inboundMEPS: 150,
      inboundMode: "ship",
      outboundMEPS: 0,
      outboundMode: "ship",
      inboundRoundtripHours: 0,
      outboundRoundtripHours: 0,
      timeSharedMinBand: 0,
      timeSharedDuration: 24
    };
    const customerB: Customer = { ...customerA, id: "c-b", name: "Beta" };
    const legs: SchedulingLeg[] = [
      {
        customer: customerA,
        direction: "inbound",
        mode: "ship",
        laneKey: "in-ship-1",
        meps: 150,
        targetSlots: 4,
        roundtripHours: 0
      },
      {
        customer: customerB,
        direction: "inbound",
        mode: "ship",
        laneKey: "in-ship-1",
        meps: 150,
        targetSlots: 4,
        roundtripHours: 0
      }
    ];
    const assignedSlots = [
      {
        id: "s1",
        customerId: "c-a",
        resourceId: "r1",
        direction: "inbound" as const,
        mode: "ship" as const,
        legKey: "in-ship-1",
        volume: 150,
        start: new Date(simStart),
        end: new Date(simStart + 3600000),
        status: "scheduled" as const,
        conflictReason: null
      }
    ];
    const avg = averagePoolFulfillmentRatioAtHour(
      legs[0]!,
      legs,
      assignedSlots,
      simStart,
      1,
      false,
      true
    );
    expect(avg).toBeCloseTo(0.125, 5);
  });
});

describe("relativeOptimizerShouldYield", () => {
  it("disabled when multiplier is 0", () => {
    expect(relativeOptimizerShouldYield(10, 5, 0)).toBe(false);
  });

  it("yields when leg DoC exceeds multiplier times average", () => {
    expect(relativeOptimizerShouldYield(20, 10, 1)).toBe(true);
    expect(relativeOptimizerShouldYield(15, 10, 1.4)).toBe(true);
  });

  it("does not yield when at or below threshold", () => {
    expect(relativeOptimizerShouldYield(10, 10, 1)).toBe(false);
    expect(relativeOptimizerShouldYield(9, 10, 1)).toBe(false);
    expect(relativeOptimizerShouldYield(14, 10, 1.5)).toBe(false);
  });
});
