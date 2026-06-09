import type { Resource, ScheduledSlot, SimulationConfig } from "../types";

export type BargeBerthAllocation = "alternate" | "small_only" | "prefer_small";

const BARGE_BERTH_ALLOCATIONS: readonly BargeBerthAllocation[] = [
  "alternate",
  "small_only",
  "prefer_small"
];

export function normalizeBargeBerthAllocation(raw: unknown): BargeBerthAllocation {
  if (typeof raw === "string" && (BARGE_BERTH_ALLOCATIONS as readonly string[]).includes(raw)) {
    return raw as BargeBerthAllocation;
  }
  return "alternate";
}

export function getCompatibleResources(
  mode: "ship" | "barge" | "train",
  resources: Resource[],
  config: SimulationConfig
): Resource[] {
  if (mode === "ship") return resources.filter((r) => r.type === "berth_large");
  if (mode === "train") return resources.filter((r) => r.type === "rail_siding");
  if (mode === "barge") {
    const policy = normalizeBargeBerthAllocation(config.bargeBerthAllocation);
    if (policy === "small_only") {
      return resources.filter((r) => r.type === "berth_small");
    }
    return resources.filter((r) => r.type === "berth_large" || r.type === "berth_small");
  }
  return [];
}

export interface BerthCandidate {
  resource: Resource;
  start: Date;
  end: Date;
}

function lastAssignedSlotEndMs(resourceId: string, assignedSlots: ScheduledSlot[]): number {
  let max = 0;
  for (const slot of assignedSlots) {
    if (slot.resourceId !== resourceId) continue;
    const endMs = new Date(slot.end).getTime();
    if (endMs > max) max = endMs;
  }
  return max;
}

function alternatePick(candidates: BerthCandidate[], assignedSlots: ScheduledSlot[]): BerthCandidate {
  return candidates.reduce((best, cur) => {
    const curEnd = lastAssignedSlotEndMs(cur.resource.id, assignedSlots);
    const bestEnd = lastAssignedSlotEndMs(best.resource.id, assignedSlots);
    return curEnd < bestEnd ? cur : best;
  });
}

/** Pick a berth among equally early feasible candidates using the barge allocation policy. */
export function pickBerthCandidate(
  feasible: BerthCandidate[],
  assignedSlots: ScheduledSlot[],
  config: SimulationConfig,
  legMode: "ship" | "barge" | "train"
): BerthCandidate {
  const minStart = Math.min(...feasible.map((f) => f.start.getTime()));
  const tied = feasible.filter((f) => f.start.getTime() === minStart);
  if (tied.length === 1) return tied[0]!;

  const policy =
    legMode === "barge"
      ? normalizeBargeBerthAllocation(config.bargeBerthAllocation)
      : "alternate";

  if (policy === "prefer_small") {
    const smallBerths = tied.filter((f) => f.resource.type === "berth_small");
    if (smallBerths.length === 1) return smallBerths[0]!;
    if (smallBerths.length > 1) return alternatePick(smallBerths, assignedSlots);
  }

  return alternatePick(tied, assignedSlots);
}
