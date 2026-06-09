import { describe, expect, it } from "vitest";
import type { Customer, SimulationConfig } from "../types";
import {
  resolveCustomerPipelineRates,
  totalInboundPipelineTph,
  totalOutboundPipelineTph
} from "./pipelineFlows";
import { outboundThroughputTonnes, outboundTargetSlots } from "./customerLegTargets";

function cfg(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  const t0 = new Date("2025-01-01T00:00:00Z");
  const t1 = new Date("2025-01-08T00:00:00Z");
  return {
    startDate: t0,
    endDate: t1,
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100_000,
    storageMode: "fixed_band",
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 0,
    tankCapacity: 0,
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    ...overrides
  };
}

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    name: "A",
    declaredInboundThroughput: 10_000,
    currentInventory: 20_000,
    storageShare: 100,
    pipelineFlowPerHour: 0,
    inboundMEPS: 5000,
    inboundMode: "ship",
    outboundMEPS: 2000,
    outboundMode: "barge",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    ...overrides
  };
}

describe("resolveCustomerPipelineRates", () => {
  it("uses explicit inbound and outbound columns when set", () => {
    const c = customer({
      pipelineFlowPerHour: 50,
      pipelineInboundPerHour: 100,
      pipelineOutboundPerHour: 50
    });
    const rates = resolveCustomerPipelineRates(c, cfg());
    expect(rates.inboundTph).toBe(100);
    expect(rates.outboundTph).toBe(50);
    expect(rates.netTph).toBe(50);
  });

  it("falls back to signed net for legacy negative outbound-only", () => {
    const c = customer({ pipelineFlowPerHour: -40 });
    const rates = resolveCustomerPipelineRates(c, cfg());
    expect(rates.inboundTph).toBe(0);
    expect(rates.outboundTph).toBe(40);
    expect(rates.netTph).toBe(-40);
  });

  it("does not treat zero explicit columns as authoritative over legacy net", () => {
    const c = customer({
      pipelineFlowPerHour: 46,
      pipelineInboundPerHour: 0,
      pipelineOutboundPerHour: 0
    });
    const rates = resolveCustomerPipelineRates(c, cfg({ pipelineDirection: "inbound" }));
    expect(rates.inboundTph).toBe(46);
    expect(rates.outboundTph).toBe(0);
  });
});

describe("outbound scheduling with outbound pipeline", () => {
  it("includes outbound pipeline in outbound throughput when explicit columns set", () => {
    const config = cfg({ pipelineDirection: "inbound" });
    const c = customer({
      pipelineInboundPerHour: 0,
      pipelineOutboundPerHour: 50,
      pipelineFlowPerHour: -50,
      outboundMEPS: 1000,
      outboundRoundtripHours: 24
    });
    const periodHours = 24 * 7;
    const outboundT = outboundThroughputTonnes(c, config, periodHours);
    expect(outboundT).toBe(10_000 - 50 * periodHours);
    expect(outboundTargetSlots(c, config, periodHours)).toBeGreaterThan(0);
  });

  it("sums terminal outbound pipeline across customers", () => {
    const config = cfg();
    const customers = [
      customer({ id: "c1", pipelineInboundPerHour: 10, pipelineOutboundPerHour: 30 }),
      customer({ id: "c2", pipelineInboundPerHour: 5, pipelineOutboundPerHour: 20 })
    ];
    expect(totalOutboundPipelineTph(customers, config)).toBe(50);
    expect(totalInboundPipelineTph(customers, config)).toBe(15);
  });
});
