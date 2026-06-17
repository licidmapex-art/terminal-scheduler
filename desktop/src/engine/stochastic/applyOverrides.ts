import type {
  ImmobilisationWindow,
  ScheduledSlot,
  SimulationConfig,
  SimulationOverrides,
  SlotTimeAdjustment,
  StochasticEvent
} from "../../types";
import type { FeasibilityWarning } from "../feasibility";
import { simulationPeriodHoursFloored } from "../inventory";

const HOUR_MS = 60 * 60 * 1000;

export function applySlotTimeAdjustments(
  slots: ScheduledSlot[],
  adjustments: SlotTimeAdjustment[]
): ScheduledSlot[] {
  if (adjustments.length === 0) return slots;
  const byId = new Map(adjustments.map((a) => [a.slotId, a]));
  return slots.map((s) => {
    const adj = byId.get(s.id);
    if (!adj) return s;
    const start = new Date(s.start.getTime() + adj.deltaStartMs);
    const end = new Date(s.end.getTime() + adj.deltaEndMs);
    return {
      ...s,
      start,
      end,
      reservationStart: s.reservationStart
        ? new Date(s.reservationStart.getTime() + adj.deltaStartMs)
        : null,
      reservationEnd: s.reservationEnd
        ? new Date(s.reservationEnd.getTime() + adj.deltaEndMs)
        : null
    };
  });
}

export function pipelineMultiplierForHour(
  overrides: SimulationOverrides | undefined,
  hour: number,
  customerId: string
): number {
  if (!overrides) return 1;
  return overrides.pipelineMultiplierByHour[hour]?.[customerId] ?? 1;
}

export function eventsActiveAtHour(events: StochasticEvent[], hour: number): StochasticEvent[] {
  return events.filter((e) => hour >= e.hourStart && hour < e.hourEnd);
}

export function immobilisationWarnings(
  slots: ScheduledSlot[],
  windows: ImmobilisationWindow[]
): FeasibilityWarning[] {
  const warnings: FeasibilityWarning[] = [];
  for (const slot of slots) {
    const startMs = slot.start.getTime();
    const endMs = slot.end.getTime();
    for (const w of windows) {
      if (w.resourceId && w.resourceId !== slot.resourceId) continue;
      if (startMs < w.endMs && endMs > w.startMs) {
        warnings.push({
          key: "stochastic_immobilisation_conflict",
          severity: "amber",
          message: `Slot overlaps stochastic immobilisation (“${w.label}”).`,
          meta: { slotId: slot.id, resourceId: slot.resourceId }
        });
      }
    }
  }
  return warnings;
}

export function hourRangeFromMs(
  simStartMs: number,
  startMs: number,
  endMs: number,
  periodHours: number
): { hourStart: number; hourEnd: number } {
  const hourStart = Math.max(0, Math.floor((startMs - simStartMs) / HOUR_MS));
  const hourEnd = Math.min(periodHours + 1, Math.ceil((endMs - simStartMs) / HOUR_MS));
  return { hourStart, hourEnd: Math.max(hourStart + 1, hourEnd) };
}

export function simulationPeriodHours(config: SimulationConfig): number {
  return simulationPeriodHoursFloored(config);
}
