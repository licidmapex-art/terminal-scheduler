import { describe, it, expect } from "vitest";
import {
  inboundTargetSlots,
  outboundTargetSlots,
  customerRepresentativeDaysOfCover,
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane
} from "./customerLegTargets";
import type { Customer, SimulationConfig } from "../types";

function baseCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    name: "A",
    currentInventory: 0,
    storageShare: 100,
    pipelineFlowPerHour: 0,
    declaredInboundThroughput: 10_000,
    inboundMEPS: 2500,
    inboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundMEPS: 0,
    outboundMode: "barge",
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    ...overrides
  };
}

function cfg(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  const start = new Date("2025-01-01T00:00:00Z");
  const end = new Date("2025-01-08T00:00:00Z");
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

describe("customerLegTargets", () => {
  it("inboundTargetSlots matches ceil(declared/meps) without roundtrip cap", () => {
    const periodHours = 168;
    const c = baseCustomer({ declaredInboundThroughput: 10_000, inboundMEPS: 3000 });
    expect(inboundTargetSlots(c, periodHours)).toBe(4);
  });

  it("inboundTargetSlots caps by roundtrip", () => {
    const periodHours = 100;
    const c = baseCustomer({
      declaredInboundThroughput: 100_000,
      inboundMEPS: 1000,
      inboundRoundtripHours: 50
    });
    expect(inboundTargetSlots(c, periodHours)).toBe(2);
  });

  it("outboundTargetSlots uses pipeline and outbound MEPS", () => {
    const periodHours = 168;
    const c = baseCustomer({
      declaredInboundThroughput: 0,
      inboundMEPS: 0,
      outboundMEPS: 500,
      pipelineFlowPerHour: 10
    });
    const config = cfg({ pipelineDirection: "inbound" });
    expect(outboundTargetSlots(c, config, periodHours)).toBe(
      Math.ceil((10 * periodHours) / 500)
    );
  });

  it("splits inbound target slots by mode shares", () => {
    const periodHours = 168;
    const c = baseCustomer({
      declaredInboundThroughput: 10_000,
      inboundTransports: [
        { mode: "ship", sharePct: 60, meps: 2000, roundtripHours: 0 },
        { mode: "barge", sharePct: 40, meps: 1000, roundtripHours: 0 }
      ]
    });
    const byLane = inboundTargetSlotsByLane(c, periodHours);
    expect(byLane).toHaveLength(2);
    expect(byLane[0]?.targetSlots).toBe(3);
    expect(byLane[1]?.targetSlots).toBe(4);
    expect(inboundTargetSlots(c, periodHours)).toBe(7);
  });

  it("splits outbound target slots by mode shares with roundtrip cap", () => {
    const periodHours = 72;
    const c = baseCustomer({
      declaredInboundThroughput: 12_000,
      outboundTransports: [
        { mode: "ship", sharePct: 50, meps: 2000, roundtripHours: 18 },
        { mode: "train", sharePct: 50, meps: 1000, roundtripHours: 24 }
      ]
    });
    const config = cfg({ pipelineDirection: "inbound" });
    const byLane = outboundTargetSlotsByLane(c, config, periodHours);
    expect(byLane).toHaveLength(2);
    expect(byLane[0]?.targetSlots).toBe(3);
    expect(byLane[1]?.targetSlots).toBe(3);
    expect(outboundTargetSlots(c, config, periodHours)).toBe(6);
  });

  it("customerRepresentativeDaysOfCover includes outbound pipeline when outbound slot target is zero (inbound ship)", () => {
    const periodHours = 168;
    const c = baseCustomer({
      declaredInboundThroughput: 8000,
      inboundMEPS: 2000,
      inboundMode: "ship",
      pipelineFlowPerHour: 50,
      outboundMEPS: 500,
      outboundMode: "barge"
    });
    const config = cfg({ pipelineDirection: "outbound", totalStorageCapacity: 100_000 });
    expect(outboundTargetSlots(c, config, periodHours)).toBe(0);
    expect(inboundTargetSlots(c, periodHours)).toBeGreaterThan(0);
    const doc = customerRepresentativeDaysOfCover(10_000, c, config, periodHours);
    expect(doc).not.toBeNull();
    expect(doc).toBeGreaterThan(0);
  });

  it("customerRepresentativeDaysOfCover uses transport when pipeline is zero (inbound ship + outbound barge)", () => {
    const periodHours = 168;
    const c = baseCustomer({
      pipelineFlowPerHour: 0,
      declaredInboundThroughput: 10_000,
      inboundMEPS: 2500,
      inboundMode: "ship",
      outboundMEPS: 500,
      outboundMode: "barge"
    });
    const config = cfg({ pipelineDirection: "inbound", totalStorageCapacity: 100_000 });
    const inv = 5000;
    const doc = customerRepresentativeDaysOfCover(inv, c, config, periodHours);
    expect(doc).not.toBeNull();
    expect(doc).toBeGreaterThan(0);
    const inSlots = inboundTargetSlots(c, periodHours);
    const outSlots = outboundTargetSlots(c, config, periodHours);
    expect(inSlots).toBeGreaterThan(0);
    expect(outSlots).toBeGreaterThan(0);
  });
});
