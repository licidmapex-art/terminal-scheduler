/**
 * Berth occupation vs cargo transfer window (pre-ops / loading / post-ops).
 */

import type { ScheduledSlot } from "../types";

export const HOUR_MS = 60 * 60 * 1000;

export function laytimeFromConfig(config: { preOpsHours?: number; postOpsHours?: number }): {
  preOps: number;
  postOps: number;
} {
  return {
    preOps: Math.max(0, config.preOpsHours ?? 0),
    postOps: Math.max(0, config.postOpsHours ?? 0)
  };
}

/** Cargo window inside occupation [slot.start, slot.end]. */
export function getCargoWindowMs(
  slot: Pick<ScheduledSlot, "start" | "end">,
  preOps: number,
  postOps: number
): { cargoStartMs: number; cargoEndMs: number; loadingHours: number } {
  const startMs = new Date(slot.start).getTime();
  const endMs = new Date(slot.end).getTime();
  const cargoStartMs = startMs + preOps * HOUR_MS;
  const cargoEndMs = endMs - postOps * HOUR_MS;
  const loadingHours = (cargoEndMs - cargoStartMs) / HOUR_MS;
  return { cargoStartMs, cargoEndMs, loadingHours };
}

/**
 * Wall-clock hours the resource is tied up per visit: pre-ops + loading + post-ops.
 * Matches {@link ScheduledSlot} start/end from the scheduler (full laytime, not cargo-only).
 */
export function slotBerthOccupationHours(
  slot: Pick<ScheduledSlot, "start" | "end">,
  config: { preOpsHours?: number; postOpsHours?: number }
): number {
  const { preOps, postOps } = laytimeFromConfig(config);
  const { loadingHours } = getCargoWindowMs(slot, preOps, postOps);
  if (loadingHours > 0) {
    return preOps + postOps + loadingHours;
  }
  const wallMs = new Date(slot.end).getTime() - new Date(slot.start).getTime();
  return Math.max(0, wallMs / HOUR_MS);
}

/** Hour h (integer, [simStart+h·hour, +hour)) overlaps [intervalStartMs, intervalEndMs). */
export function hourOverlapsIntervalMs(
  h: number,
  simStartMs: number,
  intervalStartMs: number,
  intervalEndMs: number
): boolean {
  const hs = simStartMs + h * HOUR_MS;
  const he = hs + HOUR_MS;
  return hs < intervalEndMs && he > intervalStartMs;
}

/** Smallest hour index whose clock hour overlaps [cargoStartMs, cargoEndMs). */
export function firstHourOverlappingCargo(
  simStartMs: number,
  cargoStartMs: number,
  cargoEndMs: number,
  maxHour: number
): number | null {
  for (let hh = 0; hh <= maxHour; hh++) {
    if (hourOverlapsIntervalMs(hh, simStartMs, cargoStartMs, cargoEndMs)) return hh;
  }
  return null;
}
