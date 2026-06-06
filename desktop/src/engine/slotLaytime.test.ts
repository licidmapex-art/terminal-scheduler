import { describe, it, expect } from "vitest";
import { slotBerthOccupationHours } from "./slotLaytime";
import type { ScheduledSlot } from "../types";

describe("slotBerthOccupationHours", () => {
  it("equals pre-ops + loading + post-ops for scheduler-shaped slots", () => {
    const start = new Date("2025-06-01T00:00:00.000Z");
    const slot: Pick<ScheduledSlot, "start" | "end"> = {
      start,
      end: new Date(start.getTime() + (2 + 3 + 1) * 3600 * 1000)
    };
    expect(
      slotBerthOccupationHours(slot, { preOpsHours: 2, postOpsHours: 1 })
    ).toBeCloseTo(6, 5);
  });

  it("falls back to wall clock when cargo window is non-positive", () => {
    const start = new Date("2025-06-01T00:00:00.000Z");
    const slot: Pick<ScheduledSlot, "start" | "end"> = {
      start,
      end: new Date(start.getTime() + 5 * 3600 * 1000)
    };
    expect(slotBerthOccupationHours(slot, { preOpsHours: 0, postOpsHours: 0 })).toBe(5);
  });
});
