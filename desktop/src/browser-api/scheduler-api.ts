/**
 * Browser-compatible implementation of window.schedulerAPI.
 * Calls the engine directly (pure TypeScript, no Electron IPC).
 */

import { runScheduler } from "../engine/scheduler";
import type { SimulationConfig, ScheduledSlot } from "../types";
import type { SimulationLogRow } from "../engine/simulationLog";
import { buildSimulationWorkbook } from "../engine/simulationExcelExport";
import * as XLSX from "xlsx";
import { _store } from "./db-api";

// ── Last-run state (mirrors main/index.ts module-level vars) ──────────────────

let lastSlots: ScheduledSlot[] = [];
let lastInventoryTimeline: Record<string, number[]> = {};
let lastSimulationConfig: SimulationConfig | null = null;
let lastSimulationLog: SimulationLogRow[] = [];
let lastFeasibilityWarnings: string[] = [];

function serializeSlot(slot: ScheduledSlot) {
  return {
    ...slot,
    start: slot.start instanceof Date ? slot.start.toISOString() : slot.start,
    end: slot.end instanceof Date ? slot.end.toISOString() : slot.end
  };
}

function resolveConfig(): SimulationConfig {
  const configs = _store.simulationConfigs;
  return configs[0]
    ? {
        startDate: configs[0].startDate instanceof Date ? configs[0].startDate : new Date(configs[0].startDate as unknown as string),
        endDate: configs[0].endDate instanceof Date ? configs[0].endDate : new Date(configs[0].endDate as unknown as string),
        pipelineFlowRate: configs[0].pipelineFlowRate,
        pipelineDirection: configs[0].pipelineDirection,
        totalStorageCapacity: configs[0].totalStorageCapacity ?? 100000,
        storageMode: configs[0].storageMode ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: configs[0].sharedInventoryCustomerDeficitLimitTonnes ?? 0,
        pacerRoundingDirection: configs[0].pacerRoundingDirection ?? "up",
        pacerRoundAtDecile: configs[0].pacerRoundAtDecile ?? 1,
        optimizerRelativeDocMultiplier: configs[0].optimizerRelativeDocMultiplier ?? 0,
        optimizerRelativeFulfillmentMultiplier: configs[0].optimizerRelativeFulfillmentMultiplier ?? 0,
        minSlotIntervalHours: configs[0].minSlotIntervalHours ?? 0,
        preOpsHours: configs[0].preOpsHours ?? 0,
        postOpsHours: configs[0].postOpsHours ?? 0,
        tankCount: configs[0].tankCount ?? 4,
        tankCapacity: configs[0].tankCapacity ?? 7000
      }
    : {
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        pipelineFlowRate: 0,
        pipelineDirection: "inbound" as const,
        totalStorageCapacity: 100000,
        storageMode: "fixed_band" as const,
        sharedInventoryCustomerDeficitLimitTonnes: 0,
        pacerRoundingDirection: "up" as const,
        pacerRoundAtDecile: 1,
        optimizerRelativeDocMultiplier: 0,
        optimizerRelativeFulfillmentMultiplier: 0,
        minSlotIntervalHours: 0,
        preOpsHours: 0,
        postOpsHours: 0,
        tankCount: 4,
        tankCapacity: 7000
      };
}

export const browserSchedulerApi = {
  run: (): Promise<{
    scheduledSlots: ReturnType<typeof serializeSlot>[];
    feasibilityWarnings: string[];
    inventoryTimeline: Record<string, number[]>;
  }> => {
    const customers = _store.customers;
    const resources = _store.resources.map((r) => ({
      ...r,
      blackouts: r.blackouts.map((b) => ({
        ...b,
        start: b.start instanceof Date ? b.start : new Date(b.start as unknown as string),
        end: b.end instanceof Date ? b.end : new Date(b.end as unknown as string)
      }))
    }));

    if (customers.length === 0 || resources.length === 0) {
      lastSimulationLog = [];
      lastFeasibilityWarnings = ["Add customers and resources before running the scheduler"];
      lastSlots = [];
      return Promise.resolve({
        scheduledSlots: [],
        feasibilityWarnings: lastFeasibilityWarnings,
        inventoryTimeline: {}
      });
    }

    const config = resolveConfig();
    const result = runScheduler(customers, resources, config);

    lastSlots = result.scheduledSlots;
    lastInventoryTimeline = Object.fromEntries(result.inventoryTimeline);
    lastSimulationConfig = config;
    lastSimulationLog = result.simulationLog;
    lastFeasibilityWarnings = [...result.feasibilityWarnings];

    return Promise.resolve({
      scheduledSlots: result.scheduledSlots.map(serializeSlot),
      feasibilityWarnings: result.feasibilityWarnings,
      inventoryTimeline: lastInventoryTimeline
    });
  },

  getSlots: (): Promise<ReturnType<typeof serializeSlot>[]> =>
    Promise.resolve(lastSlots.map(serializeSlot)),

  getSimulationLog: (): Promise<SimulationLogRow[]> =>
    Promise.resolve(lastSimulationLog),

  getFeasibilityWarnings: (): Promise<string[]> =>
    Promise.resolve(lastFeasibilityWarnings),

  getInventoryTimeline: (): Promise<{
    timeline: Record<string, number[]>;
    startDate: string | null;
    totalStorageCapacity?: number | null;
  } | null> => {
    if (!lastInventoryTimeline || Object.keys(lastInventoryTimeline).length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      timeline: lastInventoryTimeline,
      startDate: lastSimulationConfig?.startDate instanceof Date
        ? lastSimulationConfig.startDate.toISOString()
        : null,
      totalStorageCapacity: lastSimulationConfig?.totalStorageCapacity ?? null
    });
  },

  exportSimulationExcel: (): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    if (lastSimulationLog.length === 0) {
      return Promise.resolve({ ok: false, error: "Run the simulation first to build the log." });
    }
    try {
      const config = lastSimulationConfig ?? resolveConfig();
      const wb = buildSimulationWorkbook(lastSimulationLog, lastSlots, config, _store.customers);
      const uint8 = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
      const blob = new Blob([uint8], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "simulation-export.xlsx";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      return Promise.resolve({ ok: true, path: "simulation-export.xlsx" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Promise.resolve({ ok: false, error: msg });
    }
  }
};

/** Expose last run state for the Save button to include in snapshots. */
export function getLastRunState() {
  return { lastSlots, lastSimulationLog, lastFeasibilityWarnings, lastInventoryTimeline };
}
