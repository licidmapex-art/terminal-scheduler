/**
 * Per-customer per-grade attributed inventory ledger (shared mode borrowing).
 */

import type { Customer, SimulationConfig, SustainabilityGrade } from "../types";
import type { SimulationLogRow } from "./simulationLog";
import {
  SUSTAINABILITY_GRADES,
  customerGradeShares,
  shareForGrade
} from "./gradeMassBalance";

export type GradeInventoryLedger = Record<string, Record<SustainabilityGrade, number>>;

/** Hourly series per customer per grade (aligned with total inventory timeline). */
export type GradeLedgerTimeline = Record<string, Record<SustainabilityGrade, number[]>>;

export type CustomerGradeInventories = Record<SustainabilityGrade, number>;
export type GradeLedgerSnapshot = Record<string, CustomerGradeInventories>;

const EPS = 1e-6;

function emptyGradeRow(): Record<SustainabilityGrade, number> {
  return { green: 0, blue: 0, grey: 0 };
}

export function customerHasGradeMix(customer: Customer): boolean {
  const green = Math.max(0, customer.gradeGreenPct ?? 0);
  const blue = Math.max(0, customer.gradeBluePct ?? 0);
  const grey = Math.max(0, customer.gradeGreyPct ?? 0);
  return green + blue + grey > EPS;
}

export function initGradeInventoryLedger(customers: Customer[]): GradeInventoryLedger {
  const ledger: GradeInventoryLedger = {};
  for (const c of customers) {
    const shares = customerGradeShares(c);
    const row = emptyGradeRow();
    if (customerHasGradeMix(c)) {
      for (const g of SUSTAINABILITY_GRADES) {
        row[g] = c.currentInventory * shareForGrade(shares, g);
      }
    } else {
      row.grey = c.currentInventory;
    }
    ledger[c.id] = row;
  }
  return ledger;
}

export function gradeLedgerTotal(row: Record<SustainabilityGrade, number> | undefined): number {
  if (!row) return 0;
  return row.green + row.blue + row.grey;
}

export function applyGradeAttributedFlow(
  ledger: GradeInventoryLedger,
  customer: Customer,
  tonnes: number,
  direction: "inbound" | "outbound"
): void {
  if (tonnes <= 0) return;
  const sign = direction === "inbound" ? 1 : -1;
  const row = ledger[customer.id] ?? emptyGradeRow();
  if (!customerHasGradeMix(customer)) {
    row.grey = (row.grey ?? 0) + sign * tonnes;
    ledger[customer.id] = row;
    return;
  }
  const shares = customerGradeShares(customer);
  for (const g of SUSTAINABILITY_GRADES) {
    row[g] = (row[g] ?? 0) + sign * tonnes * shareForGrade(shares, g);
  }
  ledger[customer.id] = row;
}

export function scaleCustomerGradeLedger(
  ledger: GradeInventoryLedger,
  customer: Customer,
  newTotal: number,
  oldTotal: number
): void {
  const row = ledger[customer.id];
  if (!row || Math.abs(oldTotal) <= EPS) return;
  const scale = newTotal / oldTotal;
  for (const g of SUSTAINABILITY_GRADES) {
    row[g] *= scale;
  }
}

export function gradesSubjectToFloor(config: SimulationConfig): SustainabilityGrade[] {
  const scope = config.borrowingGradeScope ?? "all";
  if (scope === "selected_grades") {
    const sel = config.selectedBorrowingGrades;
    return sel && sel.length > 0 ? sel : [...SUSTAINABILITY_GRADES];
  }
  return [...SUSTAINABILITY_GRADES];
}

export function deficitLimitForGrade(
  config: SimulationConfig,
  customer: Customer,
  grade: SustainabilityGrade
): number {
  const explicit = config.perGradeDeficitLimitTonnes?.[grade];
  if (explicit !== undefined && Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }
  const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
  if (x <= 0) return 0;
  if (!customerHasGradeMix(customer)) return x;
  const shares = customerGradeShares(customer);
  return x * shareForGrade(shares, grade);
}

function otherCustomersGradeSurplus(
  grade: SustainabilityGrade,
  customerId: string,
  ledger: GradeInventoryLedger,
  customers: Customer[]
): number {
  let surplus = 0;
  for (const c of customers) {
    if (c.id === customerId) continue;
    surplus += Math.max(0, ledger[c.id]?.[grade] ?? 0);
  }
  return surplus;
}

