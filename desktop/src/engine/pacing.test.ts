import { describe, it, expect } from "vitest";
import type { Customer, SimulationConfig, ScheduledSlot } from "../types";
import {
  paceAllowanceSlots,
  pacerContinuousTarget,
  paceAllowanceForDirection,
  pacerAppliesAtBookingTime,
  pacerAppliesForLeg,
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
    pacerInboundRoundAtDecile: 1,
    pacerInboundAllowance: 0.5,
    pacerOutboundRoundAtDecile: 1,
    pacerOutboundAllowance: 0,
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
  it("paceAllowanceSlots rounds up from decile", () => {
    expect(paceAllowanceSlots(1, 1)).toBe(1);
    expect(paceAllowanceSlots(1.1, 1)).toBe(2);
    expect(paceAllowanceSlots(2.0, 1)).toBe(2);
    expect(paceAllowanceSlots(1.29, 3)).toBe(1);
    expect(paceAllowanceSlots(1.3, 3)).toBe(2);
  });

  it("negative allowance delays first allowed slot", () => {
    const cfg = baseConfig({ pacerOutboundAllowance: -0.5, pacerOutboundRoundAtDecile: 1 });
    expect(paceAllowanceForDirection(0, 100, 10, "outbound", cfg).allowance).toBe(0);
    expect(paceAllowanceForDirection(5, 100, 10, "outbound", cfg).allowance).toBe(0);
    expect(paceAllowanceForDirection(10, 100, 10, "outbound", cfg).allowance).toBe(1);
  });

  it("pacerContinuousTarget uses direction-specific allowance", () => {
    const cfg = baseConfig({ pacerInboundAllowance: 0.5, pacerOutboundAllowance: 0 });
    expect(pacerContinuousTarget(0, 100, 10, "inbound", cfg)).toBe(0.5);
    expect(pacerContinuousTarget(0, 100, 10, "outbound", cfg)).toBe(0);
    expect(pacerContinuousTarget(10, 100, 10, "inbound", cfg)).toBe(1.5);
  });

  it("paceAllowanceForDirection applies outbound decile separately", () => {
    const cfg = baseConfig({
      pacerInboundRoundAtDecile: 1,
      pacerInboundAllowance: 0.5,
      pacerOutboundRoundAtDecile: 8,
      pacerOutboundAllowance: 0
    });
    const inbound = paceAllowanceForDirection(10, 100, 10, "inbound", cfg);
    const outbound = paceAllowanceForDirection(10, 100, 10, "outbound", cfg);
    expect(inbound.allowance).toBe(2);
    expect(outbound.allowance).toBe(1);
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

  it("formatDirectionModeLabel", () => {
    expect(formatDirectionModeLabel("outbound:barge")).toBe("outbound · barge");
  });

  describe("pacerAppliesForLeg", () => {
    const cap = 100_000;
    const cfgShared = baseConfig({ storageMode: "shared_inventory", totalStorageCapacity: cap });

    it("disapplies inbound pacer at terminal tank bottom", () => {
      expect(pacerAppliesForLeg("inbound", cfgShared, 0, 0, cap)).toBe(false);
      expect(pacerAppliesForLeg("inbound", cfgShared, 1, -2500, cap)).toBe(false);
      expect(pacerAppliesForLeg("inbound", cfgShared, 500, 0, cap)).toBe(true);
    });

    it("keeps inbound pacer when only customer attributed stock is negative", () => {
      expect(pacerAppliesForLeg("inbound", cfgShared, 16_000, -2500, cap)).toBe(true);
      expect(pacerAppliesForLeg("inbound", cfgShared, 16_000, 18_000, cap)).toBe(true);
    });

    it("disapplies outbound pacer at terminal tank top", () => {
      expect(pacerAppliesForLeg("outbound", cfgShared, cap, cap, cap)).toBe(false);
      expect(pacerAppliesForLeg("outbound", cfgShared, cap - 1, 30_000, cap)).toBe(false);
      expect(pacerAppliesForLeg("outbound", cfgShared, cap - 500, 30_000, cap)).toBe(true);
    });

    it("keeps outbound pacer when only customer band is full but terminal is not", () => {
      const custMax = 50_000;
      expect(pacerAppliesForLeg("outbound", cfgShared, 60_000, custMax, custMax)).toBe(true);
      expect(pacerAppliesForLeg("outbound", cfgShared, cap, custMax, custMax)).toBe(false);
    });

    it("uses customer band for fixed_band storage", () => {
      const cfg = baseConfig({ storageMode: "fixed_band", totalStorageCapacity: 10_000 });
      expect(pacerAppliesForLeg("inbound", cfg, 0, 0, 10_000)).toBe(false);
      expect(pacerAppliesForLeg("outbound", cfg, 10_000, 10_000, 10_000)).toBe(false);
    });

    it("disapplies when any booking snapshot is at tank bottom (Nov 23 scenario)", () => {
      const cfg = baseConfig({ storageMode: "shared_inventory", totalStorageCapacity: 100_000 });
      const al: Customer = { ...baseCustomer(), id: "al", name: "AL" };
      const yara: Customer = { ...baseCustomer(), id: "yara", name: "Yara" };
      const ineos: Customer = { ...baseCustomer(), id: "ineos", name: "Ineos" };
      const customers = [al, yara, ineos];
      const hourStart = {
        al: -456,
        yara: -27_000,
        ineos: 27_500
      };
      const beforeSlots = {
        al: -500,
        yara: -27_000,
        ineos: 27_500
      };
      const snapshots = [
        { terminalRefTotal: 44, invById: hourStart },
        { terminalRefTotal: 0, invById: beforeSlots }
      ];
      expect(
        pacerAppliesAtBookingTime("inbound", cfg, al, customers, snapshots)
      ).toBe(false);
      expect(
        pacerAppliesAtBookingTime("inbound", cfg, yara, customers, snapshots)
      ).toBe(false);
      expect(
        pacerAppliesAtBookingTime("inbound", cfg, ineos, customers, snapshots)
      ).toBe(false);

      const hourStartOnly = [{ terminalRefTotal: 44, invById: hourStart }];
      expect(
        pacerAppliesAtBookingTime("inbound", cfg, al, customers, hourStartOnly)
      ).toBe(true);
      expect(
        pacerAppliesAtBookingTime("inbound", cfg, yara, customers, hourStartOnly)
      ).toBe(true);
    });
  });
});
