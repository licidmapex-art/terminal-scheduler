/**
 * Feasibility warnings derived from the completed simulation log (post-schedule).
 */

import type { Customer, SimulationConfig } from "../types";
import type { ScheduledSlot } from "../types";
import { getCustomerMaxCapacity } from "./inventory";
import { totalInboundPipelineTph, totalOutboundPipelineTph } from "./pipelineFlows";
import type { SimulationLogRow } from "./simulationLog";
import {
  computeQuarterlyGradeMassBalance,
  aggregateGradeMassBalanceByGrade,
  gradeMassBalanceDeficitLimitTonnes
} from "./gradeMassBalance";

export type { QuarterlyGradeMassBalanceRow, GradeMassBalanceByGradeRow } from "./gradeMassBalance";
export {
  computeQuarterlyGradeMassBalance,
  aggregateGradeMassBalanceByGrade,
  gradeMassBalanceDeficitLimitTonnes
} from "./gradeMassBalance";

const TREND_FRACTION_OF_SCALE = 0.01;
const TREND_DIRECTION_AGREEMENT = 0.55;
const PIPELINE_INTERRUPT_THRESHOLD = 0.01;
const BORROWING_LIMIT_THRESHOLD = 0.01;
const CAP_EPS = 1;
const QUARTER_DEFICIT_WARN_EPS = 0.01;

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function halfWindowAvg(series: number[], firstHalf: boolean): number {
  if (series.length === 0) return 0;
  const mid = Math.floor(series.length / 2);
  const slice = firstHalf ? series.slice(0, Math.max(1, mid)) : series.slice(Math.max(0, mid));
  return avg(slice);
}

/** True when the series drifts materially up or down over the horizon (not flat). */
export function isSeriesTrendingUnstable(series: number[], scale: number): boolean {
  if (series.length < 2) return false;
  const ref = Math.max(Math.abs(scale), Math.abs(avg(series)), 1);
  const delta = halfWindowAvg(series, false) - halfWindowAvg(series, true);
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
  const delta = halfWindowAvg(series, false) - halfWindowAvg(series, true);
  return delta >= 0 ? "increasing" : "decreasing";
}

