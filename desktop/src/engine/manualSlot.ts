/**
 * Build / validate manually placed or edited berth slots (tweakable schedule).
 */

import type { Customer, Resource, ScheduledSlot, SimulationConfig } from "../types";
import {
  buildSlotWithReservation,
  earliestFreeOnResourceBefore,
  findResourceBlockConflict,
  legReservationWindowHours
} from "./berthReservation";
import { getCompatibleResources } from "./resourceAllocation";
import { laytimeFromConfig, HOUR_MS } from "./slotLaytime";

export function defaultModeForResource(resource: Resource): "ship" | "barge" | "train" {
  if (resource.type === "rail_siding") return "train";
  if (resource.type === "berth_small") return "barge";
  return "ship";
}

export function snapMsToHour(ms: number, simStartMs: number): number {
  const h = Math.round((ms - simStartMs) / HOUR_MS);
  return simStartMs + h * HOUR_MS;
}

export function volumeFromOccupation(
  start: Date,
  end: Date,
  flowRateTph: number,
  config: SimulationConfig
): number {
  const { preOps, postOps } = laytimeFromConfig(config);
  const wallHours = (end.getTime() - start.getTime()) / HOUR_MS;
  const loadingHours = Math.max(0, wallHours - preOps - postOps);
  return Math.round(Math.max(0, loadingHours * flowRateTph));
}

export function occupationEndFromVolume(
  start: Date,
  volumeTonnes: number,
  flowRateTph: number,
  config: SimulationConfig
): Date {
  const { preOps, postOps } = laytimeFromConfig(config);
  const loadingHours = flowRateTph > 0 ? volumeTonnes / flowRateTph : 1;
  return new Date(start.getTime() + (preOps + loadingHours + postOps) * HOUR_MS);
}

export function laneIndexFromLegKey(legKey: string | null | undefined): number {
  if (!legKey) return 0;
  const m = legKey.match(/:lane(\d+)$/);
  return m ? Math.max(0, parseInt(m[1]!, 10)) : 0;
}

export function defaultLegKey(
  customerId: string,
  direction: string,
  mode: string,
  laneIndex = 0
): string {
  return `${customerId}:${direction}:${mode}:lane${laneIndex}`;
}

export function finalizeManualSlot(
  draft: ScheduledSlot,
  customer: Customer,
  allResources: Resource[],
  config: SimulationConfig,
  otherSlots: ScheduledSlot[]
): { ok: true; slot: ScheduledSlot } | { ok: false; error: string } {
  const resource = allResources.find((r) => r.id === draft.resourceId);
  if (!resource) return { ok: false, error: "Resource not found" };

  const compatible = getCompatibleResources(draft.mode, allResources, config);
  if (!compatible.some((r) => r.id === resource.id)) {
    return { ok: false, error: `${draft.mode} cannot use ${resource.name}` };
  }

  const simStartMs = new Date(config.startDate).getTime();
  const simEndMs = new Date(config.endDate).getTime();
  if (draft.end.getTime() <= draft.start.getTime()) {
    return { ok: false, error: "End must be after start" };
  }
  if (draft.start.getTime() < simStartMs || draft.end.getTime() > simEndMs) {
    return { ok: false, error: "Slot must lie within the simulation horizon" };
  }

  const minInterval = config.minSlotIntervalHours ?? 0;
  const laneIndex = laneIndexFromLegKey(draft.legKey);
  const windowHours = legReservationWindowHours(customer, draft.direction, laneIndex);
  const earliestFree = earliestFreeOnResourceBefore(
    resource.id,
    draft.start.getTime(),
    otherSlots,
    resource.blackouts,
    minInterval,
    config,
    simStartMs
  );

  const base: ScheduledSlot = {
    ...draft,
    status: "manual_override",
    conflictReason: null
  };

  const withRes =
    buildSlotWithReservation(base, config, windowHours, earliestFree, simStartMs) ??
    ({ ...base, reservationStart: null, reservationEnd: null } as ScheduledSlot);

  const conflict = findResourceBlockConflict(
    withRes,
    otherSlots,
    resource.blackouts,
    minInterval,
    config
  );
  if (conflict) {
    return {
      ok: false,
      error: conflict.type === "blackout" ? "Overlaps a resource blackout" : "Overlaps another slot"
    };
  }

  return { ok: true, slot: withRes };
}
