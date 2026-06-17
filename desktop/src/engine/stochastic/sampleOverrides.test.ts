import { describe, expect, it } from "vitest";
import type { ScheduledSlot } from "../../types";
import { sampleSimulationOverrides } from "./sampleOverrides";

const HOUR_MS = 60 * 60 * 1000;

function slot(id: string, customerId: string): ScheduledSlot {
  const start = new Date("2025-01-02T00:00:00Z");
  const end = new Date(start.getTime() + 4 * HOUR_MS);
  return {
    id,
    customerId,
    resourceId: "r1",
    direction: "inbound",
    mode: "ship",
    volume: 1000,
    start,
    end,
    reservationStart: null,
    reservationEnd: null,
    legKey: null,
    status: "scheduled",
    conflictReason: null
  };
}

const config = {
  startDate: new Date("2025-01-01T00:00:00Z"),
  endDate: new Date("2025-01-08T00:00:00Z"),
  pipelineFlowRate: 0,
  pipelineDirection: "inbound" as const,
  totalStorageCapacity: 100_000,
  storageMode: "fixed_band" as const,
  sharedInventoryCustomerDeficitLimitTonnes: 0,
  minSlotIntervalHours: 0,
  preOpsHours: 0,
  postOpsHours: 0,
  tankCount: 4,
  tankCapacity: 7000
};

describe("sampleSimulationOverrides leg delay probability", () => {
  const slots = [slot("s1", "c1"), slot("s2", "c1"), slot("s3", "c1"), slot("s4", "c1")];
  const customers = [
    {
      id: "c1",
      name: "C1",
      declaredInboundThroughput: 1000,
      currentInventory: 5000,
      storageShare: 100,
      pipelineFlowPerHour: 0,
      inboundMEPS: 500,
      inboundMode: "ship" as const,
      inboundRoundtripHours: 0,
      outboundMEPS: 0,
      outboundMode: "ship" as const,
      outboundRoundtripHours: 0,
      timeSharedMinBand: 0,
      timeSharedDuration: 24
    }
  ];

  it("probability 0 → no slot adjustments", () => {
    const result = sampleSimulationOverrides(
      slots,
      customers,
      config,
      {
        enabled: true,
        seed: 99,
        legDelays: [
          {
            customerId: "c1",
            direction: "inbound",
            delayProbability: 0,
            delayHours: { kind: "fixed", value: 5 }
          }
        ],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: { events: [] }
      },
      99
    );
    expect(result.overrides.slotAdjustments).toHaveLength(0);
  });

  it("probability 1 → all matching slots delayed", () => {
    const result = sampleSimulationOverrides(
      slots,
      customers,
      config,
      {
        enabled: true,
        seed: 99,
        legDelays: [
          {
            customerId: "c1",
            direction: "inbound",
            delayProbability: 1,
            delayHours: { kind: "fixed", value: 5 }
          }
        ],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: { events: [] }
      },
      99
    );
    expect(result.overrides.slotAdjustments).toHaveLength(4);
  });

  it("probability 0.5 → some but not all slots delayed (fixed seed)", () => {
    const result = sampleSimulationOverrides(
      slots,
      customers,
      config,
      {
        enabled: true,
        seed: 12345,
        legDelays: [
          {
            customerId: "c1",
            direction: "inbound",
            delayProbability: 0.5,
            delayHours: { kind: "fixed", value: 5 }
          }
        ],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: { events: [] }
      },
      12345
    );
    const n = result.overrides.slotAdjustments.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(4);
  });
});

describe("sampleSimulationOverrides disruption events", () => {
  const customers = [
    {
      id: "c1",
      name: "C1",
      declaredInboundThroughput: 1000,
      currentInventory: 5000,
      storageShare: 100,
      pipelineFlowPerHour: 50,
      inboundMEPS: 500,
      inboundMode: "ship" as const,
      inboundRoundtripHours: 0,
      outboundMEPS: 0,
      outboundMode: "ship" as const,
      outboundRoundtripHours: 0,
      timeSharedMinBand: 0,
      timeSharedDuration: 24
    }
  ];

  it("pipeline event P=0 → no pipeline stop events", () => {
    const result = sampleSimulationOverrides(
      [],
      customers,
      config,
      {
        enabled: true,
        seed: 42,
        legDelays: [],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: {
          events: [
            {
              kind: "pipeline",
              occurrenceProbability: 0,
              durationHours: { kind: "fixed", value: 8 },
              startHourMin: 0,
              startHourMax: 24,
              impact: { kind: "full_stop" }
            }
          ]
        }
      },
      42
    );
    expect(result.events.filter((e) => e.kind === "pipeline_stop")).toHaveLength(0);
  });

  it("pipeline event P=1 → pipeline stop window", () => {
    const result = sampleSimulationOverrides(
      [],
      customers,
      config,
      {
        enabled: true,
        seed: 42,
        legDelays: [],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: {
          events: [
            {
              kind: "pipeline",
              occurrenceProbability: 1,
              durationHours: { kind: "fixed", value: 4 },
              startHourMin: 0,
              startHourMax: 4,
              impact: { kind: "full_stop" }
            }
          ]
        }
      },
      42
    );
    const stops = result.events.filter((e) => e.kind === "pipeline_stop");
    expect(stops.length).toBeGreaterThan(0);
    expect(Object.values(result.overrides.pipelineMultiplierByHour).some((row) => row.c1 === 0)).toBe(
      true
    );
  });

  it("terminal event P=1 → immobilisation window", () => {
    const result = sampleSimulationOverrides(
      [],
      customers,
      config,
      {
        enabled: true,
        seed: 42,
        legDelays: [],
        pipeline: { flowMultiplier: { kind: "fixed", value: 1 } },
        immobilisation: {
          events: [
            {
              kind: "terminal",
              occurrenceProbability: 1,
              durationHours: { kind: "fixed", value: 6 },
              startHourMin: 0,
              startHourMax: 4,
              impact: { kind: "full_stop" }
            }
          ]
        }
      },
      42
    );
    expect(result.overrides.immobilisationWindows).toHaveLength(1);
    expect(result.events.some((e) => e.kind === "immobilisation")).toBe(true);
  });
});
