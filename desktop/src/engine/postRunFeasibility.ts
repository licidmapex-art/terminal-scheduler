/**
 * Feasibility warnings derived from the completed simulation log (post-schedule).
 */

import type { Customer, SimulationConfig } from "../types";
import { getCustomerMaxCapacity } from "./inventory";
import type { SimulationLogRow } from "./simulationLog";

const TREND_FRACTION_OF_SCALE = 0.01;
const TREND_DIRECTION_AGREEMENT = 0.55;
const PIPELINE_INTERRUPT_THRESHOLD = 0.01;
const BORROWING_LIMIT_THRESHOLD = 0.01;
const CAP_EPS = 1;

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function edgeWindowAvg(series: number[], fromStart: boolean): number {
  if (series.length === 0) return 0;
  const window = Math.max(1, Math.ceil(series.length * 0.05));
  const slice = fromStart ? series.slice(0, window) : series.slice(-window);
  return avg(slice);
}

/** True when the series drifts materially up or down over the horizon (not flat). */
export function isSeriesTrendingUnstable(series: number[], scale: number): boolean {
  if (series.length < 2) return false;
  const ref = Math.max(Math.abs(scale), Math.abs(avg(series)), 1);
  const delta = edgeWindowAvg(series, false) - edgeWindowAvg(series, true);
  if (Math.abs(delta) / ref < TREND_FRACTION_OF_SCALE) return false;

  let sameSign = 0;
  let steps = 0;
  for (let i = 1; i < series.length; i++) {
    const d = series[i]! - series[i - 1]!;
    if (d === 0) continue;
    steps++;
    if (Math.sign(d) === Math.sign(delta)) sameSign++;
  }
  if (steps === 0) return Math.abs(delta) / ref >= TREND_FRACTION_OF_SCALE;
  return sameSign / steps >= TREND_DIRECTION_AGREEMENT;
}

function trendDirectionLabel(series: number[]): "increasing" | "decreasing" {
  const delta = edgeWindowAvg(series, false) - edgeWindowAvg(series, true);
  return delta >= 0 ? "increasing" : "decreasing";
}

function countPipelineInterruptedHours(
  log: SimulationLogRow[],
  config: SimulationConfig,
  hasPipeline: boolean
): number {
  if (!hasPipeline || log.length === 0) return 0;
  const cap = config.totalStorageCapacity ?? 100_000;
  const isInbound = config.pipelineDirection !== "outbound";
  let count = 0;
  for (const row of log) {
    const total = row.terminalTotal ?? 0;
    const interrupted =
      (isInbound && total >= cap - CAP_EPS) || (!isInbound && total <= CAP_EPS);
    if (interrupted) count++;
  }
  return count;
}

function countBorrowingLimitHours(
  log: SimulationLogRow[],
  customers: Customer[],
  config: SimulationConfig
): number {
  const limit = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
  if (config.storageMode !== "shared_inventory" || limit <= 0 || log.length === 0) return 0;

  let count = 0;
  for (const row of log) {
    const atLimit = customers.some((c) => (row.customerInventories[c.id] ?? 0) <= -limit + CAP_EPS);
    const blocked = row.transportStatus.some(
      (t) => t.blockingConstraint === "customer_inventory_floor" && t.action === "idle"
    );
    if (atLimit || blocked) count++;
  }
  return count;
}

function customerDocSeries(log: SimulationLogRow[], customerId: string): number[] {
  const out: number[] = [];
  for (const row of log) {
    const docs = row.transportStatus
      .filter((t) => t.customerId === customerId && t.daysOfCover != null && Number.isFinite(t.daysOfCover))
      .map((t) => t.daysOfCover as number);
    if (docs.length === 0) continue;
    out.push(Math.min(...docs));
  }
  return out;
}

export function runPostRunFeasibilityChecks(
  customers: Customer[],
  config: SimulationConfig,
  simulationLog: SimulationLogRow[]
): string[] {
  const warnings: string[] = [];
  if (simulationLog.length === 0) return warnings;

  const totalHours = simulationLog.length;
  const hasPipeline = customers.some((c) => (c.pipelineFlowPerHour ?? 0) > 0);

  const terminalSeries = simulationLog.map((r) => r.terminalTotal ?? 0);
  const terminalScale = config.totalStorageCapacity ?? 100_000;
  if (isSeriesTrendingUnstable(terminalSeries, terminalScale)) {
    const dir = trendDirectionLabel(terminalSeries);
    warnings.push(
      `Terminal inventory is ${dir} over the simulation period (not stable). Check inbound/outbound balance and storage mode.`
    );
  }

  const terminalDocSeries = simulationLog
    .map((r) => r.averageCustomerDaysOfCover)
    .filter((d): d is number => d != null && Number.isFinite(d));
  if (terminalDocSeries.length >= 2 && isSeriesTrendingUnstable(terminalDocSeries, avg(terminalDocSeries))) {
    const dir = trendDirectionLabel(terminalDocSeries);
    warnings.push(
      `Average days of cover is ${dir} over the simulation period (not stable).`
    );
  }

  for (const c of customers) {
    const invSeries = simulationLog.map((r) => r.customerInventories[c.id] ?? 0);
    const scale = getCustomerMaxCapacity(c, config) || terminalScale;
    if (isSeriesTrendingUnstable(invSeries, scale)) {
      const dir = trendDirectionLabel(invSeries);
      warnings.push(
        `Customer ${c.name}: inventory is ${dir} over the simulation period (not stable).`
      );
    }

    const docSeries = customerDocSeries(simulationLog, c.id);
    if (docSeries.length >= 2 && isSeriesTrendingUnstable(docSeries, avg(docSeries))) {
      const dir = trendDirectionLabel(docSeries);
      warnings.push(
        `Customer ${c.name}: days of cover is ${dir} over the simulation period (not stable).`
      );
    }
  }

  const pipelineInterrupted = countPipelineInterruptedHours(simulationLog, config, hasPipeline);
  if (hasPipeline && pipelineInterrupted / totalHours > PIPELINE_INTERRUPT_THRESHOLD) {
    const pct = ((pipelineInterrupted / totalHours) * 100).toFixed(1);
    const reason =
      config.pipelineDirection === "outbound"
        ? "terminal inventory at bottom (tank empty)"
        : "terminal at storage capacity (tank full)";
    warnings.push(
      `Pipeline was interrupted ${pct}% of the simulation (${pipelineInterrupted} of ${totalHours} hours) due to ${reason}.`
    );
  }

  const borrowingHours = countBorrowingLimitHours(simulationLog, customers, config);
  if (borrowingHours / totalHours > BORROWING_LIMIT_THRESHOLD) {
    const pct = ((borrowingHours / totalHours) * 100).toFixed(1);
    const limit = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
    warnings.push(
      `Customer borrowing limit (−${Math.round(limit).toLocaleString()} t) was reached ${pct}% of the simulation (${borrowingHours} of ${totalHours} hours).`
    );
  }

  return warnings;
}