/** Max outbound tonnes (pipeline or berth) without breaching grade borrowing rules. */
export function maxOutboundTonnesWithinGradeFloor(
  customer: Customer,
  proposedTonnes: number,
  ledger: GradeInventoryLedger,
  config: SimulationConfig,
  customers: Customer[]
): number {
  const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
  const hasPerGrade = config.perGradeDeficitLimitTonnes != null;
  if (x <= 0 && !hasPerGrade) return proposedTonnes;

  let maxT = proposedTonnes;
  const row = ledger[customer.id] ?? emptyGradeRow();
  const scope = config.borrowingGradeScope ?? "all";
  const subject = gradesSubjectToFloor(config);

  if (!customerHasGradeMix(customer)) {
    const total = gradeLedgerTotal(row);
    if (x > 0) maxT = Math.min(maxT, total + x);
    return Math.max(0, maxT);
  }

  const shares = customerGradeShares(customer);
  for (const g of subject) {
    const frac = shareForGrade(shares, g);
    if (frac <= EPS) continue;
    const limit = deficitLimitForGrade(config, customer, g);
    if (limit <= 0 && x <= 0) continue;
    let gradeMax = (row[g] + limit) / frac;
    if (scope === "same_grade") {
      const donor = otherCustomersGradeSurplus(g, customer.id, ledger, customers);
      gradeMax = Math.min(gradeMax, (row[g] + limit + donor) / frac);
    }
    maxT = Math.min(maxT, gradeMax);
  }
  return Math.max(0, maxT);
}

export function outboundBreachesGradeFloor(
  customer: Customer,
  mepsTonnes: number,
  ledger: GradeInventoryLedger,
  config: SimulationConfig,
  customers: Customer[]
): { blocked: boolean; detail: string | null } {
  const allowed = maxOutboundTonnesWithinGradeFloor(
    customer,
    mepsTonnes,
    ledger,
    config,
    customers
  );
  if (allowed + EPS >= mepsTonnes) {
    return { blocked: false, detail: null };
  }
  const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
  const scope = config.borrowingGradeScope ?? "all";
  if (scope === "same_grade") {
    return {
      blocked: true,
      detail: `grade borrowing blocked — insufficient same-grade donor surplus for ${mepsTonnes.toLocaleString()}t parcel (max ${Math.floor(allowed)}t)`
    };
  }
  return {
    blocked: true,
    detail: `grade floor −${x.toLocaleString()}t — parcel would breach per-grade attributed balance (max ${Math.floor(allowed)}t)`
  };
}

export function sharedInventoryFloorBlocks(
  customer: Customer,
  mepsTonnes: number,
  attributedInv: number,
  ledger: GradeInventoryLedger | null,
  config: SimulationConfig,
  customers: Customer[]
): { blocked: boolean; detail: string | null } {
  const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
  const hasPerGrade = config.perGradeDeficitLimitTonnes != null;
  if (x <= 0 && !hasPerGrade) {
    return { blocked: false, detail: null };
  }

  if (ledger && (customerHasGradeMix(customer) || hasPerGrade)) {
    return outboundBreachesGradeFloor(customer, mepsTonnes, ledger, config, customers);
  }

  if (x > 0 && attributedInv - mepsTonnes < -x) {
    const after = attributedInv - mepsTonnes;
    return {
      blocked: true,
      detail: `floor −${x.toLocaleString()}t — booking balance would be ${after.toFixed(0)}t`
    };
  }
  return { blocked: false, detail: null };
}

export function snapshotGradeLedger(
  ledger: GradeInventoryLedger,
  customers: Customer[]
): GradeLedgerSnapshot {
  const out: GradeLedgerSnapshot = {};
  for (const c of customers) {
    const row = ledger[c.id];
    if (!row) continue;
    out[c.id] = {
      green: Math.round(row.green),
      blue: Math.round(row.blue),
      grey: Math.round(row.grey)
    };
  }
  return out;
}

export function initGradeLedgerTimeline(customers: Customer[]): GradeLedgerTimeline {
  const tl: GradeLedgerTimeline = {};
  for (const c of customers) {
    tl[c.id] = { green: [], blue: [], grey: [] };
  }
  return tl;
}

export function pushGradeLedgerHour(
  timeline: GradeLedgerTimeline,
  ledger: GradeInventoryLedger,
  customers: Customer[]
): void {
  for (const c of customers) {
    const row = ledger[c.id] ?? emptyGradeRow();
    const series = timeline[c.id];
    if (!series) continue;
    series.green.push(Math.round(row.green));
    series.blue.push(Math.round(row.blue));
    series.grey.push(Math.round(row.grey));
  }
}

