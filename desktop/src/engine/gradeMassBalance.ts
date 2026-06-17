/**
 * Grade mass-balance helpers — customer grade shares attribute flows; balances are per grade (terminal-wide).
 */

import type { Customer, ScheduledSlot, SimulationConfig } from "../types";
import type { SimulationLogRow } from "./simulationLog";
import { getCargoWindowMs, laytimeFromConfig } from "./slotLaytime";

export type SustainabilityGrade = "green" | "blue" | "grey";

export const SUSTAINABILITY_GRADES: SustainabilityGrade[] = ["green", "blue", "grey"];

export const GRADE_COLORS: Record<SustainabilityGrade, string> = {
  green: "#22c55e",
  blue: "#3b82f6",
  grey: "#94a3b8"
};

export interface CustomerGradeShares {
  green: number;
  blue: number;
  grey: number;
}

export function customerGradeShares(customer: Customer): CustomerGradeShares {
  const green = Math.max(0, customer.gradeGreenPct ?? 0);
  const blue = Math.max(0, customer.gradeBluePct ?? 0);
  const grey = Math.max(0, customer.gradeGreyPct ?? 0);
  const sum = green + blue + grey;
  if (sum <= 0) return { green: 0, blue: 0, grey: 0 };
  return {
    green: (green / sum) * 100,
    blue: (blue / sum) * 100,
    grey: (grey / sum) * 100
  };
}

export function shareForGrade(shares: CustomerGradeShares, grade: SustainabilityGrade): number {
  return shares[grade] / 100;
}

export function validateCustomerGradeShares(
  green: number,
  blue: number,
  grey: number
): string | null {
  if (![green, blue, grey].every((v) => Number.isFinite(v) && v >= 0 && v <= 100)) {
    return "Grade shares must be between 0 and 100";
  }
  const sum = green + blue + grey;
  if (Math.abs(sum - 100) > 0.01) {
    return `Grade shares must sum to 100% (currently ${sum.toFixed(1)}%)`;
  }
  if (green + blue + grey <= 0) {
    return "At least one grade share must be greater than 0";
  }
  return null;
}

export interface GradeQuarterCustomerPart {
  customerId: string;
  customerName: string;
  inboundTonnes: number;
  outboundTonnes: number;
}

/** Terminal-wide grade ledger for one calendar quarter (all customers combined). */
export interface GradeMassBalanceByGradeRow {
  grade: SustainabilityGrade;
  quarterLabel: string;
  periodStart: Date;
  periodEnd: Date;
  inboundTonnes: number;
  outboundTonnes: number;
  endBalanceTonnes: number;
  deficitTonnes: number;
  customerParts: GradeQuarterCustomerPart[];
}

