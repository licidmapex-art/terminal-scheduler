/**
 * Pacer allowance and pacing % — aligned with scheduler.ts pace_ahead checks.
 */

import type { Customer, ScheduledSlot, SimulationConfig } from "../types";
import {
  getCustomerMaxCapacity,
  isTerminalTankBottom,
  isTerminalTankTop
} from "./inventory";
import {
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane
} from "./customerLegTargets";

const HOUR_MS = 60 * 60 * 1000;

export interface PacerDirectionSettings {
  roundAtDecile: number;
  allowance: number;
}

function normalizePacerDecile(raw: number | undefined, fallback = 1): number {
  const d = Math.round(raw ?? fallback);
  return Number.isFinite(d) ? Math.min(9, Math.max(1, d)) : fallback;
}

function normalizePacerAllowance(raw: number | undefined, fallback = 0.5): number {
  const a = Number(raw ?? fallback);
  return Number.isFinite(a) ? a : fallback;
}

/** Per-direction pacer inputs (inbound vs outbound may differ for inventory buffer). */
export function pacerSettingsForDirection(
  config: SimulationConfig,
  direction: "inbound" | "outbound"
): PacerDirectionSettings {
  const legacyDecile = normalizePacerDecile(config.pacerRoundAtDecile);
  if (direction === "inbound") {
    return {
      roundAtDecile: normalizePacerDecile(config.pacerInboundRoundAtDecile, legacyDecile),
      allowance: normalizePacerAllowance(config.pacerInboundAllowance, 0.5)
    };
  }
  return {
    roundAtDecile: normalizePacerDecile(config.pacerOutboundRoundAtDecile, legacyDecile),
    allowance: normalizePacerAllowance(config.pacerOutboundAllowance, 0.5)
  };
}

/** Continuous pace target at hour {@code h} before decile rounding. */
export function pacerContinuousTarget(
  h: number,
  periodHours: number,
  effTarget: number,
  direction: "inbound" | "outbound",
  config: SimulationConfig
): number {
  const periodHoursSafe = Math.max(periodHours, 1);
  const { allowance } = pacerSettingsForDirection(config, direction);
  return (h / periodHoursSafe) * effTarget + allowance;
}

/** Round up to the next whole slot once fractional pace reaches {@code roundAtDecile / 10}. */
export function paceAllowanceSlots(
  paceTargetContinuous: number,
  roundAtDecile: number
): number {
  const whole = Math.floor(paceTargetContinuous);
  const frac = paceTargetContinuous - whole;
  const decile = normalizePacerDecile(roundAtDecile) / 10;
  return Math.max(0, whole + (frac >= decile ? 1 : 0));
}

export function paceAllowanceForDirection(
  h: number,
  periodHours: number,
  effTarget: number,
  direction: "inbound" | "outbound",
  config: SimulationConfig
): { continuous: number; allowance: number; settings: PacerDirectionSettings } {
  const settings = pacerSettingsForDirection(config, direction);
  const continuous = pacerContinuousTarget(h, periodHours, effTarget, direction, config);
  return {
    continuous,
    allowance: paceAllowanceSlots(continuous, settings.roundAtDecile),
    settings
  };
}

/**
 * Whether the pacer may block this leg at this hour. Disapplied when inbound at terminal tank
 * bottom or outbound at terminal tank top for any evaluated inventory snapshot (hour start
 * and/or after pipeline before new slots).
 */
export function pacerAppliesForLeg(
  direction: "inbound" | "outbound",
  config: SimulationConfig,
  terminalTotal: number,
  _customerInventory: number,
  _customerMax: number
): boolean {
  const cap = config.totalStorageCapacity ?? 100_000;

  if (direction === "inbound") {
    if (isTerminalTankBottom(terminalTotal)) return false;
    return true;
  }
  if (isTerminalTankTop(terminalTotal, cap)) return false;
  return true;
}

export interface PacerInventorySnapshot {
  terminalRefTotal: number;
  invById: Record<string, number>;
}

