import { describe, expect, it } from "vitest";
import { computeSlotTweaks, slotsEqual } from "./simulationRunState";
import type { ScheduledSlot } from "../types";

function slot(id: string, volume: number): ScheduledSlot {
  const t = new Date("2025-06-01T00:00:00.000Z");
  const end = new Date("2025-06-03T00:00:00.000Z");
  return {
    id,
    customerId: "c1",
    resourceId: "b1",
    direction: "inbound",
    mode: "ship",
    legKey: null,
    volume,
    start: t,
    end,
    reservationStart: null,
    reservationEnd: null,
    status: "scheduled",
    conflictReason: null
  };
}

describe("computeSlotTweaks", () => {
  it("flags added and modified slots vs baseline", () => {
    const baseline = [slot("a", 5000), slot("b", 3000)];
    const current = [slot("a", 5000), slot("b", 2000), slot("c", 1000)];
    expect(computeSlotTweaks(current, baseline)).toEqual({
      b: "modified",
      c: "added"
    });
    expect(slotsEqual(current, baseline)).toBe(false);
  });

  it("returns empty when baseline is missing", () => {
    expect(computeSlotTweaks([slot("a", 1)], null)).toEqual({});
  });
});
