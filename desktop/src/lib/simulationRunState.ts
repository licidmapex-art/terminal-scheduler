/**
 * Baseline snapshot + undo stack for tweakable schedule (pass 1 vs working copy).
 */

import type {
  ScheduledSlot,
  SimulationOverrides,
  StochasticEvent,
  ImmobilisationWindow,
  SlotTimeAdjustment,
  MonteCarloAggregates,
  MonteCarloCustomerSummary,
  InventoryPercentileSeries
} from "../types";
import type { SimulationLogRow } from "../engine/simulationLog";
import type { GradeLedgerTimeline } from "../engine/gradeInventoryLedger";

export type GanttScheduleView = "deterministic" | "stochastic";

export interface StochasticRunSnapshot {
  slots: ScheduledSlot[];
  /** Working slot list at sample time (before delay shifts). */
  ghostSlots: ScheduledSlot[];
  simulationLog: SimulationLogRow[];
  inventoryTimeline: Record<string, number[]>;
  gradeLedgerTimeline: GradeLedgerTimeline | null;
  feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
  simulationOverrides?: SimulationOverrides;
  stochasticEvents?: StochasticEvent[];
  stochasticSeed?: number;
  slotAdjustments: SlotTimeAdjustment[];
  immobilisationWindows: ImmobilisationWindow[];
}

/** Monte Carlo batch result (in-memory only; not persisted to DB). */
export interface MonteCarloSnapshot {
  iterations: number;
  selectedIndex: number;
  baseSeed: number;
  runSeeds: number[];
  aggregates: MonteCarloAggregates;
  customerSummaries: MonteCarloCustomerSummary[];
  /** Full runs when iterations ≤ 50; omitted in sparse mode. */
  runs?: StochasticRunSnapshot[];
}

export interface SimulationRunSnapshot {
  slots: ScheduledSlot[];
  simulationLog: SimulationLogRow[];
  inventoryTimeline: Record<string, number[]>;
  gradeLedgerTimeline: GradeLedgerTimeline | null;
  feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
}

export function cloneSlot(s: ScheduledSlot): ScheduledSlot {
  return {
    ...s,
    start: s.start instanceof Date ? new Date(s.start) : new Date(s.start as unknown as string),
    end: s.end instanceof Date ? new Date(s.end) : new Date(s.end as unknown as string),
    reservationStart: s.reservationStart
      ? s.reservationStart instanceof Date
        ? new Date(s.reservationStart)
        : new Date(s.reservationStart as unknown as string)
      : null,
    reservationEnd: s.reservationEnd
      ? s.reservationEnd instanceof Date
        ? new Date(s.reservationEnd)
        : new Date(s.reservationEnd as unknown as string)
      : null
  };
}

export function cloneSlots(slots: ScheduledSlot[]): ScheduledSlot[] {
  return slots.map(cloneSlot);
}

function slotSortKey(s: ScheduledSlot): string {
  return `${s.id}|${s.start.toISOString()}|${s.volume}|${s.resourceId}`;
}

export function slotsEqual(a: ScheduledSlot[], b: ScheduledSlot[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => slotSortKey(x).localeCompare(slotSortKey(y)));
  const sb = [...b].sort((x, y) => slotSortKey(x).localeCompare(slotSortKey(y)));
  return sa.every((s, i) => slotFieldsEqual(s, sb[i]!));
}

function slotFieldsEqual(a: ScheduledSlot, b: ScheduledSlot): boolean {
  return (
    a.id === b.id &&
    a.customerId === b.customerId &&
    a.resourceId === b.resourceId &&
    a.direction === b.direction &&
    a.mode === b.mode &&
    a.legKey === b.legKey &&
    a.volume === b.volume &&
    a.start.getTime() === b.start.getTime() &&
    a.end.getTime() === b.end.getTime() &&
    a.status === b.status
  );
}

export type SlotTweakKind = "added" | "modified";

/** Slots that differ from the captured baseline (added or edited manually). */
export function computeSlotTweaks(
  current: ScheduledSlot[],
  baseline: ScheduledSlot[] | null
): Record<string, SlotTweakKind> {
  if (!baseline) return {};
  const baselineById = new Map(baseline.map((s) => [s.id, s]));
  const out: Record<string, SlotTweakKind> = {};
  for (const s of current) {
    const b = baselineById.get(s.id);
    if (!b) out[s.id] = "added";
    else if (!slotFieldsEqual(s, b)) out[s.id] = "modified";
  }
  return out;
}

