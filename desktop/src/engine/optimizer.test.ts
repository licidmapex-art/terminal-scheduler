import { describe, it, expect } from "vitest";
import type { Customer } from "../types";
import type { SchedulingLeg } from "./feasibility";
import { compareSchedulingLegs, relativeOptimizerShouldYield } from "./optimizer";

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
