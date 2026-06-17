/**
 * Bulk validation of a persisted slot set (overlaps, blackouts, min interval).
 */

import type { Resource, ScheduledSlot, SimulationConfig } from "../types";
import { findResourceBlockConflict } from "./berthReservation";

export interface SlotValidationIssue {
  slotId: string;
  message: string;
  severity: "amber" | "red";
}

export function validateScheduledSlots(
  slots: ScheduledSlot[],
  resources: Resource[],
  config: SimulationConfig
): SlotValidationIssue[] {
  const minInterval = config.minSlotIntervalHours ?? 0;
  const issues: SlotValidationIssue[] = [];

  for (const slot of slots) {
    const resource = resources.find((r) => r.id === slot.resourceId);
    if (!resource) {
      issues.push({
        slotId: slot.id,
        severity: "red",
        message: `Slot references unknown resource ${slot.resourceId}`
      });
      continue;
    }
    const others = slots.filter((s) => s.id !== slot.id);
    const conflict = findResourceBlockConflict(
      slot,
      others,
      resource.blackouts,
      minInterval,
      config
    );
    if (conflict) {
      const label = conflict.type === "blackout" ? "blackout" : "another slot";
      issues.push({
        slotId: slot.id,
        severity: "red",
        message: `Overlaps ${label} on ${resource.name}`
      });
    }
  }

  return issues;
}
