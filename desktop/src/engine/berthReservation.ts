/**
 * Window of Arrival (WoA) and Laycan reservation windows on berth resources.
 */

import type { Blackout, Customer, ScheduledSlot, SimulationConfig } from "../types";
import { customerDirectionTransports } from "./customerTransports";
import { HOUR_MS, slotBerthOccupationHours } from "./slotLaytime";

export type BerthReservationMode = "none" | "window_of_arrival" | "laycan";

export function reservationMode(config: SimulationConfig): BerthReservationMode {
  const m = config.berthReservationMode ?? "none";
  if (m === "window_of_arrival" || m === "laycan") return m;
  return "none";
}

export function legReservationWindowHours(
  customer: Customer,
  direction: "inbound" | "outbound",
  laneIndex: number
): number {
  const rows = customerDirectionTransports(customer, direction);
  const row = rows[laneIndex];
  if (!row) return 0;
  const h = row.reservationWindowHours ?? 0;
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}

export interface ReservationWindow {
  reservationStart: Date;
  reservationEnd: Date;
}

export function slotResourceBlockInterval(
  slot: Pick<
    ScheduledSlot,
    "start" | "end" | "reservationStart" | "reservationEnd" | "resourceId"
  >,
  config: SimulationConfig,
  minIntervalHours: number
): { blockStartMs: number; blockEndMs: number } {
  const mode = reservationMode(config);
  const opStartMs = new Date(slot.start).getTime();
  const opEndMs = new Date(slot.end).getTime();
  const minIntervalMs = Math.max(0, minIntervalHours) * HOUR_MS;

  if (mode === "none" || slot.reservationStart == null || slot.reservationEnd == null) {
    return { blockStartMs: opStartMs, blockEndMs: opEndMs + minIntervalMs };
  }

  const resStartMs = new Date(slot.reservationStart).getTime();
  const resEndMs = new Date(slot.reservationEnd).getTime();

  if (mode === "laycan") {
    return { blockStartMs: resStartMs, blockEndMs: resEndMs + minIntervalMs };
  }

  const blockEndMs = Math.max(resEndMs, opEndMs) + minIntervalMs;
  return { blockStartMs: resStartMs, blockEndMs };
}

export function slotReservationOccupationHours(
  slot: Pick<ScheduledSlot, "reservationStart" | "reservationEnd">
): number {
  if (slot.reservationStart == null || slot.reservationEnd == null) return 0;
  const ms =
    new Date(slot.reservationEnd).getTime() - new Date(slot.reservationStart).getTime();
  return Math.max(0, ms / HOUR_MS);
}

export function slotOperationOccupationHours(
  slot: Pick<ScheduledSlot, "start" | "end">,
  config: SimulationConfig
): number {
  return slotBerthOccupationHours(slot, config);
}

export function earliestFreeOnResourceBefore(
  resourceId: string,
  beforeMs: number,
  assignedSlots: ScheduledSlot[],
  blackouts: Blackout[],
  minIntervalHours: number,
  config: SimulationConfig,
  simStartMs: number
): number {
  let latestEnd = simStartMs;

  for (const slot of assignedSlots) {
    if (slot.resourceId !== resourceId) continue;
    const { blockEndMs } = slotResourceBlockInterval(slot, config, minIntervalHours);
    if (blockEndMs <= beforeMs && blockEndMs > latestEnd) {
      latestEnd = blockEndMs;
    }
  }

  for (const b of blackouts) {
    if (b.resourceId !== resourceId) continue;
    const bEndMs = new Date(b.end).getTime();
    if (bEndMs <= beforeMs && bEndMs > latestEnd) {
      latestEnd = bEndMs;
    }
  }

  return latestEnd;
}

export function computeReservationWindow(
  mode: BerthReservationMode,
  operationStart: Date,
  operationEnd: Date,
  windowHours: number,
  earliestFreeMs: number,
  simStartMs: number
): ReservationWindow | null {
  if (mode === "none" || windowHours <= 0) return null;

  const sMs = operationStart.getTime();
  const eMs = operationEnd.getTime();
  const dMs = Math.max(0, eMs - sMs);
  const wMs = windowHours * HOUR_MS;

  if (mode === "laycan" && dMs > wMs + 1) return null;

  let rStartMs: number;
  if (mode === "window_of_arrival") {
    const centered = sMs - wMs / 2;
    rStartMs = Math.max(earliestFreeMs, simStartMs, sMs - wMs, centered);
  } else {
    const centered = sMs - (wMs - dMs) / 2;
    rStartMs = Math.max(earliestFreeMs, simStartMs, eMs - wMs, centered);
  }

  const rEndMs = rStartMs + wMs;

  if (mode === "window_of_arrival") {
    if (sMs < rStartMs - 1 || sMs > rEndMs + 1) return null;
  } else {
    if (sMs < rStartMs - 1 || eMs > rEndMs + 1) return null;
  }

  return {
    reservationStart: new Date(rStartMs),
    reservationEnd: new Date(rEndMs)
  };
}

export function buildSlotWithReservation(
  slot: ScheduledSlot,
  config: SimulationConfig,
  windowHours: number,
  earliestFreeMs: number,
  simStartMs: number
): ScheduledSlot | null {
  const mode = reservationMode(config);
  if (mode === "none" || windowHours <= 0) {
    return { ...slot, reservationStart: null, reservationEnd: null };
  }

  const window = computeReservationWindow(
    mode,
    slot.start,
    slot.end,
    windowHours,
    earliestFreeMs,
    simStartMs
  );
  if (!window) return null;

  return {
    ...slot,
    reservationStart: window.reservationStart,
    reservationEnd: window.reservationEnd
  };
}

export function findResourceBlockConflict(
  candidate: Pick<
    ScheduledSlot,
    "start" | "end" | "reservationStart" | "reservationEnd" | "resourceId"
  >,
  assignedSlots: ScheduledSlot[],
  blackouts: Blackout[],
  minIntervalHours: number,
  config: SimulationConfig
): { type: "slot" | "blackout"; end: Date } | null {
  const { blockStartMs, blockEndMs } = slotResourceBlockInterval(
    candidate,
    config,
    minIntervalHours
  );

  for (const slot of assignedSlots) {
    if (slot.resourceId !== candidate.resourceId) continue;
    const existing = slotResourceBlockInterval(slot, config, minIntervalHours);
    if (existing.blockStartMs < blockEndMs && existing.blockEndMs > blockStartMs) {
      return {
        type: "slot",
        end: new Date(existing.blockEndMs)
      };
    }
  }

  for (const b of blackouts) {
    if (b.resourceId !== candidate.resourceId) continue;
    const bStartMs = new Date(b.start).getTime();
    const bEndMs = new Date(b.end).getTime();
    if (bStartMs < blockEndMs && bEndMs > blockStartMs) {
      return { type: "blackout", end: b.end instanceof Date ? b.end : new Date(b.end) };
    }
  }

  return null;
}
