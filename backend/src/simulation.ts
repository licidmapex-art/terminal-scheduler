/**
 * Simulation engine – minimal stub.
 * Replace with ticker-based scheduling. See docs/ALGORITHM.md for spec.
 */

import { TerminalStateForScheduling } from "./scheduler";
import { addHours } from "./domain";

export type Unit = "m3" | "tons";

export interface CustomerFlowConfig {
  desiredThroughputPerHour: number;
  pipelineRatePerHour: number;
  transportMode: "ship" | "barge" | "pipeline" | "train" | "none";
  transportUnitSize: number;
  loadRatePerHour: number;
}

export interface CustomerConfig {
  id: string;
  name: string;
  initialInventory: number;
  inbound: CustomerFlowConfig;
  outbound: CustomerFlowConfig;
}

export type SlotAllocationRule = "highest_inventory" | "lowest_inventory" | "round_robin";
export type SlotAllocationRuleConflict = "round_robin" | "inbound_first" | "outbound_first";

export type StorageEntitlement =
  | { type: "none" }
  | { type: "fixed"; maxAmount: number }
  | { type: "allowance_decreasing"; startAmount: number; decreaseOverDays: number };

export interface TerminalSimulationConfig {
  periodStart: Date;
  periodEnd: Date;
  unit: Unit;
  terminalCapacity: number;
  borrowingEnabled: boolean;
  productId: string;
  customers: CustomerConfig[];
  fullParcelPercent?: number;
  minHoursBetweenSlots?: number;
  minHoursBetweenSlotsScope?: "all" | "per_mode";
  minSpacingHoursPerCustomer?: number;
  slotAllocationRuleInbound?: SlotAllocationRule;
  slotAllocationRuleOutbound?: SlotAllocationRule;
  slotAllocationRuleConflict?: SlotAllocationRuleConflict;
  slotAllocationRule?: SlotAllocationRule;
  customerStorageEntitlement?: Record<string, StorageEntitlement>;
  terminalStorageEntitlement?: StorageEntitlement;
}

export interface InventorySeriesPoint {
  at: string;
  value: number;
}

export interface InjectionSeriesPoint {
  at: string;
  pipelineInbound: number;
  pipelineOutbound: number;
  transportInbound: number;
  transportOutbound: number;
  customerInbound?: Record<string, number>;
  customerOutbound?: Record<string, number>;
}

export interface HourlySchedulingDiagnostic {
  hour: number;
  at: string;
  terminalInv: number;
  customerInv: Record<string, number>;
  eligible: string[];
  slotTriggered: boolean;
  assignedCustomer: string | null;
  loadedUnits: number;
  testResult: string;
}

export interface ScheduleSummaryPerCustomer {
  inbound: Array<{ mode: "ship" | "barge" | "pipeline" | "train"; count: number; volume: number }>;
  outbound: Array<{ mode: "ship" | "barge" | "pipeline" | "train"; count: number; volume: number }>;
}

export interface SimulationResult {
  requestsGenerated: number;
  schedule: {
    events: unknown[];
    unscheduledRequestIds: string[];
    unscheduled?: unknown[];
  };
  scheduleSummary?: Record<string, ScheduleSummaryPerCustomer>;
  inventory: {
    terminal: InventorySeriesPoint[];
    customers: Record<string, InventorySeriesPoint[]>;
  };
  injection: InjectionSeriesPoint[];
  violations: Array<{ at: string; scope: "terminal" | "customer"; id?: string; message: string }>;
  errorReport?: Array<{ likelyIssue: string; details?: string }>;
  hourlySchedulingDiagnostic?: HourlySchedulingDiagnostic[];
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (60 * 60 * 1000);
}

/**
 * Run the terminal simulation.
 * Stub: returns empty schedule and flat inventory series. Implement ticker-based scheduling.
 */
export function runSimulation(
  _terminalState: TerminalStateForScheduling,
  cfg: TerminalSimulationConfig
): SimulationResult {
  const periodHours = Math.max(0, hoursBetween(cfg.periodStart, cfg.periodEnd));

  const terminalSeries: InventorySeriesPoint[] = [];
  const customersSeries: Record<string, InventorySeriesPoint[]> = {};
  const injectionSeries: InjectionSeriesPoint[] = [];

  for (const c of cfg.customers) {
    customersSeries[c.id] = [];
  }

  let totalInv = 0;
  for (const c of cfg.customers) {
    totalInv += c.initialInventory ?? 0;
  }

  for (let h = 0; h <= Math.ceil(periodHours); h++) {
    const t = addHours(cfg.periodStart, h);
    if (t.getTime() > cfg.periodEnd.getTime()) break;

    terminalSeries.push({ at: t.toISOString(), value: totalInv });
    for (const c of cfg.customers) {
      const inv = c.initialInventory ?? 0;
      customersSeries[c.id].push({ at: t.toISOString(), value: inv });
    }
    injectionSeries.push({
      at: t.toISOString(),
      pipelineInbound: 0,
      pipelineOutbound: 0,
      transportInbound: 0,
      transportOutbound: 0,
      customerInbound: Object.fromEntries(cfg.customers.map((c) => [c.id, 0])),
      customerOutbound: Object.fromEntries(cfg.customers.map((c) => [c.id, 0]))
    });
  }

  const scheduleSummary: Record<string, ScheduleSummaryPerCustomer> = {};
  for (const c of cfg.customers) {
    scheduleSummary[c.id] = { inbound: [], outbound: [] };
  }

  const hourlySchedulingDiagnostic: HourlySchedulingDiagnostic[] = [];
  for (let h = 0; h < terminalSeries.length; h++) {
    const t = addHours(cfg.periodStart, h);
    const customerInv: Record<string, number> = {};
    for (const c of cfg.customers) {
      customerInv[c.id] = customersSeries[c.id]?.[h]?.value ?? 0;
    }
    hourlySchedulingDiagnostic.push({
      hour: h,
      at: t.toISOString(),
      terminalInv: terminalSeries[h]?.value ?? 0,
      customerInv,
      eligible: [],
      slotTriggered: false,
      assignedCustomer: null,
      loadedUnits: 0,
      testResult: "Engine stub – implement runSimulation"
    });
  }

  return {
    requestsGenerated: 0,
    schedule: {
      events: [],
      unscheduledRequestIds: [],
      unscheduled: []
    },
    scheduleSummary,
    inventory: {
      terminal: terminalSeries,
      customers: customersSeries
    },
    injection: injectionSeries,
    violations: [],
    hourlySchedulingDiagnostic
  };
}