/** True when pacer may block — false if any snapshot is at a tank extreme that waives pacing. */
export function pacerAppliesAtBookingTime(
  direction: "inbound" | "outbound",
  config: SimulationConfig,
  customer: Customer,
  customers: Customer[],
  snapshots: PacerInventorySnapshot[]
): boolean {
  for (const snap of snapshots) {
    const ctx = pacerInventoryContext(
      config,
      customer,
      customers,
      snap.terminalRefTotal,
      snap.invById
    );
    if (
      !pacerAppliesForLeg(
        direction,
        config,
        ctx.terminalTotal,
        ctx.customerInventory,
        ctx.customerMax
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Resolve terminal total and customer inventory for {@link pacerAppliesForLeg}. */
export function pacerInventoryContext(
  config: SimulationConfig,
  customer: Customer,
  customers: Customer[],
  terminalRefTotal: number,
  customerInvById: Record<string, number>
): { terminalTotal: number; customerInventory: number; customerMax: number } {
  const mode = config.storageMode ?? "fixed_band";
  const customerMax = getCustomerMaxCapacity(customer, config);
  const customerInventory = customerInvById[customer.id] ?? 0;
  if (mode === "shared_inventory") {
    return {
      terminalTotal: customers.reduce((s, c) => s + (customerInvById[c.id] ?? 0), 0),
      customerInventory,
      customerMax
    };
  }
  if (mode === "shared_shipping") {
    return { terminalTotal: terminalRefTotal, customerInventory, customerMax };
  }
  return { terminalTotal: customerInventory, customerInventory, customerMax };
}

function slotStartHour(slot: ScheduledSlot, simStartMs: number): number {
  return Math.round((new Date(slot.start).getTime() - simStartMs) / HOUR_MS);
}

function directionModeKey(direction: "inbound" | "outbound", mode: string): string {
  return `${direction}:${mode}`;
}

function countSlotsStartedByDirectionMode(
  customerId: string,
  direction: "inbound" | "outbound",
  mode: string,
  h: number,
  slots: ScheduledSlot[],
  simStartMs: number
): number {
  if (h < 0) return 0;
  return slots.filter((s) => {
    if (s.customerId !== customerId || s.direction !== direction || s.mode !== mode) return false;
    return slotStartHour(s, simStartMs) <= h;
  }).length;
}

/** Human label for legend, e.g. "inbound · ship". */
export function formatDirectionModeLabel(directionModeKeyStr: string): string {
  const [direction, mode] = directionModeKeyStr.split(":");
  if (!direction || !mode) return directionModeKeyStr;
  return `${direction} · ${mode}`;
}

export interface PacingLegTarget {
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  laneIndex: number;
  targetSlots: number;
}

function pacingLegTargets(customer: Customer, config: SimulationConfig, periodHours: number): PacingLegTarget[] {
  const legs: PacingLegTarget[] = [];
  for (const t of inboundTargetSlotsByLane(customer, periodHours)) {
    if (t.targetSlots <= 0) continue;
    legs.push({
      direction: "inbound",
      mode: t.mode,
      laneIndex: t.laneIndex,
      targetSlots: t.targetSlots
    });
  }
  for (const t of outboundTargetSlotsByLane(customer, config, periodHours)) {
    if (t.targetSlots <= 0) continue;
    legs.push({
      direction: "outbound",
      mode: t.mode,
      laneIndex: t.laneIndex,
      targetSlots: t.targetSlots
    });
  }
  return legs;
}

interface DirectionModeBucket {
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  targetSlots: number;
}

function pacingDirectionModeBuckets(
  customer: Customer,
  config: SimulationConfig,
  periodHours: number
): Map<string, DirectionModeBucket> {
  const buckets = new Map<string, DirectionModeBucket>();
  for (const leg of pacingLegTargets(customer, config, periodHours)) {
    const dk = directionModeKey(leg.direction, leg.mode);
    const existing = buckets.get(dk);
    if (existing) {
      existing.targetSlots += leg.targetSlots;
    } else {
      buckets.set(dk, {
        direction: leg.direction,
        mode: leg.mode,
        targetSlots: leg.targetSlots
      });
    }
  }
  return buckets;
}

/**
 * Hourly pacing % per direction+mode (scheduler pacer is mode-specific).
 * Key: "inbound:ship", "outbound:barge", etc.
 */
export function customerPacingPctByDirectionMode(
  customer: Customer,
  config: SimulationConfig,
  periodHours: number,
  slots: ScheduledSlot[],
  maxHour: number,
  simStartMs: number
): Record<string, number[]> | null {
  const periodHoursSafe = Math.max(periodHours, 1);
  const buckets = pacingDirectionModeBuckets(customer, config, periodHoursSafe);
  if (buckets.size === 0) return null;

  const custSlots = slots.filter((s) => s.customerId === customer.id);
  const out: Record<string, number[]> = {};

  for (const [dk, bucket] of buckets) {
    const series: number[] = [];
    for (let h = 0; h <= maxHour; h++) {
      const { allowance: foreseen } = paceAllowanceForDirection(
        h,
        periodHoursSafe,
        bucket.targetSlots,
        bucket.direction,
        config
      );
      const allocated = countSlotsStartedByDirectionMode(
        customer.id,
        bucket.direction,
        bucket.mode,
        h,
        custSlots,
        simStartMs
      );
      if (foreseen <= 0) {
        series.push(0);
        continue;
      }
      series.push(Math.round((allocated / foreseen) * 1000) / 10);
    }
    out[dk] = series;
  }
  return out;
}
