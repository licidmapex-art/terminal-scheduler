import { describe, it, expect } from "vitest";
import { buildCustomerThroughputOverview } from "./customerThroughputOverview";
import type { Customer, SimulationConfig } from "../../types";

function baseConfig(overrides?: Partial<SimulationConfig>): SimulationConfig {
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

function baseCustomer(overrides?: Partial<Customer>): Customer {
  return {
    id: "c1",
    name: "Test",
    declaredInboundThroughput: 1000,
    currentInventory: 0,
    storageShare: 50,
    pipelineFlowPerHour: 10,
    inboundMEPS: 500,
    inboundMode: "ship",
    outboundMEPS: 500,
    outboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    ...overrides
  };
}

describe("buildCustomerThroughputOverview", () => {
  it("includes inbound pipeline in calculated outbound", () => {
    const config = baseConfig({ pipelineDirection: "inbound" });
    const customer = baseCustomer({
      declaredInboundThroughput: 1000,
      pipelineFlowPerHour: 10,
      inboundTransports: [{ mode: "ship", sharePct: 100, meps: 500, roundtripHours: 0 }],
      outboundTransports: [{ mode: "ship", sharePct: 100, meps: 500, roundtripHours: 0 }]
    });
    const overview = buildCustomerThroughputOverview(customer, config);
    const windowTonnes = 10 * 24 * 7;
    expect(overview.inboundPipelineTonnes).toBe(windowTonnes);
    expect(overview.calculatedOutboundTonnes).toBe(1000 + windowTonnes);
    expect(overview.outboundModes[0]?.tonnes).toBe(1000 + windowTonnes);
  });

  it("subtracts outbound pipeline from calculated outbound", () => {
    const config = baseConfig({ pipelineDirection: "outbound" });
    const customer = baseCustomer({
      declaredInboundThroughput: 5000,
      pipelineFlowPerHour: 5
    });
    const overview = buildCustomerThroughputOverview(customer, config);
    const windowTonnes = 5 * 24 * 7;
    expect(overview.outboundPipelineTonnes).toBe(windowTonnes);
    expect(overview.calculatedOutboundTonnes).toBe(5000 - windowTonnes);
  });

  it("uses explicit outbound pipeline regardless of terminal direction", () => {
    const periodHours = 8760;
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date(start.getTime() + periodHours * 60 * 60 * 1000);
    const config = baseConfig({ startDate: start, endDate: end, pipelineDirection: "inbound" });
    const customer = baseCustomer({
      pipelineFlowPerHour: -46,
      pipelineInboundPerHour: 0,
      pipelineOutboundPerHour: 46
    });
    const overview = buildCustomerThroughputOverview(customer, config);
    expect(overview.inboundPipelineTonnes).toBe(0);
    expect(overview.outboundPipelineTonnes).toBe(46 * periodHours);
    expect(overview.outboundPipelineRatePerHour).toBe(46);
  });

  it("falls back to legacy net when explicit columns are zero", () => {
    const config = baseConfig({ pipelineDirection: "inbound" });
    const customer = baseCustomer({
      pipelineFlowPerHour: 1,
      pipelineInboundPerHour: 0,
      pipelineOutboundPerHour: 0
    });
    const overview = buildCustomerThroughputOverview(customer, config);
    expect(overview.inboundPipelineTonnes).toBe(1 * 24 * 7);
    expect(overview.outboundPipelineTonnes).toBe(0);
  });

  it("includes expected slot counts per transport leg", () => {
    const config = baseConfig();
    const customer = baseCustomer({
      declaredInboundThroughput: 10_000,
      inboundMEPS: 2500,
      inboundRoundtripHours: 0,
      outboundMEPS: 5000,
      outboundRoundtripHours: 0
    });
    const overview = buildCustomerThroughputOverview(customer, config);
    expect(overview.inboundModes[0]?.targetSlots).toBe(4);
    expect(overview.outboundModes[0]?.targetSlots).toBeGreaterThan(0);
  });
});
