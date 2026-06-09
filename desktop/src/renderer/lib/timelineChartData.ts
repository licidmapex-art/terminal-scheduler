import type { Customer, ScheduledSlot, SimulationConfig } from "../../types";
import type { SimulationLogRow } from "../../engine/simulationLog";
import { simulationPeriodHoursFloored } from "../../engine/inventory";
import {
  customerRepresentativeDaysOfCover,
  terminalRepresentativeDaysOfCover
} from "../../engine/customerLegTargets";
import { customerPacingPctByDirectionMode, formatDirectionModeLabel } from "../../engine/pacing";
import {
  SCHEDULING_CONSTRAINTS,
  constraintDataKey,
  type BlockingConstraintKey
} from "./schedulingConstraints";

export const SAMPLE_HOUR_STEP = 6;
export const AVERAGE_CUSTOMER_ID = "__all_customers_avg__";
export const COMBINED_TERMINAL_ID = "__terminal_combined__";

export const AGGREGATE_DOC_IDS = new Set([AVERAGE_CUSTOMER_ID, COMBINED_TERMINAL_ID]);

function isRealCustomerDocId(id: string): boolean {
  return !AGGREGATE_DOC_IDS.has(id);
}

export interface ConstraintHourRow {
  hour: number;
  counts: Record<BlockingConstraintKey, number>;
  total: number;
}

export interface ConstraintSummary {
  key: BlockingConstraintKey;
  legHours: number;
}

export interface PacingLegOption {
  key: string;
  customerId: string;
  customerName: string;
  directionMode: string;
  label: string;
}

interface InventoryTimeline {
  timeline: Record<string, number[]>;
  startDate: string | null;
}

function isBlockingIdle(
  action: string,
  blockingConstraint: SimulationLogRow["transportStatus"][number]["blockingConstraint"]
): blockingConstraint is BlockingConstraintKey {
  return action === "idle" && blockingConstraint != null;
}

