import { describe, expect, it } from "vitest";
import {
  defaultLegKey,
  defaultModeForResource,
  occupationEndFromVolume,
  snapMsToHour,
  volumeFromOccupation
} from "./manualSlot";
import type { Resource, SimulationConfig } from "../types";

const simStart = new Date("2025-01-01T00:00:00.000Z");

const config: SimulationConfig = {
  startDate: simStart,
  endDate: new Date("2026-01-01T00:00:00.000Z"),
  pipelineFlowRate: 0,
  pipelineDirection: "inbound",
  totalStorageCapacity: 100000,
  storageMode: "fixed_band",
  sharedInventoryCustomerDeficitLimitTonnes: 0,
  preOpsHours: 2,
  postOpsHours: 2,
  minSlotIntervalHours: 0,
  tankCount: 4,
  tankCapacity: 7000
};

function resource(id: string, name: string, type: Resource["type"]): Resource {
  return { id, name, type, flowRate: 500, blackouts: [] };
}

describe("manualSlot helpers", () => {
  it("maps resource types to default transport modes", () => {
    expect(defaultModeForResource(resource("b1", "Berth", "berth_large"))).toBe("ship");
    expect(defaultModeForResource(resource("b2", "Small", "berth_small"))).toBe("barge");
    expect(defaultModeForResource(resource("r1", "Rail", "rail_siding"))).toBe("train");
  });

  it("snaps timestamps to simulation hour grid", () => {
    const simStartMs = simStart.getTime();
    const ms = simStartMs + 90 * 60 * 1000;
    expect(snapMsToHour(ms, simStartMs)).toBe(simStartMs + 2 * 60 * 60 * 1000);
  });

  it("derives volume from occupation wall time and MEPS", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = new Date("2025-01-01T07:00:00.000Z");
    expect(volumeFromOccupation(start, end, 500, config)).toBe(1500);
  });

  it("derives occupation end from volume", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = occupationEndFromVolume(start, 1000, 500, config);
    expect(end.getTime() - start.getTime()).toBe(6 * 60 * 60 * 1000);
  });

  it("yields partial cargo when wall time is shorter than a full MEPS load", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = new Date("2025-01-01T05:00:00.000Z");
    const flowRateTph = 500;
    const meps = 5000;
    const volume = volumeFromOccupation(start, end, flowRateTph, config);
    expect(volume).toBe(500);
    expect(volume).toBeLessThan(meps);
  });

  it("builds default leg keys", () => {
    expect(defaultLegKey("c1", "inbound", "ship", 1)).toBe("c1:inbound:ship:lane1");
  });
});
