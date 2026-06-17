import { describe, expect, it } from "vitest";
import type { ScheduledSlot } from "../../types";
import { applySlotTimeAdjustments, pipelineMultiplierForHour } from "./applyOverrides";

const HOUR_MS = 60 * 60 * 1000;

function slot(id: string, startHour: number): ScheduledSlot {
  const start = new Date("2025-01-01T00:00:00Z");
  start.setTime(start.getTime() + startHour * HOUR_MS);
  const end = new Date(start.getTime() + 4 * HOUR_MS);
  return {
    id,
    customerId: "c1",
    resourceId: "r1",
    direction: "inbound",
    mode: "ship",
    volume: 1000,
    start,
    end,
    reservationStart: null,
    reservationEnd: null,
    legKey: null,
    status: "scheduled",
    conflictReason: null
  };
}

describe("applySlotTimeAdjustments", () => {
  it("shifts matching slots by delta ms", () => {
    const slots = [slot("s1", 24)];
    const shifted = applySlotTimeAdjustments(slots, [
      { slotId: "s1", deltaStartMs: 2 * HOUR_MS, deltaEndMs: 2 * HOUR_MS, reason: "delay" }
    ]);
    expect(shifted[0].start.getTime() - slots[0].start.getTime()).toBe(2 * HOUR_MS);
    expect(shifted[0].end.getTime() - slots[0].end.getTime()).toBe(2 * HOUR_MS);
  });
});

describe("pipelineMultiplierForHour", () => {
  it("returns 1 when no overrides", () => {
    expect(pipelineMultiplierForHour(undefined, 5, "c1")).toBe(1);
  });

  it("returns customer multiplier for the hour", () => {
    expect(
      pipelineMultiplierForHour(
        { slotAdjustments: [], immobilisationWindows: [], pipelineMultiplierByHour: { 3: { c1: 0 } } },
        3,
        "c1"
      )
    ).toBe(0);
  });
});
