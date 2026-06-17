/**
 * Browser-compatible implementation of window.schedulerAPI.
 * Calls the engine directly (pure TypeScript, no Electron IPC).
 */

import { runScheduler } from "../engine/scheduler";
import { replaySimulation } from "../engine/replaySimulation";
import { validateScheduledSlots } from "../engine/validateScheduledSlots";
import { finalizeManualSlot } from "../engine/manualSlot";
import type { SimulationConfig, ScheduledSlot } from "../types";
import { simulationConfigFromRow } from "../lib/simulationConfigRow";
import type { SimulationLogRow } from "../engine/simulationLog";
import { buildSimulationWorkbook } from "../engine/simulationExcelExport";
import * as XLSX from "xlsx";
import { _store } from "./db-api";
import {
  createRunStateManager,
  cloneSlots,
  computeSlotTweaks,
  buildStochasticRunSnapshot,
  type SimulationRunSnapshot
} from "../lib/simulationRunState";

// ── Last-run state (mirrors main/index.ts module-level vars) ──────────────────

let lastSlots: ScheduledSlot[] = [];
let lastInventoryTimeline: Record<string, number[]> = {};
let lastGradeLedgerTimeline: Record<string, Record<"green" | "blue" | "grey", number[]>> | null = null;
let lastSimulationConfig: SimulationConfig | null = null;
let lastSimulationLog: SimulationLogRow[] = [];
let lastFeasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }> = [];
const runState = createRunStateManager();

function applyRunResult(
  result: ReturnType<typeof runScheduler>,
  config: SimulationConfig
): void {
  lastInventoryTimeline = Object.fromEntries(result.inventoryTimeline);
  lastGradeLedgerTimeline = result.gradeLedgerTimeline;
  lastSimulationConfig = config;
  lastSimulationLog = result.simulationLog;
  lastFeasibilityWarnings = result.feasibilityWarnings.map((w) => ({
    key: w.key,
    severity: w.severity,
    message: w.message,
    meta: w.meta
  }));
}

function buildSnapshot(slots: ScheduledSlot[]): SimulationRunSnapshot {
  return {
    slots: cloneSlots(slots),
    simulationLog: [...lastSimulationLog],
    inventoryTimeline: Object.fromEntries(
      Object.entries(lastInventoryTimeline).map(([id, arr]) => [id, [...arr]])
    ),
    gradeLedgerTimeline: lastGradeLedgerTimeline
      ? Object.fromEntries(
          Object.entries(lastGradeLedgerTimeline).map(([id, grades]) => [
            id,
            { green: [...grades.green], blue: [...grades.blue], grey: [...grades.grey] }
          ])
        )
      : null,
    feasibilityWarnings: lastFeasibilityWarnings.map((w) => ({ ...w }))
  };
}

function mergeSlotValidationWarnings(
  result: ReturnType<typeof runScheduler>,
  slots: ScheduledSlot[],
  resources: ReturnType<typeof resolveResources>,
  config: SimulationConfig
) {
  const issues = validateScheduledSlots(slots, resources, config);
  if (issues.length === 0) return result;
  return {
    ...result,
    feasibilityWarnings: [
      ...result.feasibilityWarnings,
      ...issues.map((i) => ({
        key: `slot_validation_${i.slotId}`,
        severity: i.severity,
        message: `Slot ${i.slotId.slice(0, 8)}…: ${i.message}`
      }))
    ]
  };
}

function resolveResources() {
  return _store.resources.map((r) => ({
    ...r,
    blackouts: r.blackouts.map((b) => ({
      ...b,
      start: b.start instanceof Date ? b.start : new Date(b.start as unknown as string),
      end: b.end instanceof Date ? b.end : new Date(b.end as unknown as string)
    }))
  }));
}

function serializeSlot(slot: ScheduledSlot) {
  return {
    ...slot,
    start: slot.start instanceof Date ? slot.start.toISOString() : slot.start,
    end: slot.end instanceof Date ? slot.end.toISOString() : slot.end
  };
}

