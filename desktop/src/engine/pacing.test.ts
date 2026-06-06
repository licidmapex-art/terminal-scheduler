import { describe, it, expect } from "vitest";
import type { Customer, SimulationConfig, ScheduledSlot } from "../types";
import {
  paceAllowanceSlots,
  customerPacingPctByDirectionMode,
  formatDirectionModeLabel
} from "./pacing";

function baseConfig(overrides?: Partial<SimulationConfig>): SimulationConfig {
  const t0 = new Date(0);
  return {
    startDate: t0,
    endDate: new Date(t0.getTime() + 100 * 3_600_000),
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
    pacerRoundingDirection: "up",
    pacerRoundAtDecile: 1,
    ...overrides
  };
}

function baseCustomer(): Customer {
  return {
    id: "c1",
    name: "Test",
    declaredInboundThroughput: 10000,
    currentInventory: 0,
    storageShare: 100,
    pipelineFlowPerHour: 0,
    inboundMEPS: 1000,
    inboundMode: "ship",
    outboundMEPS: 1000,
    outboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundRoundtripHours: 0,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    inboundTransports: [{ mode: "ship", sharePct: 100, meps: 1000, roundtripHours: 0 }],
    outboundTransports: [{ mode: "ship", sharePct: 100, meps: 1000, roundtripHours: 0 }]
  };
}

describe("pacing", () => {
  it("paceAllowanceSlots matches scheduler up@0.1 rule", () => {
    const cfg = baseConfig({ pacerRoundingDirection: "up", pacerRoundAtDecile: 1 });
    expect(paceAllowanceSlots(1, cfg)).toBe(1);
    expect(paceAllowanceSlots(1.1, cfg)).toBe(2);
    expect(paceAllowanceSlots(2.0, cfg)).toBe(2);
  });

  it("formatDirectionModeLabel", () => {
    expect(formatDirectionModeLabel("outbound:barge")).toBe("outbound · barge");
  });

  it("customerPacingPctByDirectionMode splits by direction and mode", () => {
    const cfg = baseConfig();
    const customer = baseCustomer();
    const periodHours = 100;
    const simStart = new Date("2025-01-01T00:00:00Z").getTime();
    const slots: ScheduledSlot[] = [
      {
        id: "s1",
        customerId: "c1",
        resourceId: "r1",
        direction: "inbound",
        mode: "ship",
        volume: 1000,
        start: new Date(simStart),
        end: new Date(simStart + 24 * 3_600_000),
        legKey: "inbound-ship-1",
        status: "scheduled",
        conflictReason: null
      }
    ];
    const byDm = customerPacingPctByDirectionMode(customer, cfg, periodHours, slots, 50, simStart);
    expect(byDm).not.toBeNull();
    expect(byDm!["inbound:ship"]).toBeDefined();
    expect(byDm!["inbound:ship"]![0]).toBeGreaterThanOrEqual(0);
    expect(byDm!["inbound:ship"]![50]).toBeGreaterThan(0);
    expect(byDm!["inbound:ship"]![50]).toBeLessThan(150);
  });
});