export function buildDocTrendByCustomer(
  simulationLog: SimulationLogRow[],
  customers: Array<{ id: string; name: string }>,
  timelineData: InventoryTimeline | null,
  config: SimulationConfig | null,
  customerById: Map<string, Customer>
): Record<string, Array<number | null>> {
  const out: Record<string, Array<number | null>> = {};

  if (simulationLog.length > 0) {
    const maxHour = Math.max(...simulationLog.map((r) => r.hour));
    for (const customer of customers) {
      const series: Array<number | null> = [];
      for (let h = 0; h <= maxHour; h++) {
        const row = simulationLog.find((r) => r.hour === h);
        if (!row) {
          series.push(null);
          continue;
        }
        const vals = (row.transportStatus ?? [])
          .filter((s) => s.customerId === customer.id && s.daysOfCover !== undefined)
          .map((s) => s.daysOfCover)
          .filter((v): v is number => v != null && Number.isFinite(v));
        series.push(vals.length > 0 ? Math.min(...vals) : null);
      }
      if (!series.every((x) => x == null)) out[customer.id] = series;
    }

    const avgSeries: Array<number | null> = [];
    const combinedSeries: Array<number | null> = [];
    for (let h = 0; h <= maxHour; h++) {
      const row = simulationLog.find((r) => r.hour === h);
      const avg = row?.averageCustomerDaysOfCover;
      const combined = row?.combinedTerminalDaysOfCover;
      avgSeries.push(avg != null && Number.isFinite(avg) ? avg : null);
      combinedSeries.push(combined != null && Number.isFinite(combined) ? combined : null);
    }
    if (!avgSeries.every((x) => x == null)) out[AVERAGE_CUSTOMER_ID] = avgSeries;
    if (!combinedSeries.every((x) => x == null)) out[COMBINED_TERMINAL_ID] = combinedSeries;
    return out;
  }

  if (!timelineData?.timeline || !config) return out;
  const periodFloored = simulationPeriodHoursFloored(config);
  const customerIds = Object.keys(timelineData.timeline);
  const maxLen = Math.max(...customerIds.map((id) => timelineData.timeline[id]?.length ?? 0), 0);
  const terminalByHour = new Array<number>(maxLen).fill(0);
  const perCustomerSeries: Record<string, Array<number | null>> = {};

  for (const [customerId, values] of Object.entries(timelineData.timeline)) {
    const customer = customerById.get(customerId);
    if (!customer) continue;
    const arr = values as number[];
    const series = arr.map((inv) =>
      customerRepresentativeDaysOfCover(inv, customer, config, periodFloored)
    );
    if (series.every((x) => x == null)) continue;
    out[customerId] = series;
    perCustomerSeries[customerId] = series;
    for (let h = 0; h < arr.length; h++) terminalByHour[h] = (terminalByHour[h] ?? 0) + (arr[h] ?? 0);
  }

  if (maxLen > 0) {
    const allCustomers = [...customerById.values()];
    const combinedSeries = terminalByHour.map((inv) =>
      terminalRepresentativeDaysOfCover(inv, allCustomers, config, periodFloored)
    );
    if (!combinedSeries.every((x) => x == null)) out[COMBINED_TERMINAL_ID] = combinedSeries;

    const avgSeries: Array<number | null> = [];
    for (let h = 0; h < maxLen; h++) {
      const vals: number[] = [];
      for (const series of Object.values(perCustomerSeries)) {
        const v = series[h];
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
      avgSeries.push(vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null);
    }
    if (!avgSeries.every((x) => x == null)) out[AVERAGE_CUSTOMER_ID] = avgSeries;
  }
  return out;
}

export { isRealCustomerDocId };

export function buildPacingByCustomerMode(
  customers: Customer[],
  config: SimulationConfig | null,
  periodHours: number,
  slots: ScheduledSlot[],
  simulationLog: SimulationLogRow[]
): Record<string, Record<string, number[]>> {
  if (!config || periodHours <= 0 || simulationLog.length === 0) return {};
  const start = new Date(config.startDate).getTime();
  const maxHour = Math.max(...simulationLog.map((r) => r.hour));
  const out: Record<string, Record<string, number[]>> = {};
  for (const c of customers) {
    const byMode = customerPacingPctByDirectionMode(
      c,
      config,
      periodHours,
      slots,
      maxHour,
      start
    );
    if (byMode && Object.keys(byMode).length > 0) out[c.id] = byMode;
  }
  return out;
}

export function buildPacingLegOptions(
  customers: Array<{ id: string; name: string }>,
  pacingByCustomerMode: Record<string, Record<string, number[]>>
): PacingLegOption[] {
  const out: PacingLegOption[] = [];
  for (const c of customers) {
    const byMode = pacingByCustomerMode[c.id];
    if (!byMode) continue;
    for (const dk of Object.keys(byMode).sort()) {
      out.push({
        key: `${c.id}:${dk}`,
        customerId: c.id,
        customerName: c.name,
        directionMode: dk,
        label: `${c.name} · ${formatDirectionModeLabel(dk)}`
      });
    }
  }
  return out;
}

export function buildConstraintHourData(
  simulationLog: SimulationLogRow[],
  enabledCustomerIds: Set<string>
): {
  rows: ConstraintHourRow[];
  summaries: ConstraintSummary[];
  activeConstraintKeys: BlockingConstraintKey[];
  maxCountPerHour: number;
} {
  const summariesAcc = new Map<BlockingConstraintKey, number>();
  for (const def of SCHEDULING_CONSTRAINTS) {
    summariesAcc.set(def.key, 0);
  }

  const logByHour = new Map<number, SimulationLogRow>();
  for (const row of simulationLog) {
    logByHour.set(Math.round(row.hour), row);
  }

  const maxHour = simulationLog.length > 0 ? Math.max(...simulationLog.map((r) => r.hour)) : 0;
  const rows: ConstraintHourRow[] = [];
  let maxCountPerHour = 0;

  for (let h = 0; h <= maxHour; h++) {
    const counts = {} as Record<BlockingConstraintKey, number>;
    for (const def of SCHEDULING_CONSTRAINTS) {
      counts[def.key] = 0;
    }
    const logRow = logByHour.get(h);
    if (logRow) {
      for (const status of logRow.transportStatus ?? []) {
        if (!enabledCustomerIds.has(status.customerId)) continue;
        if (!isBlockingIdle(status.action, status.blockingConstraint)) continue;
        const key = status.blockingConstraint;
        counts[key]++;
        summariesAcc.set(key, (summariesAcc.get(key) ?? 0) + 1);
      }
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    if (total > maxCountPerHour) maxCountPerHour = total;
    rows.push({ hour: h, counts, total });
  }

  const activeConstraintKeys = SCHEDULING_CONSTRAINTS.filter(
    (def) => (summariesAcc.get(def.key) ?? 0) > 0
  ).map((d) => d.key);

  const summaries: ConstraintSummary[] = SCHEDULING_CONSTRAINTS.map((def) => ({
    key: def.key,
    legHours: summariesAcc.get(def.key) ?? 0
  }));

  return { rows, summaries, activeConstraintKeys, maxCountPerHour };
}

export function getConstraintCountAtHour(
  row: ConstraintHourRow,
  enabledConstraints: Set<BlockingConstraintKey>
): number {
  let n = 0;
  for (const key of enabledConstraints) {
    n += row.counts[key] ?? 0;
  }
  return n;
}

export { constraintDataKey, formatDirectionModeLabel };
