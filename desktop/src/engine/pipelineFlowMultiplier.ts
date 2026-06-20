import type { StochasticEvent } from "../types";
import type { SimulationLogRow } from "./simulationLog";

const EPS = 1;

/** Effective pipeline flow multiplier at one hour (0 = blocked, 1 = full flow). */
export function pipelineFlowMultiplierAtHour(
  direction: "inbound" | "outbound",
  terminalBefore: number,
  totalStorageCapacity: number,
  hourEvents: StochasticEvent[],
  includeStochastic: boolean
): number {
  if (includeStochastic) {
    if (hourEvents.some((e) => e.kind === "pipeline_stop")) return 0;
    const reductions = hourEvents.filter((e) => e.kind === "pipeline_reduction");
    if (reductions.length > 0) {
      return reductions.reduce((m, e) => Math.min(m, e.magnitude ?? 1), 1);
    }
  }
  if (direction === "inbound") {
    return terminalBefore >= totalStorageCapacity - EPS ? 0 : 1;
  }
  return terminalBefore <= EPS ? 0 : 1;
}

function terminalBeforeHour(
  log: Pick<SimulationLogRow, "terminalTotal" | "customerInventories">[],
  h: number
): number {
  if (h === 0) {
    const row = log[0];
    if (!row) return 0;
    if (row.terminalTotal != null && Number.isFinite(row.terminalTotal)) return row.terminalTotal;
    return Object.values(row.customerInventories ?? {}).reduce((s, v) => s + v, 0);
  }
  const prev = log[h - 1];
  if (!prev) return 0;
  if (prev.terminalTotal != null && Number.isFinite(prev.terminalTotal)) return prev.terminalTotal;
  return Object.values(prev.customerInventories ?? {}).reduce((s, v) => s + v, 0);
}

/** Per-hour effective flow multiplier series for Gantt pipeline rows and Monte Carlo aggregation. */
export function pipelineFlowMultiplierSeries(
  direction: "inbound" | "outbound",
  log: Pick<SimulationLogRow, "terminalTotal" | "customerInventories" | "stochasticEvents">[],
  totalStorageCapacity: number,
  includeStochastic = true
): number[] {
  const cap = totalStorageCapacity;
  const out: number[] = [];
  for (let h = 0; h < log.length; h++) {
    const terminalBefore = terminalBeforeHour(log, h);
    const hourEvents = log[h]?.stochasticEvents ?? [];
    out.push(
      pipelineFlowMultiplierAtHour(direction, terminalBefore, cap, hourEvents, includeStochastic)
    );
  }
  return out;
}

/** Bar height in px for pipeline row (matches GanttChart renderPipelineRow). */
export function pipelineBarHeightPx(flowMultiplier: number): number {
  if (flowMultiplier <= 0) return 12;
  if (flowMultiplier < 1) return 4 + 12 * Math.min(1, Math.max(0, flowMultiplier));
  return 12;
}