function resolveConfig(): SimulationConfig {
  const row = _store.simulationConfigs[0];
  if (row) {
    return simulationConfigFromRow({
      ...row,
      startDate: row.startDate instanceof Date ? row.startDate : new Date(row.startDate as unknown as string),
      endDate: row.endDate instanceof Date ? row.endDate : new Date(row.endDate as unknown as string)
    });
  }
  return {
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        pipelineFlowRate: 0,
        pipelineDirection: "inbound" as const,
        totalStorageCapacity: 100000,
        storageMode: "fixed_band" as const,
        sharedInventoryCustomerDeficitLimitTonnes: 0,
        borrowingGradeScope: "all" as const,
        pacerInboundRoundAtDecile: 1,
        pacerInboundAllowance: 0.5,
        pacerOutboundRoundAtDecile: 1,
        pacerOutboundAllowance: 0.5,
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
    feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
    inventoryTimeline: Record<string, number[]>;
  }> => {
    const customers = _store.customers;
    const resources = resolveResources();

    if (customers.length === 0 || resources.length === 0) {
      lastSimulationLog = [];
      lastFeasibilityWarnings = [
        { key: "missing_customers_or_resources", severity: "red", message: "Add customers and resources before running the scheduler" }
      ];
      lastSlots = [];
      return Promise.resolve({
        scheduledSlots: [],
        feasibilityWarnings: lastFeasibilityWarnings,
        inventoryTimeline: {}
      });
    }

    const config = resolveConfig();
    const transportPools = _store.transportPools;
    const result = runScheduler(customers, resources, config, transportPools);

    lastSlots = result.scheduledSlots;
    applyRunResult(result, config);
    runState.captureBaseline(buildSnapshot(result.scheduledSlots));

    return Promise.resolve({
      scheduledSlots: result.scheduledSlots.map(serializeSlot),
      feasibilityWarnings: result.feasibilityWarnings,
      inventoryTimeline: lastInventoryTimeline
    });
  },

  getSlots: (): Promise<ReturnType<typeof serializeSlot>[]> =>
    Promise.resolve(lastSlots.map(serializeSlot)),

  getTweakState: (): Promise<{
    hasBaseline: boolean;
    canUndo: boolean;
    needsReplay: boolean;
    isTweaked: boolean;
    slotTweaks: Record<string, "added" | "modified">;
    baselineSlots: ReturnType<typeof serializeSlot>[];
  }> => {
    const baseline = runState.getBaseline();
    return Promise.resolve({
      hasBaseline: runState.hasBaseline(),
      canUndo: runState.canUndo(),
      needsReplay: runState.needsReplay(lastSlots),
      isTweaked: runState.isTweaked(lastSlots),
      slotTweaks: computeSlotTweaks(lastSlots, baseline?.slots ?? null),
      baselineSlots: baseline ? baseline.slots.map(serializeSlot) : []
    });
  },

  getStochasticState: () => {
    const run = runState.getStochasticRun();
    if (!run) return Promise.resolve({ active: false, run: null });
    return Promise.resolve({
      active: true,
      run: {
        stochasticSeed: run.stochasticSeed,
        slots: run.slots.map(serializeSlot),
        ghostSlots: run.ghostSlots.map(serializeSlot),
        simulationLog: run.simulationLog,
        inventoryTimeline: run.inventoryTimeline,
        feasibilityWarnings: run.feasibilityWarnings,
        slotAdjustments: run.slotAdjustments,
        immobilisationWindows: run.immobilisationWindows,
        stochasticEvents: run.stochasticEvents ?? []
      }
    });
  },

  sampleStochastic: (seed?: number) => {
    const customers = _store.customers;
    const resources = resolveResources();
    if (customers.length === 0 || resources.length === 0 || lastSlots.length === 0) {
      return Promise.resolve({
        ok: false as const,
        error: "Run the scheduler first and keep at least one slot."
      });
    }
    const config = resolveConfig();
    if (!config.stochasticConfig?.enabled) {
      return Promise.resolve({
        ok: false as const,
        error: "Enable stochastics under Configuration → Stochastics, then save."
      });
    }
    let result = replaySimulation(customers, resources, config, lastSlots, _store.transportPools, {
      stochasticConfig: config.stochasticConfig,
      seed: typeof seed === "number" && Number.isFinite(seed) ? seed : undefined
    });
    result = mergeSlotValidationWarnings(result, lastSlots, resources, config);
    runState.setStochasticRun(buildStochasticRunSnapshot(lastSlots, result));
    const run = runState.getStochasticRun();
    return Promise.resolve({
      ok: true as const,
      run: run
        ? {
            stochasticSeed: run.stochasticSeed,
            slots: run.slots.map(serializeSlot),
            ghostSlots: run.ghostSlots.map(serializeSlot),
            simulationLog: run.simulationLog,
            inventoryTimeline: run.inventoryTimeline,
            feasibilityWarnings: run.feasibilityWarnings,
            slotAdjustments: run.slotAdjustments,
            immobilisationWindows: run.immobilisationWindows,
            stochasticEvents: run.stochasticEvents ?? []
          }
        : null
    });
  },

  clearStochastic: () => {
    runState.clearStochasticRun();
    return Promise.resolve({ ok: true as const });
  },

  updateSimulation: (): Promise<
    | {
        ok: true;
        scheduledSlots: ReturnType<typeof serializeSlot>[];
        feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
        inventoryTimeline: Record<string, number[]>;
      }
    | { ok: false; error: string }
  > => {
    const customers = _store.customers;
    const resources = resolveResources();
    if (customers.length === 0 || resources.length === 0 || lastSlots.length === 0) {
      return Promise.resolve({
        ok: false,
        error: "Run the scheduler first and keep at least one slot."
      });
    }
    const config = resolveConfig();
    let result = replaySimulation(customers, resources, config, lastSlots, _store.transportPools);
    result = mergeSlotValidationWarnings(result, lastSlots, resources, config);
    applyRunResult(result, config);
    runState.setLastReplayed(lastSlots);
    return Promise.resolve({
      ok: true,
      scheduledSlots: lastSlots.map(serializeSlot),
      feasibilityWarnings: lastFeasibilityWarnings,
      inventoryTimeline: lastInventoryTimeline
    });
  },

  restoreBaseline: (): Promise<
    | {
        ok: true;
        scheduledSlots: ReturnType<typeof serializeSlot>[];
        feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
        inventoryTimeline: Record<string, number[]>;
      }
    | { ok: false; error: string }
  > => {
    const baseline = runState.getBaseline();
    if (!baseline) {
      return Promise.resolve({ ok: false, error: "No baseline — run the scheduler first." });
    }
    runState.pushUndo(lastSlots);
    lastSlots = cloneSlots(baseline.slots);
    lastInventoryTimeline = Object.fromEntries(
      Object.entries(baseline.inventoryTimeline).map(([id, arr]) => [id, [...arr]])
    );
    lastGradeLedgerTimeline = baseline.gradeLedgerTimeline;
    lastSimulationLog = baseline.simulationLog;
    lastFeasibilityWarnings = baseline.feasibilityWarnings.map((w) => ({ ...w }));
    runState.setLastReplayed(lastSlots);
    runState.clearStochasticRun();
    return Promise.resolve({
      ok: true,
      scheduledSlots: lastSlots.map(serializeSlot),
      feasibilityWarnings: lastFeasibilityWarnings,
      inventoryTimeline: lastInventoryTimeline
    });
  },

  undo: (): Promise<
    | {
        ok: true;
        scheduledSlots: ReturnType<typeof serializeSlot>[];
        feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
        inventoryTimeline: Record<string, number[]>;
      }
    | { ok: false; error: string }
  > => {
    const prev = runState.popUndo();
    if (!prev) {
      return Promise.resolve({ ok: false, error: "Nothing to undo." });
    }
    lastSlots = prev;
    const customers = _store.customers;
    const resources = resolveResources();
    const config = resolveConfig();
    let result = replaySimulation(customers, resources, config, prev, _store.transportPools);
    result = mergeSlotValidationWarnings(result, prev, resources, config);
    applyRunResult(result, config);
    runState.setLastReplayed(prev);
    return Promise.resolve({
      ok: true,
      scheduledSlots: prev.map(serializeSlot),
      feasibilityWarnings: lastFeasibilityWarnings,
      inventoryTimeline: lastInventoryTimeline
    });
  },

  deleteSlot: (slotId: string): Promise<{ ok: true; slotId: string } | { ok: false; error: string }> => {
    const id = String(slotId ?? "");
    if (!id) return Promise.resolve({ ok: false, error: "Slot id required." });
    if (!lastSlots.some((s) => s.id === id)) {
      return Promise.resolve({ ok: false, error: "Slot not found." });
    }
    runState.pushUndo(lastSlots);
    lastSlots = lastSlots.filter((s) => s.id !== id);
    runState.markDirty();
    return Promise.resolve({ ok: true, slotId: id });
  },

  upsertSlot: (payload: {
    slot: {
      id?: string;
      customerId: string;
      resourceId: string;
      direction: string;
      mode: string;
      volume: number;
      start: string;
      end: string;
      legKey?: string | null;
    };
    isNew?: boolean;
  }): Promise<{ ok: true; slot: ReturnType<typeof serializeSlot> } | { ok: false; error: string }> => {
    const customer = _store.customers.find((c) => c.id === payload.slot.customerId);
    if (!customer) return Promise.resolve({ ok: false, error: "Customer not found." });
    const resources = resolveResources();
    const config = resolveConfig();
    runState.pushUndo(lastSlots);

    const draft: ScheduledSlot = {
      id: payload.slot.id ?? crypto.randomUUID(),
      customerId: payload.slot.customerId,
      resourceId: payload.slot.resourceId,
      direction: payload.slot.direction as ScheduledSlot["direction"],
      mode: payload.slot.mode as ScheduledSlot["mode"],
      legKey: payload.slot.legKey ?? null,
      volume: Math.max(0, Number(payload.slot.volume)),
      start: new Date(payload.slot.start),
      end: new Date(payload.slot.end),
      reservationStart: null,
      reservationEnd: null,
      status: "manual_override",
      conflictReason: null
    };
    const others = lastSlots.filter((s) => s.id !== draft.id);
    const built = finalizeManualSlot(draft, customer, resources, config, others);
    if (!built.ok) return Promise.resolve({ ok: false, error: built.error });

    if (payload.isNew || !lastSlots.some((s) => s.id === built.slot.id)) {
      lastSlots = [...lastSlots, built.slot];
    } else {
      lastSlots = lastSlots.map((s) => (s.id === built.slot.id ? built.slot : s));
    }
    runState.markDirty();
    return Promise.resolve({ ok: true, slot: serializeSlot(built.slot) });
  },

  getSimulationLog: (): Promise<SimulationLogRow[]> =>
    Promise.resolve(lastSimulationLog),

  getFeasibilityWarnings: (): Promise<Array<{ key: string; severity: "amber" | "red"; message: string }>> =>
    Promise.resolve(lastFeasibilityWarnings),

  getInventoryTimeline: (): Promise<{
    timeline: Record<string, number[]>;
    gradeTimeline?: Record<string, Record<"green" | "blue" | "grey", number[]>> | null;
    startDate: string | null;
    totalStorageCapacity?: number | null;
  } | null> => {
    if (!lastInventoryTimeline || Object.keys(lastInventoryTimeline).length === 0) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      timeline: lastInventoryTimeline,
      gradeTimeline: lastGradeLedgerTimeline,
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
