import { describe, expect, it } from "vitest";
import type { Customer, SimulationConfig } from "../types";
import {
  initGradeInventoryLedger,
  maxOutboundTonnesWithinGradeFloor,
  outboundBreachesGradeFloor,
  sharedInventoryFloorBlocks,
  summarizeGradeLedgerTimeline,
  computeQuarterlyAttributedGradeStock
} from "./gradeInventoryLedger";

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    name: "Test",
    currentInventory: 10_000,
    storageShare: 50,
    pipelineFlowPerHour: 0,
    declaredInboundThroughput: 100_000,
    inboundMEPS: 5000,
    inboundMode: "ship",
    inboundRoundtripHours: 0,
    outboundMEPS: 5000,
    outboundMode: "ship",
    outboundRoundtripHours: 48,
    timeSharedMinBand: 0,
    timeSharedDuration: 24,
    gradeGreenPct: 60,
    gradeBluePct: 40,
    gradeGreyPct: 0,
    ...overrides
  };
}

function makeConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    startDate: new Date("2025-01-01"),
    endDate: new Date("2025-12-31"),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100_000,
    storageMode: "shared_inventory",
    sharedInventoryCustomerDeficitLimitTonnes: 1000,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000,
    ...overrides
  };
}

describe("initGradeInventoryLedger", () => {
  it("splits opening stock by grade shares", () => {
    const c = makeCustomer({ currentInventory: 10_000 });
    const ledger = initGradeInventoryLedger([c]);
    expect(ledger.c1!.green).toBeCloseTo(6000, 0);
    expect(ledger.c1!.blue).toBeCloseTo(4000, 0);
  });
});

describe("per-grade outbound floor", () => {
  it("blocks when green balance would breach apportioned floor", () => {
    const customer = makeCustomer({ currentInventory: 5000 });
    const ledger = initGradeInventoryLedger([customer]);
    const config = makeConfig({ sharedInventoryCustomerDeficitLimitTonnes: 500 });
    const res = outboundBreachesGradeFloor(customer, 7000, ledger, config, [customer]);
    expect(res.blocked).toBe(true);
  });

  it("allows parcel within green headroom + floor", () => {
    const customer = makeCustomer({ currentInventory: 10_000 });
    const ledger = initGradeInventoryLedger([customer]);
    const config = makeConfig({ sharedInventoryCustomerDeficitLimitTonnes: 1000 });
    const res = outboundBreachesGradeFloor(customer, 2000, ledger, config, [customer]);
    expect(res.blocked).toBe(false);
  });

  it("same_grade scope allows borrow when donor has surplus", () => {
    const donor = makeCustomer({
      id: "donor",
      name: "Donor",
      currentInventory: 20_000,
      gradeGreenPct: 100,
      gradeBluePct: 0,
      gradeGreyPct: 0
    });
    const borrower = makeCustomer({
      id: "borrower",
      name: "Borrower",
      currentInventory: 1000,
      gradeGreenPct: 100,
      gradeBluePct: 0,
      gradeGreyPct: 0
    });
    const ledger = initGradeInventoryLedger([donor, borrower]);
    const config = makeConfig({
      sharedInventoryCustomerDeficitLimitTonnes: 100,
      borrowingGradeScope: "same_grade"
    });
    const max = maxOutboundTonnesWithinGradeFloor(
      borrower,
      5000,
      ledger,
      config,
      [donor, borrower]
    );
    expect(max).toBeGreaterThan(1000);
  });

  it("sharedInventoryFloorBlocks falls back to total when no grade mix", () => {
    const customer = makeCustomer({
      gradeGreenPct: 0,
      gradeBluePct: 0,
      gradeGreyPct: 0,
      currentInventory: 500
    });
    const ledger = initGradeInventoryLedger([customer]);
    const config = makeConfig({ sharedInventoryCustomerDeficitLimitTonnes: 100 });
    const res = sharedInventoryFloorBlocks(customer, 700, 500, ledger, config, [customer]);
    expect(res.blocked).toBe(true);
  });
});

describe("grade ledger analytics", () => {
  it("summarizeGradeLedgerTimeline reports min and headroom", () => {
    const customer = makeCustomer({ currentInventory: 10_000 });
    const gradeTimeline = {
      [customer.id]: {
        green: [6000, 5500, 5000],
        blue: [4000, 4000, 4000],
        grey: [0, 0, 0]
      }
    };
    const config = makeConfig({ sharedInventoryCustomerDeficitLimitTonnes: 500 });
    const rows = summarizeGradeLedgerTimeline([customer], config, gradeTimeline);
    const green = rows.find((r) => r.grade === "green");
    expect(green?.min).toBe(5000);
    expect(green?.floorLimit).toBeCloseTo(300, 0);
    expect(green?.minHeadroom).toBeCloseTo(5300, 0);
  });

  it("computeQuarterlyAttributedGradeStock reads simulation log snapshots", () => {
    const customer = makeCustomer();
    const config = makeConfig({
      startDate: new Date("2025-01-01"),
      endDate: new Date("2025-06-30")
    });
    const log = [
      {
        hour: 0,
        datetime: "2025-01-01T00:00:00.000Z",
        customerInventories: { c1: 10_000 },
        customerGradeInventories: {
          c1: { green: 6000, blue: 4000, grey: 0 }
        },
        terminalTotal: 10_000,
        pipelineFlow: {},
        transportStatus: []
      },
      {
        hour: 100,
        datetime: "2025-01-05T04:00:00.000Z",
        customerInventories: { c1: 8000 },
        customerGradeInventories: {
          c1: { green: 4800, blue: 3200, grey: 0 }
        },
        terminalTotal: 8000,
        pipelineFlow: {},
        transportStatus: []
      }
    ];
    const rows = computeQuarterlyAttributedGradeStock([customer], config, log);
    expect(rows.some((r) => r.grade === "green" && r.quarterLabel === "2025 Q1")).toBe(true);
    const q1Green = rows.find((r) => r.grade === "green" && r.quarterLabel === "2025 Q1");
    expect(q1Green?.terminalStockTonnes).toBe(4800);
  });
});
