import { describe, expect, it } from "vitest";
import type { Customer, SimulationConfig } from "../types";
import {
  inboundThroughputTonnes,
  outboundRoundtripCapacityTonnes
} from "./customerLegTargets";
import { runFeasibilityChecks } from "./feasibility";

function baseCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    name: "Alpha",
    currentInventory: 0,
    storageShare: 100,
    pipelineFlowPerHour: 0,
    declaredInboundThroughput: 10_000,
    inboundMEPS: 2500,
    inboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundMEPS: 2000,
    outboundMode: "ship",
    outboundRoundtripHours: 50,
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
    totalStorageCapacity: 100_000,
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

describe("outboundRoundtripCapacityTonnes", () => {
  it("computes floor(period / roundtrip) × MEPS per lane", () => {
    const periodHours = 100;
    const c = baseCustomer({ outboundMEPS: 1500, outboundRoundtripHours: 40 });
    expect(outboundRoundtripCapacityTonnes(c, periodHours)).toBe(
      Math.floor(100 / 40) * 1500
    );
  });

  it("sums capacity across outbound lanes", () => {
    const periodHours = 72;
    const c = baseCustomer({
      outboundTransports: [
        { mode: "ship", sharePct: 50, meps: 2000, roundtripHours: 18 },
        { mode: "train", sharePct: 50, meps: 1000, roundtripHours: 24 }
      ]
    });
    expect(outboundRoundtripCapacityTonnes(c, periodHours)).toBe(
      Math.floor(72 / 18) * 2000 + Math.floor(72 / 24) * 1000
    );
  });
});

describe("runFeasibilityChecks outbound vs inbound capacity", () => {
  it("warns when outbound roundtrip capacity is below 110% of inbound throughput", () => {
    const periodHours = 100;
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date(start.getTime() + periodHours * 60 * 60 * 1000);
    const config = cfg({ startDate: start, endDate: end });
    const customer = baseCustomer({
      declaredInboundThroughput: 10_000,
      outboundMEPS: 2000,
      outboundRoundtripHours: 50
    });
    const outboundCap = Math.floor(periodHours / 50) * 2000;
    expect(outboundCap).toBeLessThan(1.1 * 10_000);

    const warnings = runFeasibilityChecks([customer], [], [], config);
    expect(
      warnings.some((w) => w.includes("outbound loading/unloading capacity") && w.includes("110%"))
    ).toBe(true);
  });

  it("does not warn when outbound capacity meets 110% of inbound throughput", () => {
    const periodHours = 200;
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date(start.getTime() + periodHours * 60 * 60 * 1000);
    const config = cfg({ startDate: start, endDate: end });
    const customer = baseCustomer({
      declaredInboundThroughput: 10_000,
      outboundMEPS: 3000,
      outboundRoundtripHours: 40
    });
    const outboundCap = Math.floor(periodHours / 40) * 3000;
    expect(outboundCap).toBeGreaterThanOrEqual(1.1 * 10_000);

    const warnings = runFeasibilityChecks([customer], [], [], config);
    expect(warnings.some((w) => w.includes("outbound loading/unloading capacity"))).toBe(false);
  });

  it("includes inbound pipeline in throughput comparison", () => {
    const periodHours = 100;
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date(start.getTime() + periodHours * 60 * 60 * 1000);
    const config = cfg({ startDate: start, endDate: end, pipelineDirection: "inbound" });
    const customer = baseCustomer({
      declaredInboundThroughput: 5000,
      pipelineFlowPerHour: 50,
      outboundMEPS: 2000,
      outboundRoundtripHours: 50
    });
    const inbound = inboundThroughputTonnes(customer, config, periodHours);
    expect(inbound).toBe(10_000);

    const warnings = runFeasibilityChecks([customer], [], [], config);
    expect(warnings.some((w) => w.includes("outbound loading/unloading capacity"))).toBe(true);
  });
});