export interface GradeStockSummaryRow {
  customerId: string;
  customerName: string;
  grade: SustainabilityGrade;
  opening: number;
  min: number;
  final: number;
  floorLimit: number;
  /** Minimum attributed stock minus floor (negative = breached floor at some hour). */
  minHeadroom: number;
}

export function summarizeGradeLedgerTimeline(
  customers: Customer[],
  config: SimulationConfig,
  gradeTimeline: GradeLedgerTimeline
): GradeStockSummaryRow[] {
  const rows: GradeStockSummaryRow[] = [];
  const nameById = new Map(customers.map((c) => [c.id, c.name]));
  for (const c of customers) {
    const series = gradeTimeline[c.id];
    if (!series) continue;
    for (const grade of SUSTAINABILITY_GRADES) {
      const vals = series[grade];
      if (!vals?.length) continue;
      const opening = vals[0] ?? 0;
      const final = vals[vals.length - 1] ?? 0;
      const min = vals.reduce((m, v) => Math.min(m, v), opening);
      const floorLimit = deficitLimitForGrade(config, c, grade);
      rows.push({
        customerId: c.id,
        customerName: nameById.get(c.id) ?? c.id,
        grade,
        opening,
        min,
        final,
        floorLimit,
        minHeadroom: Math.round((min + floorLimit) * 10) / 10
      });
    }
  }
  return rows;
}

export interface QuarterlyGradeStockRow {
  grade: SustainabilityGrade;
  quarterLabel: string;
  periodStart: Date;
  periodEnd: Date;
  terminalStockTonnes: number;
  customerStocks: Array<{ customerId: string; customerName: string; tonnes: number }>;
}

function quarterStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1, 0, 0, 0, 0));
}

function addQuarterUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1, 0, 0, 0, 0));
}

function quarterLabelUtc(d: Date): string {
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

/** Terminal-wide attributed grade stock at each quarter end (from simulation log snapshots). */
export function computeQuarterlyAttributedGradeStock(
  customers: Customer[],
  config: SimulationConfig,
  simulationLog: SimulationLogRow[]
): QuarterlyGradeStockRow[] {
  const simStartMs = new Date(config.startDate).getTime();
  const simEndMs = new Date(config.endDate).getTime();
  if (!simulationLog.some((r) => r.customerGradeInventories)) return [];
  if (!Number.isFinite(simStartMs) || !Number.isFinite(simEndMs) || simEndMs <= simStartMs) return [];

  const nameById = new Map(customers.map((c) => [c.id, c.name]));
  const periods: Array<{ start: Date; end: Date; label: string; endHour: number }> = [];

  for (let cur = quarterStartUtc(new Date(simStartMs)); cur.getTime() < simEndMs; cur = addQuarterUtc(cur)) {
    const end = addQuarterUtc(cur);
    const clippedStart = new Date(Math.max(cur.getTime(), simStartMs));
    const clippedEnd = new Date(Math.min(end.getTime(), simEndMs));
    if (clippedEnd.getTime() <= clippedStart.getTime()) continue;
    const endHour = Math.floor((clippedEnd.getTime() - simStartMs) / (60 * 60 * 1000));
    periods.push({ start: clippedStart, end: clippedEnd, label: quarterLabelUtc(cur), endHour });
  }

  const sortedLog = [...simulationLog].sort((a, b) => a.hour - b.hour);
  const rows: QuarterlyGradeStockRow[] = [];

  for (const period of periods) {
    let snapRow: SimulationLogRow | undefined;
    for (const row of sortedLog) {
      if (row.hour <= period.endHour && row.customerGradeInventories) {
        snapRow = row;
      }
    }
    const snap = snapRow?.customerGradeInventories;
    if (!snap) continue;

    for (const grade of SUSTAINABILITY_GRADES) {
      const customerStocks: QuarterlyGradeStockRow["customerStocks"] = [];
      let terminal = 0;
      for (const c of customers) {
        const tonnes = snap[c.id]?.[grade] ?? 0;
        if (tonnes === 0) continue;
        terminal += tonnes;
        customerStocks.push({
          customerId: c.id,
          customerName: nameById.get(c.id) ?? c.id,
          tonnes
        });
      }
      if (terminal <= 0 && customerStocks.length === 0) continue;
      rows.push({
        grade,
        quarterLabel: period.label,
        periodStart: period.start,
        periodEnd: period.end,
        terminalStockTonnes: terminal,
        customerStocks
      });
    }
  }

  return rows;
}