export function cloneSnapshot(snap: SimulationRunSnapshot): SimulationRunSnapshot {
  return {
    slots: cloneSlots(snap.slots),
    simulationLog: snap.simulationLog.map((r) => ({
      ...r,
      customerInventories: { ...r.customerInventories },
      pipelineFlow: { ...r.pipelineFlow },
      customerGradeInventories: r.customerGradeInventories
        ? Object.fromEntries(
            Object.entries(r.customerGradeInventories).map(([id, row]) => [
              id,
              { ...row }
            ])
          )
        : undefined,
      transportStatus: [...r.transportStatus]
    })),
    inventoryTimeline: Object.fromEntries(
      Object.entries(snap.inventoryTimeline).map(([id, arr]) => [id, [...arr]])
    ),
    gradeLedgerTimeline: snap.gradeLedgerTimeline
      ? Object.fromEntries(
          Object.entries(snap.gradeLedgerTimeline).map(([id, grades]) => [
            id,
            { green: [...grades.green], blue: [...grades.blue], grey: [...grades.grey] }
          ])
        )
      : null,
    feasibilityWarnings: snap.feasibilityWarnings.map((w) => ({ ...w }))
  };
}

const MAX_UNDO = 40;

function cloneStochasticRunSnapshot(snapshot: StochasticRunSnapshot): StochasticRunSnapshot {
  return {
    ...snapshot,
    slots: cloneSlots(snapshot.slots),
    ghostSlots: cloneSlots(snapshot.ghostSlots),
    simulationLog: snapshot.simulationLog.map((r) => ({
      ...r,
      customerInventories: { ...r.customerInventories },
      pipelineFlow: { ...r.pipelineFlow },
      transportStatus: [...r.transportStatus],
      stochasticEvents: r.stochasticEvents ? [...r.stochasticEvents] : undefined
    })),
    inventoryTimeline: Object.fromEntries(
      Object.entries(snapshot.inventoryTimeline).map(([id, arr]) => [id, [...arr]])
    ),
    gradeLedgerTimeline: snapshot.gradeLedgerTimeline
      ? Object.fromEntries(
          Object.entries(snapshot.gradeLedgerTimeline).map(([id, grades]) => [
            id,
            { green: [...grades.green], blue: [...grades.blue], grey: [...grades.grey] }
          ])
        )
      : null,
    feasibilityWarnings: snapshot.feasibilityWarnings.map((w) => ({ ...w })),
    slotAdjustments: [...snapshot.slotAdjustments],
    immobilisationWindows: snapshot.immobilisationWindows.map((w) => ({ ...w })),
    stochasticEvents: snapshot.stochasticEvents ? [...snapshot.stochasticEvents] : undefined
  };
}

function clonePercentileSeries(series: InventoryPercentileSeries): InventoryPercentileSeries {
  return {
    p10: [...series.p10],
    p50: [...series.p50],
    p90: [...series.p90]
  };
}

function cloneMonteCarloSnapshot(snapshot: MonteCarloSnapshot): MonteCarloSnapshot {
  return {
    ...snapshot,
    runSeeds: [...snapshot.runSeeds],
    customerSummaries: snapshot.customerSummaries.map((s) => ({ ...s })),
    aggregates: {
      terminalInventory: clonePercentileSeries(snapshot.aggregates.terminalInventory),
      customerInventory: Object.fromEntries(
        Object.entries(snapshot.aggregates.customerInventory).map(([id, series]) => [
          id,
          clonePercentileSeries(series)
        ])
      ),
      pipelineInbound: clonePercentileSeries(
        snapshot.aggregates.pipelineInbound ?? { p10: [], p50: [], p90: [] }
      ),
      pipelineOutbound: clonePercentileSeries(
        snapshot.aggregates.pipelineOutbound ?? { p10: [], p50: [], p90: [] }
      ),
      warningCounts: { ...snapshot.aggregates.warningCounts },
      eventHistograms: { ...snapshot.aggregates.eventHistograms }
    },
    runs: snapshot.runs?.map(cloneStochasticRunSnapshot)
  };
}