function countPipelineInterruptedHours(
  customers: Customer[],
  log: SimulationLogRow[],
  config: SimulationConfig,
  hasPipeline: boolean
): number {
  if (!hasPipeline || log.length === 0) return 0;
  const cap = config.totalStorageCapacity ?? 100_000;
  const hasInbound = totalInboundPipelineTph(customers, config) > 0;
  const hasOutbound = totalOutboundPipelineTph(customers, config) > 0;
  let count = 0;
  for (const row of log) {
    const total = row.terminalTotal ?? 0;
    const interrupted =
      (hasInbound && total >= cap - CAP_EPS) || (hasOutbound && total <= CAP_EPS);
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

import type { FeasibilityWarning } from "./feasibility";
import { type FeasibilitySeverity } from "./feasibility";

function warningCfg(
  config: SimulationConfig,
  key: string
): { enabled: boolean; severity: FeasibilitySeverity; threshold?: number } {
  const row = config.feasibilityWarnings?.[key];
  return {
    enabled: row?.enabled !== false,
    severity: row?.severity === "red" ? "red" : "amber",
    threshold: typeof row?.threshold === "number" && Number.isFinite(row.threshold) ? row.threshold : undefined
  };
}

export function runPostRunFeasibilityChecks(
  customers: Customer[],
  config: SimulationConfig,
  simulationLog: SimulationLogRow[],
  scheduledSlots: ScheduledSlot[] = []
): FeasibilityWarning[] {
  const warnings: FeasibilityWarning[] = [];
  if (simulationLog.length === 0) return warnings;

  const totalHours = simulationLog.length;
  const hasPipeline =
    totalInboundPipelineTph(customers, config) > 0 ||
    totalOutboundPipelineTph(customers, config) > 0;

  const terminalSeries = simulationLog.map((r) => r.terminalTotal ?? 0);
  const terminalScale = config.totalStorageCapacity ?? 100_000;
  if (isSeriesTrendingUnstable(terminalSeries, terminalScale)) {
    const dir = trendDirectionLabel(terminalSeries);
    const w = warningCfg(config, "terminal_inventory_trending");
    if (w.enabled) {
      warnings.push({
        key: "terminal_inventory_trending",
        severity: w.severity,
        message: `Terminal inventory is ${dir} over the simulation period (not stable). Check inbound/outbound balance and storage mode.`
      });
    }
  }

  const terminalDocSeries = simulationLog
    .map((r) => r.averageCustomerDaysOfCover)
    .filter((d): d is number => d != null && Number.isFinite(d));
  if (terminalDocSeries.length >= 2 && isSeriesTrendingUnstable(terminalDocSeries, avg(terminalDocSeries))) {
    const dir = trendDirectionLabel(terminalDocSeries);
    const w = warningCfg(config, "average_doc_trending");
    if (w.enabled) {
      warnings.push({
        key: "average_doc_trending",
        severity: w.severity,
        message: `Average days of cover is ${dir} over the simulation period (not stable).`
      });
    }
  }

  for (const c of customers) {
    const invSeries = simulationLog.map((r) => r.customerInventories[c.id] ?? 0);
    const scale = getCustomerMaxCapacity(c, config) || terminalScale;
    if (isSeriesTrendingUnstable(invSeries, scale)) {
      const dir = trendDirectionLabel(invSeries);
      const w = warningCfg(config, "customer_inventory_trending");
      if (w.enabled) {
        warnings.push({
          key: "customer_inventory_trending",
          severity: w.severity,
          message: `Customer ${c.name}: inventory is ${dir} over the simulation period (not stable).`
        });
      }
    }

    const docSeries = customerDocSeries(simulationLog, c.id);
    if (docSeries.length >= 2 && isSeriesTrendingUnstable(docSeries, avg(docSeries))) {
      const dir = trendDirectionLabel(docSeries);
      const w = warningCfg(config, "customer_doc_trending");
      if (w.enabled) {
        warnings.push({
          key: "customer_doc_trending",
          severity: w.severity,
          message: `Customer ${c.name}: days of cover is ${dir} over the simulation period (not stable).`
        });
      }
    }
  }

  const pipelineInterrupted = countPipelineInterruptedHours(
    customers,
    simulationLog,
    config,
    hasPipeline
  );
  const pipelineThreshold = warningCfg(config, "pipeline_interrupted").threshold ?? (PIPELINE_INTERRUPT_THRESHOLD * 100);
  if (hasPipeline && (pipelineInterrupted / totalHours) * 100 > pipelineThreshold) {
    const pct = ((pipelineInterrupted / totalHours) * 100).toFixed(1);
    const hasInbound = totalInboundPipelineTph(customers, config) > 0;
    const hasOutbound = totalOutboundPipelineTph(customers, config) > 0;
    const reason =
      hasInbound && hasOutbound
        ? "terminal at capacity or empty (tank top/bottom)"
        : hasOutbound
          ? "terminal inventory at bottom (tank empty)"
          : "terminal at storage capacity (tank full)";
    const w = warningCfg(config, "pipeline_interrupted");
    if (w.enabled) {
      warnings.push({
        key: "pipeline_interrupted",
        severity: w.severity,
        message: `Pipeline was interrupted ${pct}% of the simulation (${pipelineInterrupted} of ${totalHours} hours) due to ${reason}.`
      });
    }
  }

  const borrowingHours = countBorrowingLimitHours(simulationLog, customers, config);
  const borrowingThreshold = warningCfg(config, "borrowing_limit_reached").threshold ?? (BORROWING_LIMIT_THRESHOLD * 100);
  if ((borrowingHours / totalHours) * 100 > borrowingThreshold) {
    const pct = ((borrowingHours / totalHours) * 100).toFixed(1);
    const limit = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
    const w = warningCfg(config, "borrowing_limit_reached");
    if (w.enabled) {
      warnings.push({
        key: "borrowing_limit_reached",
        severity: w.severity,
        message: `Customer borrowing limit (−${Math.round(limit).toLocaleString()} t) was reached ${pct}% of the simulation (${borrowingHours} of ${totalHours} hours).`
      });
    }
  }

  if (config.gradeMassBalancingEnabled) {
    const detailRows = computeQuarterlyGradeMassBalance(
      customers,
      config,
      scheduledSlots,
      simulationLog
    );
    const quarters = aggregateGradeMassBalanceByGrade(detailRows);
    const breaches = quarters.filter((q) => {
      const limit = gradeMassBalanceDeficitLimitTonnes(config, q.inboundTonnes);
      return q.endBalanceTonnes < -limit - QUARTER_DEFICIT_WARN_EPS;
    });
    if (breaches.length > 0) {
      const worst = breaches.reduce((a, b) => (a.endBalanceTonnes < b.endBalanceTonnes ? a : b));
      const worstLimit = gradeMassBalanceDeficitLimitTonnes(config, worst.inboundTonnes);
      const limitLabel =
        (config.gradeMassBalanceDeficitMode ?? "tonnes") === "percent"
          ? `${config.gradeMassBalanceDeficitLimitPct ?? 0}% of quarter inbound`
          : `−${Math.round(worstLimit).toLocaleString()} t`;
      const w = warningCfg(config, "grade_mass_balance_deficit");
      if (w.enabled) {
        warnings.push({
          key: "grade_mass_balance_deficit",
          severity: w.severity,
          message: `Grade mass-balance quarter-end deficit: ${breaches.length} grade-quarter(s) below ${limitLabel}. Worst: ${worst.grade} ${worst.quarterLabel} = ${Math.round(worst.endBalanceTonnes).toLocaleString()} t.`
        });
      }
    }
  }

  return warnings;
}
