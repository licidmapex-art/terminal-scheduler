/**
 * Pacer allowance and pacing % — aligned with scheduler.ts pace_ahead checks.
 */

import type { Customer, ScheduledSlot, SimulationConfig } from "../types";
import {
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane
} from "./customerLegTargets";

const HOUR_MS = 60 * 60 * 1000;

function normalizedPacerDecile(config: SimulationConfig): number {
  const raw = Math.round(config.pacerRoundAtDecile ?? 1);
  return Number.isFinite(raw) ? Math.min(9, Math.max(1, raw)) : 1;
}

/** Same rounding as runScheduler / buildTransportStatuses pace_ahead. */
export function paceAllowanceSlots(
  paceTargetContinuous: number,
  config: SimulationConfig
): number {
  const whole = Math.floor(paceTargetContinuous);
  const frac = paceTargetContinuous - whole;
  const decile = normalizedPacerDecile(config) / 10;
  const mode = config.pacerRoundingDirection === "down" ? "down" : "up";
  if (mode === "up") {
    return whole + (frac >= decile ? 1 : 0);
  }
  return whole + (frac > 1 - decile ? 1 : 0);
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
      const paceTargetContinuous = (h / periodHoursSafe) * bucket.targetSlots + 1;
      const foreseen = paceAllowanceSlots(paceTargetContinuous, config);
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
