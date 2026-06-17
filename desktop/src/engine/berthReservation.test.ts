import { describe, expect, it } from "vitest";
import {
  computeReservationWindow,
  earliestFreeOnResourceBefore,
  slotResourceBlockInterval
} from "./berthReservation";
import type { ScheduledSlot, SimulationConfig } from "../types";

const HOUR = 60 * 60 * 1000;
const simStart = new Date("2025-01-01T00:00:00Z");
const simStartMs = simStart.getTime();

function cfg(mode: SimulationConfig["berthReservationMode"]): SimulationConfig {
  return {
    startDate: simStart,
    endDate: new Date("2025-12-31T00:00:00Z"),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100000,
    storageMode: "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 1,
    postOpsHours: 1,
    tankCount: 4,
    tankCapacity: 7000,
    berthReservationMode: mode
  };
}

describe("computeReservationWindow", () => {
  it("centers WoA when resource was free from sim start", () => {
    const opStart = new Date(simStartMs + 48 * HOUR);
    const opEnd = new Date(simStartMs + 54 * HOUR);
    const w = computeReservationWindow(
      "window_of_arrival",
      opStart,
      opEnd,
      24,
      simStartMs,
      simStartMs
    );
    expect(w).not.toBeNull();
    expect(w!.reservationStart.getTime()).toBe(simStartMs + 36 * HOUR);
    expect(w!.reservationEnd.getTime()).toBe(simStartMs + 60 * HOUR);
  });

  it("pushes WoA forward when prior block impedes retroactive start", () => {
    const opStart = new Date(simStartMs + 48 * HOUR);
    const opEnd = new Date(simStartMs + 54 * HOUR);
    const impedimentEnd = simStartMs + 40 * HOUR;
    const w = computeReservationWindow(
      "window_of_arrival",
      opStart,
      opEnd,
      24,
      impedimentEnd,
      simStartMs
    );
    expect(w!.reservationStart.getTime()).toBe(impedimentEnd);
    expect(w!.reservationEnd.getTime()).toBe(impedimentEnd + 24 * HOUR);
  });

  it("centers laycan around operation block", () => {
    const opStart = new Date(simStartMs + 50 * HOUR);
    const opEnd = new Date(simStartMs + 56 * HOUR);
    const w = computeReservationWindow("laycan", opStart, opEnd, 12, simStartMs, simStartMs);
    expect(w!.reservationStart.getTime()).toBe(simStartMs + 47 * HOUR);
    expect(w!.reservationEnd.getTime()).toBe(simStartMs + 59 * HOUR);
  });

  it("rejects laycan when operation longer than window", () => {
    const opStart = new Date(simStartMs + 10 * HOUR);
    const opEnd = new Date(simStartMs + 20 * HOUR);
    expect(computeReservationWindow("laycan", opStart, opEnd, 8, simStartMs, simStartMs)).toBeNull();
  });
});

describe("slotResourceBlockInterval", () => {
  it("WoA blocks through operation end when it extends past window", () => {
    const slot: ScheduledSlot = {
      id: "1",
      customerId: "c1",
      resourceId: "b1",
      direction: "inbound",
      mode: "ship",
      volume: 1000,
      start: new Date(simStartMs + 48 * HOUR),
      end: new Date(simStartMs + 60 * HOUR),
      reservationStart: new Date(simStartMs + 36 * HOUR),
      reservationEnd: new Date(simStartMs + 56 * HOUR),
      status: "scheduled",
      conflictReason: null
    };
    const { blockStartMs, blockEndMs } = slotResourceBlockInterval(slot, cfg("window_of_arrival"), 0);
    expect(blockStartMs).toBe(simStartMs + 36 * HOUR);
    expect(blockEndMs).toBe(simStartMs + 60 * HOUR);
  });
});

describe("earliestFreeOnResourceBefore", () => {
  it("returns latest prior block end on resource", () => {
    const prior: ScheduledSlot = {
      id: "p",
      customerId: "c2",
      resourceId: "b1",
      direction: "outbound",
      mode: "ship",
      volume: 500,
      start: new Date(simStartMs + 10 * HOUR),
      end: new Date(simStartMs + 16 * HOUR),
      reservationStart: new Date(simStartMs + 8 * HOUR),
      reservationEnd: new Date(simStartMs + 16 * HOUR),
      status: "scheduled",
      conflictReason: null
    };
    const free = earliestFreeOnResourceBefore(
      "b1",
      simStartMs + 30 * HOUR,
      [prior],
      [],
      2,
      cfg("laycan"),
      simStartMs
    );
    expect(free).toBe(simStartMs + 18 * HOUR);
  });
});
