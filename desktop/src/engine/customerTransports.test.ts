import { describe, it, expect } from "vitest";
import {
  assignRoundtripBarLanes,
  mepsForScheduledSlot,
  roundtripCooldownStartHour,
  roundtripHoursForScheduledSlot,
  roundtripLaneKeyForSlot
} from "./customerTransports";
import type { Customer, ScheduledSlot } from "../types";

const HOUR_MS = 3600_000;

const multiLegCustomer = (): Customer => ({
  id: "al",
  name: "Air Liquide",
  currentInventory: 0,
  storageShare: 50,
  pipelineFlowPerHour: 0,
  declaredInboundThroughput: 10000,
  inboundMEPS: 1000,
  inboundMode: "ship",
  inboundRoundtripHours: 99,
  outboundMEPS: 0,
  outboundMode: "barge",
  outboundRoundtripHours: 88,
  timeSharedMinBand: 0,
  timeSharedDuration: 24,
  inboundTransports: [
    { mode: "ship", sharePct: 50, meps: 1000, roundtripHours: 12 },
    { mode: "barge", sharePct: 50, meps: 500, roundtripHours: 36 }
  ]
});

describe("mepsForScheduledSlot", () => {
  it("uses transport-leg MEPS from legKey, not legacy primary inboundMEPS", () => {
    const customer = multiLegCustomer();
    const slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey"> = {
      direction: "inbound",
      mode: "barge",
      legKey: "inbound-barge-2"
    };
    expect(mepsForScheduledSlot(customer, slot)).toBe(500);
  });
});

describe("roundtripHoursForScheduledSlot", () => {
  it("uses transport-leg roundtrip hours from legKey, not legacy customer inboundRoundtripHours", () => {
    const customer = multiLegCustomer();
    const slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey"> = {
      direction: "inbound",
      mode: "barge",
      legKey: "inbound-barge-2"
    };
    expect(roundtripHoursForScheduledSlot(customer, slot)).toBe(36);
  });
});

describe("roundtripCooldownStartHour", () => {
  it("anchors at slot start hour (pre-ops), matching scheduler round-trip window", () => {
    const simStartMs = Date.UTC(2025, 0, 1);
    const slot = { start: new Date(simStartMs + 10.4 * HOUR_MS) };
    expect(roundtripCooldownStartHour(slot, simStartMs)).toBe(10);
  });
});

describe("roundtripLaneKeyForSlot", () => {
  it("prefixes scheduler leg keys with customer id", () => {
    const customer = multiLegCustomer();
    expect(
      roundtripLaneKeyForSlot(customer, {
        direction: "inbound",
        mode: "barge",
        legKey: "inbound-barge-2"
      })
    ).toBe("al:inbound-barge-2");
  });

  it("disambiguates missing legKey when two inbound modes differ", () => {
    const customer = multiLegCustomer();
    expect(
      roundtripLaneKeyForSlot(customer, {
        direction: "inbound",
        mode: "ship",
        legKey: null
      })
    ).toBe("al:inbound-ship-1");
    expect(
      roundtripLaneKeyForSlot(customer, {
        direction: "inbound",
        mode: "barge",
        legKey: null
      })
    ).toBe("al:inbound-barge-2");
  });
});

describe("assignRoundtripBarLanes", () => {
  it("puts different legs on separate lanes", () => {
    const assigned = assignRoundtripBarLanes([
      { legKey: "a:inbound-ship-1", anchorStartMs: 0, hours: 10 },
      { legKey: "a:inbound-barge-2", anchorStartMs: 0, hours: 20 }
    ]);
    expect(assigned.map((e) => e.lane)).toEqual([0, 1]);
  });

  it("stacks overlapping windows for the same leg", () => {
    const assigned = assignRoundtripBarLanes([
      { legKey: "a:inbound-ship-1", anchorStartMs: 0, hours: 50 },
      { legKey: "a:inbound-ship-1", anchorStartMs: 10, hours: 50 }
    ]);
    expect(assigned.map((e) => e.lane)).toEqual([0, 1]);
  });
});
