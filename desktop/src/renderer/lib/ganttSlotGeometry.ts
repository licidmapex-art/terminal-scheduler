import type { SimulationConfig } from "../../types";
import { HOUR_MS } from "../../engine/slotLaytime";
import { volumeFromOccupation, occupationEndFromVolume, snapMsToHour } from "../../engine/manualSlot";

export type GanttDragKind = "move" | "resize-start" | "resize-end" | "create";

export interface GanttDragState {
  kind: GanttDragKind;
  slotId?: string;
  resourceId: string;
  pointerAnchorMs: number;
  startMs: number;
  endMs: number;
  /** Original span when move/resize started. */
  originStartMs: number;
  originEndMs: number;
}

export function clientXToContentMs(
  clientX: number,
  scrollEl: HTMLElement,
  pixelsPerDay: number,
  simStartMs: number
): number {
  const rect = scrollEl.getBoundingClientRect();
  const xInContent = clientX - rect.left + scrollEl.scrollLeft;
  const dayOffset = xInContent / pixelsPerDay;
  return simStartMs + dayOffset * 24 * HOUR_MS;
}

export function msToContentLeft(ms: number, simStartMs: number, pixelsPerDay: number): number {
  const dayOffset = (ms - simStartMs) / (24 * HOUR_MS);
  return dayOffset * pixelsPerDay;
}

export function msToContentWidth(startMs: number, endMs: number, pixelsPerDay: number): number {
  const days = (endMs - startMs) / (24 * HOUR_MS);
  return Math.max(2, days * pixelsPerDay);
}

const MIN_CARGO_HOURS = 1;

export function minOccupationMs(config: SimulationConfig): number {
  const pre = Math.max(0, config.preOpsHours ?? 0);
  const post = Math.max(0, config.postOpsHours ?? 0);
  return (pre + post + MIN_CARGO_HOURS) * HOUR_MS;
}

export function applyDrag(
  drag: GanttDragState,
  pointerMs: number,
  simStartMs: number,
  simEndMs: number,
  config: SimulationConfig
): { startMs: number; endMs: number } {
  const minSpan = minOccupationMs(config);
  const snap = (ms: number) => snapMsToHour(ms, simStartMs);

  if (drag.kind === "move") {
    const delta = snap(pointerMs) - snap(drag.pointerAnchorMs);
    const span = drag.originEndMs - drag.originStartMs;
    let startMs = drag.originStartMs + delta;
    let endMs = startMs + span;
    if (startMs < simStartMs) {
      startMs = simStartMs;
      endMs = startMs + span;
    }
    if (endMs > simEndMs) {
      endMs = simEndMs;
      startMs = endMs - span;
    }
    return { startMs, endMs };
  }

  if (drag.kind === "resize-start") {
    let startMs = snap(pointerMs);
    let endMs = drag.originEndMs;
    if (endMs - startMs < minSpan) startMs = endMs - minSpan;
    if (startMs < simStartMs) startMs = simStartMs;
    return { startMs, endMs };
  }

  if (drag.kind === "resize-end") {
    let startMs = drag.originStartMs;
    let endMs = snap(pointerMs);
    if (endMs - startMs < minSpan) endMs = startMs + minSpan;
    if (endMs > simEndMs) endMs = simEndMs;
    return { startMs, endMs };
  }

  // create
  const a = snap(drag.originStartMs);
  const b = snap(pointerMs);
  let startMs = Math.min(a, b);
  let endMs = Math.max(a, b);
  if (endMs - startMs < minSpan) endMs = startMs + minSpan;
  if (endMs > simEndMs) endMs = simEndMs;
  if (startMs < simStartMs) startMs = simStartMs;
  return { startMs, endMs };
}

export function volumeForDrag(
  startMs: number,
  endMs: number,
  flowRateTph: number,
  config: SimulationConfig,
  fallbackVolume: number
): number {
  const v = volumeFromOccupation(new Date(startMs), new Date(endMs), flowRateTph, config);
  return v > 0 ? v : fallbackVolume;
}

export function endMsForVolume(
  startMs: number,
  volume: number,
  flowRateTph: number,
  config: SimulationConfig
): number {
  return occupationEndFromVolume(new Date(startMs), volume, flowRateTph, config).getTime();
}