export function createRunStateManager() {
  let baseline: SimulationRunSnapshot | null = null;
  let undoStack: ScheduledSlot[][] = [];
  let lastReplayedSlots: ScheduledSlot[] = [];
  let dirty = false;
  let stochasticRun: StochasticRunSnapshot | null = null;
  let monteCarlo: MonteCarloSnapshot | null = null;
  let monteCarloCancelRequested = false;

  const clearStochasticBranches = () => {
    stochasticRun = null;
    monteCarlo = null;
    monteCarloCancelRequested = false;
  };

  const syncStochasticFromMonteCarlo = () => {
    if (!monteCarlo?.runs?.length) return;
    const run = monteCarlo.runs[monteCarlo.selectedIndex];
    if (run) stochasticRun = cloneStochasticRunSnapshot(run);
  };

  return {
    captureBaseline(snapshot: SimulationRunSnapshot): void {
      baseline = cloneSnapshot(snapshot);
      undoStack = [];
      dirty = false;
      lastReplayedSlots = cloneSlots(snapshot.slots);
      clearStochasticBranches();
    },

    pushUndo(slots: ScheduledSlot[]): void {
      undoStack.push(cloneSlots(slots));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      dirty = true;
    },

    popUndo(): ScheduledSlot[] | null {
      const prev = undoStack.pop();
      return prev ?? null;
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    hasBaseline(): boolean {
      return baseline !== null;
    },

    getBaseline(): SimulationRunSnapshot | null {
      return baseline ? cloneSnapshot(baseline) : null;
    },

    setLastReplayed(slots: ScheduledSlot[]): void {
      lastReplayedSlots = cloneSlots(slots);
      dirty = false;
    },

    markDirty(): void {
      dirty = true;
    },

    needsReplay(currentSlots: ScheduledSlot[]): boolean {
      if (dirty) return true;
      return !slotsEqual(currentSlots, lastReplayedSlots);
    },

    isTweaked(currentSlots: ScheduledSlot[]): boolean {
      if (!baseline) return false;
      return !slotsEqual(currentSlots, baseline.slots);
    },

    reset(): void {
      baseline = null;
      undoStack = [];
      dirty = false;
      lastReplayedSlots = [];
      clearStochasticBranches();
    },

    setStochasticRun(snapshot: StochasticRunSnapshot): void {
      monteCarlo = null;
      monteCarloCancelRequested = false;
      stochasticRun = cloneStochasticRunSnapshot(snapshot);
    },

    getStochasticRun(): StochasticRunSnapshot | null {
      if (!stochasticRun) return null;
      return cloneStochasticRunSnapshot(stochasticRun);
    },

    hasStochasticRun(): boolean {
      return stochasticRun != null;
    },

    clearStochasticRun(): void {
      clearStochasticBranches();
    },

    setMonteCarlo(snapshot: MonteCarloSnapshot): void {
      monteCarlo = cloneMonteCarloSnapshot(snapshot);
      monteCarloCancelRequested = false;
      syncStochasticFromMonteCarlo();
    },

    getMonteCarlo(): MonteCarloSnapshot | null {
      if (!monteCarlo) return null;
      return cloneMonteCarloSnapshot(monteCarlo);
    },

    hasMonteCarlo(): boolean {
      return monteCarlo != null;
    },

    setMonteCarloSelectedIndex(index: number): void {
      if (!monteCarlo) return;
      const clamped = Math.max(0, Math.min(monteCarlo.iterations - 1, Math.floor(index)));
      monteCarlo = { ...monteCarlo, selectedIndex: clamped };
      syncStochasticFromMonteCarlo();
    },

    attachMonteCarloRun(index: number, run: StochasticRunSnapshot): void {
      if (!monteCarlo) return;
      const clamped = Math.max(0, Math.min(monteCarlo.iterations - 1, Math.floor(index)));
      if (!monteCarlo.runs) monteCarlo.runs = [];
      monteCarlo.runs[clamped] = cloneStochasticRunSnapshot(run);
      monteCarlo = { ...monteCarlo, selectedIndex: clamped };
      stochasticRun = cloneStochasticRunSnapshot(run);
    },

    clearMonteCarlo(): void {
      monteCarlo = null;
      monteCarloCancelRequested = false;
      stochasticRun = null;
    },

    requestMonteCarloCancel(): void {
      monteCarloCancelRequested = true;
    },

    shouldCancelMonteCarlo(): boolean {
      return monteCarloCancelRequested;
    }
  };
}

import type { ScheduleResult } from "../engine/scheduler";

export function buildStochasticRunSnapshot(
  workingSlots: ScheduledSlot[],
  result: ScheduleResult
): StochasticRunSnapshot {
  return {
    slots: cloneSlots(result.scheduledSlots),
    ghostSlots: cloneSlots(workingSlots),
    simulationLog: result.simulationLog.map((r) => ({
      ...r,
      customerInventories: { ...r.customerInventories },
      pipelineFlow: { ...r.pipelineFlow },
      transportStatus: [...r.transportStatus],
      stochasticEvents: r.stochasticEvents ? [...r.stochasticEvents] : undefined
    })),
    inventoryTimeline: Object.fromEntries(result.inventoryTimeline),
    gradeLedgerTimeline: result.gradeLedgerTimeline,
    feasibilityWarnings: result.feasibilityWarnings.map((w) => ({
      key: w.key,
      severity: w.severity,
      message: w.message,
      meta: w.meta
    })),
    simulationOverrides: result.simulationOverrides,
    stochasticEvents: result.stochasticEvents,
    stochasticSeed: result.stochasticSeed,
    slotAdjustments: result.simulationOverrides?.slotAdjustments ?? [],
    immobilisationWindows: result.simulationOverrides?.immobilisationWindows ?? []
  };
}
