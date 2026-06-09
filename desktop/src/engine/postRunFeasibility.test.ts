import { describe, expect, it } from "vitest";
import type { Customer, SimulationConfig } from "../types";
import {
  isSeriesTrendingUnstable,
  runPostRunFeasibilityChecks
} from "./postRunFeasibility";
import type { SimulationLogRow, TransportModeStatus } from "./simulationLog";

function testConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    startDate: new Date("2025-01-01T00:00:00Z"),
    endDate: new Date("2025-01-08T00:00:00Z"),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 10_000,
    storageMode: "shared_inventory",
    sharedInventoryCustomerDeficitLimitTonnes: 500,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000,
    ...overrides
  };
}

const baseConfig = testConfig();

const baseCustomer = {
  id: "c1",
  name: "Alpha",
  pipelineFlowPerHour: 100
} as Customer;

function makeLog(rows: Partial<SimulationLogRow>[]): SimulationLogRow[] {
  return rows.map((r, hour) => ({
    hour,
    datetime: new Date(hour * 3_600_000).toISOString(),
    terminalTotal: 0,
    customerInventories: {},
    pipelineFlow: {},
    averageCustomerDaysOfCover: null,
    combinedTerminalDaysOfCover: null,
    transportStatus: [],
    ...r
  }));
}

describe("isSeriesTrendingUnstable", () => {
  it("returns false for flat series", () => {
    expect(isSeriesTrendingUnstable(Array(100).fill(5000), 10_000)).toBe(false);
  });

  it("returns true for steadily increasing series", () => {
    const series = Array.from({ length: 100 }, (_, i) => 1000 + i * 50);
    expect(isSeriesTrendingUnstable(series, 10_000)).toBe(true);
  });
});

describe("runPostRunFeasibilityChecks", () => {
  it("warns when pipeline interrupted more than 1% of hours", () => {
    const log = makeLog(
      Array.from({ length: 100 }, (_, hour) => ({
        hour,
        terminalTotal: hour < 5 ? 10_000 : 5000
      }))
    );
    const warnings = runPostRunFeasibilityChecks([baseCustomer], baseConfig, log);
    expect(warnings.some((w) => w.includes("Pipeline was interrupted"))).toBe(true);
  });

  it("does not warn when pipeline interrupted at or below 1%", () => {
    const log = makeLog(
      Array.from({ length: 100 }, (_, hour) => ({
        hour,
        terminalTotal: hour === 0 ? 10_000 : 5000
      }))
    );
    const warnings = runPostRunFeasibilityChecks([baseCustomer], baseConfig, log);
    expect(warnings.some((w) => w.includes("Pipeline was interrupted"))).toBe(false);
  });

  it("warns when borrowing limit reached more than 1% of hours", () => {
    const log = makeLog(
      Array.from({ length: 100 }, (_, hour) => ({
        hour,
        customerInventories: { c1: hour < 3 ? -500 : 0 },
        transportStatus:
          hour < 3
            ? ([
                {
                  customerId: "c1",
                  customerName: "Alpha",
                  mode: "ship",
                  direction: "outbound",
                  action: "idle",
                  blockingConstraint: "customer_inventory_floor",
                  constraintDetail: ""
                }
              ] as TransportModeStatus[])
            : []
      }))
    );
    const warnings = runPostRunFeasibilityChecks([baseCustomer], baseConfig, log);
    expect(warnings.some((w) => w.includes("borrowing limit"))).toBe(true);
  });

  it("warns when customer inventory trends over the period", () => {
    const log = makeLog(
      Array.from({ length: 100 }, (_, hour) => ({
        hour,
        customerInventories: { c1: hour * 100 }
      }))
    );
    const warnings = runPostRunFeasibilityChecks([baseCustomer], baseConfig, log);
    expect(warnings.some((w) => w.includes("Alpha") && w.includes("inventory"))).toBe(true);
  });
});