export function aggregateGradeMassBalanceByGrade(
  rows: QuarterlyGradeMassBalanceRow[]
): GradeMassBalanceByGradeRow[] {
  const map = new Map<string, GradeMassBalanceByGradeRow>();

  for (const r of rows) {
    const key = `${r.grade}|${r.quarterLabel}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        grade: r.grade,
        quarterLabel: r.quarterLabel,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        inboundTonnes: 0,
        outboundTonnes: 0,
        endBalanceTonnes: 0,
        deficitTonnes: 0,
        customerParts: []
      };
      map.set(key, agg);
    }
    agg.inboundTonnes += r.inboundTonnes;
    agg.outboundTonnes += r.outboundTonnes;
    if (r.inboundTonnes > 0 || r.outboundTonnes > 0) {
      agg.customerParts.push({
        customerId: r.customerId,
        customerName: r.customerName,
        inboundTonnes: r.inboundTonnes,
        outboundTonnes: r.outboundTonnes
      });
    }
  }

  for (const agg of map.values()) {
    agg.endBalanceTonnes = agg.inboundTonnes - agg.outboundTonnes;
    agg.deficitTonnes = Math.max(0, -agg.endBalanceTonnes);
  }

  return [...map.values()].sort((a, b) => {
    const t = a.periodStart.getTime() - b.periodStart.getTime();
    if (t !== 0) return t;
    return SUSTAINABILITY_GRADES.indexOf(a.grade) - SUSTAINABILITY_GRADES.indexOf(b.grade);
  });
}

export interface QuarterlyGradeMassBalanceRow {
  customerId: string;
  customerName: string;
  grade: SustainabilityGrade;
  quarterLabel: string;
  periodStart: Date;
  periodEnd: Date;
  inboundTonnes: number;
  outboundTonnes: number;
  endBalanceTonnes: number;
  deficitTonnes: number;
}

const FLOW_EPS = 0.01;

function quarterStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1, 0, 0, 0, 0));
}

function addQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1, 0, 0, 0, 0));
}

function quarterLabel(d: Date): string {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

function overlapFraction(
  startMs: number,
  endMs: number,
  periodStartMs: number,
  periodEndMs: number
): number {
  const overlapStart = Math.max(startMs, periodStartMs);
  const overlapEnd = Math.min(endMs, periodEndMs);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const total = Math.max(0, endMs - startMs);
  if (total <= 0) return 0;
  return overlap / total;
}

function hourInPeriod(hour: number, simStartMs: number, periodStartMs: number, periodEndMs: number): boolean {
  const hourStart = simStartMs + hour * 60 * 60 * 1000;
  const hourEnd = hourStart + 60 * 60 * 1000;
  return hourEnd > periodStartMs && hourStart < periodEndMs;
}

function hourOverlapFraction(
  hour: number,
  simStartMs: number,
  periodStartMs: number,
  periodEndMs: number
): number {
  const hourStart = simStartMs + hour * 60 * 60 * 1000;
  const hourEnd = hourStart + 60 * 60 * 1000;
  return overlapFraction(hourStart, hourEnd, periodStartMs, periodEndMs);
}

export function gradeMassBalanceDeficitLimitTonnes(
  config: SimulationConfig,
  quarterInboundTonnes: number
): number {
  const mode = config.gradeMassBalanceDeficitMode ?? "tonnes";
  if (mode === "percent") {
    const pct = Math.max(0, config.gradeMassBalanceDeficitLimitPct ?? 0);
    return (quarterInboundTonnes * pct) / 100;
  }
  return Math.max(0, config.gradeMassBalanceDeficitLimitTonnes ?? 0);
}

export function computeQuarterlyGradeMassBalance(
  customers: Customer[],
  config: SimulationConfig,
  scheduledSlots: ScheduledSlot[],
  simulationLog: SimulationLogRow[] = []
): QuarterlyGradeMassBalanceRow[] {
  if (!config.gradeMassBalancingEnabled) return [];
  const simStartMs = new Date(config.startDate).getTime();
  const simEndMs = new Date(config.endDate).getTime();
  if (!Number.isFinite(simStartMs) || !Number.isFinite(simEndMs) || simEndMs <= simStartMs) return [];

  const { preOps, postOps } = laytimeFromConfig(config);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const sharesByCustomer = new Map(customers.map((c) => [c.id, customerGradeShares(c)]));

  const periods: Array<{ start: Date; end: Date; label: string }> = [];
  for (let cur = quarterStart(new Date(simStartMs)); cur.getTime() < simEndMs; cur = addQuarter(cur)) {
    const end = addQuarter(cur);
    const clippedStart = new Date(Math.max(cur.getTime(), simStartMs));
    const clippedEnd = new Date(Math.min(end.getTime(), simEndMs));
    if (clippedEnd.getTime() > clippedStart.getTime()) {
      periods.push({ start: clippedStart, end: clippedEnd, label: quarterLabel(cur) });
    }
  }

  const rows: QuarterlyGradeMassBalanceRow[] = [];

  for (const period of periods) {
    const periodStartMs = period.start.getTime();
    const periodEndMs = period.end.getTime();
    const inboundByKey = new Map<string, number>();
    const outboundByKey = new Map<string, number>();

    for (const slot of scheduledSlots) {
      const shares = sharesByCustomer.get(slot.customerId);
      if (!shares) continue;
      const { cargoStartMs, cargoEndMs } = getCargoWindowMs(slot, preOps, postOps);
      const frac = overlapFraction(cargoStartMs, cargoEndMs, periodStartMs, periodEndMs);
      if (frac <= 0) continue;
      const vol = slot.volume * frac;
      for (const grade of SUSTAINABILITY_GRADES) {
        const part = vol * shareForGrade(shares, grade);
        if (part <= 0) continue;
        const key = `${slot.customerId}|${grade}`;
        if (slot.direction === "inbound") {
          inboundByKey.set(key, (inboundByKey.get(key) ?? 0) + part);
        } else {
          outboundByKey.set(key, (outboundByKey.get(key) ?? 0) + part);
        }
      }
    }

    for (const row of simulationLog) {
      if (row.hour <= 0) continue;
      if (!hourInPeriod(row.hour, simStartMs, periodStartMs, periodEndMs)) continue;
      const hourFrac = hourOverlapFraction(row.hour, simStartMs, periodStartMs, periodEndMs);
      if (hourFrac <= 0) continue;
      for (const [customerId, flow] of Object.entries(row.pipelineFlow ?? {})) {
        const shares = sharesByCustomer.get(customerId);
        if (!shares || flow === 0) continue;
        const tonnes = Math.abs(flow) * hourFrac;
        for (const grade of SUSTAINABILITY_GRADES) {
          const part = tonnes * shareForGrade(shares, grade);
          if (part <= 0) continue;
          const key = `${customerId}|${grade}`;
          if (flow > 0) {
            inboundByKey.set(key, (inboundByKey.get(key) ?? 0) + part);
          } else {
            outboundByKey.set(key, (outboundByKey.get(key) ?? 0) + part);
          }
        }
      }
    }

    for (const c of customers) {
      for (const grade of SUSTAINABILITY_GRADES) {
        const key = `${c.id}|${grade}`;
        const inboundTonnes = inboundByKey.get(key) ?? 0;
        const outboundTonnes = outboundByKey.get(key) ?? 0;
        const endBalanceTonnes = inboundTonnes - outboundTonnes;
        if (inboundTonnes < FLOW_EPS && outboundTonnes < FLOW_EPS) continue;
        rows.push({
          customerId: c.id,
          customerName: customerNameById.get(c.id) ?? c.id,
          grade,
          quarterLabel: period.label,
          periodStart: period.start,
          periodEnd: period.end,
          inboundTonnes: Math.round(inboundTonnes),
          outboundTonnes: Math.round(outboundTonnes),
          endBalanceTonnes: Math.round(endBalanceTonnes),
          deficitTonnes: Math.round(Math.max(0, -endBalanceTonnes))
        });
      }
    }
  }

  return rows;
}
