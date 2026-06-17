import { describe, it, expect } from "vitest";
import {
  slotBerthOccupationHours,
  cargoTonnesInSimulationHour,
  getCargoWindowMs,
  HOUR_MS
} from "./slotLaytime";
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

describe("cargoTonnesInSimulationHour", () => {
  it("sums to parcel volume across misaligned hour buckets", () => {
    const simStartMs = Date.parse("2025-01-01T00:00:00.000Z");
    const slot: Pick<ScheduledSlot, "start" | "end"> = {
      start: new Date(simStartMs + 0.5 * HOUR_MS),
      end: new Date(simStartMs + 4.5 * HOUR_MS)
    };
    const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, 0, 0);
    const volume = 1000;
    let total = 0;
    for (let h = 0; h <= 10; h++) {
      total += cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, volume);
    }
    expect(total).toBeCloseTo(volume, 5);
  });
});
