/**
 * Scheduler engine – greedy earliest-fit.
 * See docs/ALGORITHM.md for spec.
 */

import {
  Resource,
  TransportMode,
  TransportRequest,
  ScheduledEvent,
  ScheduleProposal,
  UnscheduledRequest,
  addHours,
  maxDate,
  overlaps
} from "./domain";

export interface SchedulerConfig {
  timeStepHours: number;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  timeStepHours: 0.25
};

export interface TerminalStateForScheduling {
  resources: Resource[];
  existingEvents: ScheduledEvent[];
}

export interface TerminalConstraintsInput {
  periodStart?: Date;
  periodEnd?: Date;
  products?: Array<{ id: string; storageCapacity: number }>;
  minHoursBetweenSlots?: number;
  minHoursBetweenSlotsScope?: "all" | "per_mode";
  minSpacingHoursPerCustomer?: number;
}

function getRequiredResourceTypesForMode(mode: TransportMode): Resource["type"][] {
  switch (mode) {
    case "ship":
    case "barge":
      return ["berth", "loading_arm"];
    case "pipeline":
      return ["pipeline"];
    case "train":
      return ["rail_siding"];
  }
}

function chooseResourcesForRequest(
  all: Resource[],
  requiredTypes: Resource["type"][]
): Resource[] | null {
  const chosen: Resource[] = [];
  for (const t of requiredTypes) {
    const r = all.find((r) => r.type === t);
    if (!r) return null;
    chosen.push(r);
  }
  return chosen;
}

function resourcesFree(
  resources: Resource[],
  events: ScheduledEvent[],
  start: Date,
  end: Date
): boolean {
  for (const res of resources) {
    const maxConcurrent = res.maxConcurrent ?? 1;
    let concurrentCount = 0;
    for (const evt of events) {
      if (!evt.resourceIds.includes(res.id)) continue;
      if (overlaps(start, end, evt.start, evt.end)) {
        concurrentCount += 1;
        if (concurrentCount >= maxConcurrent) return false;
      }
    }
  }
  return true;
}

type FindEarliestStartResult =
  | { start: Date }
  | { start: null; reason?: string };

function findEarliestStart(
  req: TransportRequest,
  resources: Resource[],
  allEvents: ScheduledEvent[],
  durationHours: number,
  stepHours: number,
  constraints: TerminalConstraintsInput,
  preferredStart?: Date
): FindEarliestStartResult {
  const windowStart = req.requestedWindow.earliest;
  const windowEnd = req.requestedWindow.latest;
  const scope = constraints.minHoursBetweenSlotsScope === "per_mode" ? "per_mode" : "all";
  const minHoursBetweenSlots = Math.max(0, constraints.minHoursBetweenSlots ?? 0);
  const minSpacingPerCustomer = Math.max(0, constraints.minSpacingHoursPerCustomer ?? 0);

  const eventsToCheckOverlap = (): ScheduledEvent[] => {
    return allEvents.filter(
      (evt) =>
        evt.customerId !== req.customerId ||
        scope !== "per_mode" ||
        evt.mode === req.mode
    );
  };

  const tryCandidate = (candidate: Date): FindEarliestStartResult | null => {
    const end = addHours(candidate, durationHours);
    if (candidate < windowStart || end > windowEnd) return null;

    const checkEvents = eventsToCheckOverlap();
    if (checkEvents.length > 0) {
      if (minHoursBetweenSlots > 0 || minSpacingPerCustomer > 0) {
        const tooEarly = checkEvents.some((evt) => {
          const gap = evt.customerId === req.customerId
            ? Math.max(minHoursBetweenSlots, minSpacingPerCustomer)
            : minHoursBetweenSlots;
          const minStart = addHours(evt.end, gap);
          return candidate.getTime() < minStart.getTime();
        });
        if (tooEarly) return null;
      } else {
        const anyOverlap = checkEvents.some((evt) => overlaps(candidate, end, evt.start, evt.end));
        if (anyOverlap) return null;
      }
    }

    if (!resourcesFree(resources, allEvents, candidate, end)) return null;
    return { start: candidate };
  };

  if (preferredStart && preferredStart >= windowStart && preferredStart <= windowEnd) {
    const maxOffset = Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (stepHours * 3600000));
    for (let offset = 0; offset <= maxOffset; offset++) {
      for (const sign of [1, -1]) {
        if (offset === 0 && sign === -1) continue;
        const candidate = addHours(preferredStart, sign * offset * stepHours);
        const result = tryCandidate(candidate);
        if (result) return result;
      }
    }
  }

  let candidate = new Date(windowStart);
  while (candidate <= windowEnd) {
    const result = tryCandidate(candidate);
    if (result) return result;
    candidate = addHours(candidate, stepHours);
  }

  return { start: null };
}

/**
 * Greedy earliest-fit scheduler:
 * - Sorts requests by priority then requested earliest time
 * - For each request, searches from earliest window, in timeStep increments,
 *   for a contiguous window where all required resources are free.
 */
export function proposeSchedule(
  terminal: TerminalStateForScheduling,
  requests: TransportRequest[],
  config: Partial<SchedulerConfig> = {},
  constraints: TerminalConstraintsInput = {}
): ScheduleProposal {
  const cfg: SchedulerConfig = { ...DEFAULT_CONFIG, ...config };

  const scheduled: ScheduledEvent[] = [...terminal.existingEvents];
  const newlyScheduled: ScheduledEvent[] = [];
  const unscheduled: string[] = [];
  const unscheduledWithReasons: UnscheduledRequest[] = [];

  const productCapacityById = new Map<string, number>();
  for (const p of constraints.products ?? []) {
    productCapacityById.set(p.id, p.storageCapacity);
  }

  const sortedRequests = [...requests].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence;
    return a.requestedWindow.earliest.getTime() - b.requestedWindow.earliest.getTime();
  });

  for (const req of sortedRequests) {
    if (productCapacityById.size > 0 && !productCapacityById.has(req.productId)) {
      unscheduled.push(req.id);
      unscheduledWithReasons.push({
        requestId: req.id,
        reason: `Unknown product '${req.productId}' (not configured in terminal)`
      });
      continue;
    }
    const cap = productCapacityById.get(req.productId);
    if (cap !== undefined && req.volume > cap) {
      unscheduled.push(req.id);
      unscheduledWithReasons.push({
        requestId: req.id,
        reason: `Request volume ${req.volume} exceeds configured storage capacity ${cap} for product '${req.productId}'`
      });
      continue;
    }

    const requiredResourceTypes = getRequiredResourceTypesForMode(req.mode);
    const candidateResources = chooseResourcesForRequest(terminal.resources, requiredResourceTypes);
    if (!candidateResources) {
      unscheduled.push(req.id);
      unscheduledWithReasons.push({
        requestId: req.id,
        reason: `Missing required resource(s) for mode '${req.mode}' (${requiredResourceTypes.join(", ")})`
      });
      continue;
    }

    const durationHours = req.estimatedDurationHours;

    const effectiveWindow = {
      earliest: constraints.periodStart
        ? maxDate(req.requestedWindow.earliest, constraints.periodStart)
        : req.requestedWindow.earliest,
      latest: constraints.periodEnd
        ? new Date(Math.min(req.requestedWindow.latest.getTime(), constraints.periodEnd.getTime()))
        : req.requestedWindow.latest
    };
    if (effectiveWindow.latest.getTime() <= effectiveWindow.earliest.getTime()) {
      unscheduled.push(req.id);
      unscheduledWithReasons.push({
        requestId: req.id,
        reason: "Requested time window does not overlap the terminal scheduling period"
      });
      continue;
    }

    const effectivePreferred =
      req.preferredStart && req.preferredStart >= effectiveWindow.earliest && req.preferredStart <= effectiveWindow.latest
        ? req.preferredStart
        : undefined;

    const result = findEarliestStart(
      { ...req, requestedWindow: effectiveWindow },
      candidateResources,
      [...scheduled, ...newlyScheduled],
      durationHours,
      cfg.timeStepHours,
      constraints,
      effectivePreferred
    );

    if (!result.start) {
      unscheduled.push(req.id);
      unscheduledWithReasons.push({
        requestId: req.id,
        reason: "No feasible slot available within the allowed time window"
      });
      continue;
    }

    const end = addHours(result.start, durationHours);
    const event: ScheduledEvent = {
      id: `evt_${req.id}`,
      requestId: req.id,
      direction: req.direction,
      mode: req.mode,
      productId: req.productId,
      customerId: req.customerId,
      volume: req.volume,
      start: result.start,
      end,
      resourceIds: candidateResources.map((r) => r.id)
    };

    newlyScheduled.push(event);
  }

  const scope = constraints.minHoursBetweenSlotsScope === "per_mode" ? "per_mode" : "all";
  const minHoursBetweenSlots = Math.max(0, constraints.minHoursBetweenSlots ?? 0);
  const minSpacingPerCustomer = Math.max(0, constraints.minSpacingHoursPerCustomer ?? 0);
  const gapMs = (hrs: number) => hrs * 60 * 60 * 1000;

  if (newlyScheduled.length > 1) {
    const shiftOverlapping = (list: ScheduledEvent[]) => {
      list.sort((a, b) => a.start.getTime() - b.start.getTime());
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1]!;
        const curr = list[i]!;
        const requiredGap =
          curr.customerId === prev.customerId
            ? Math.max(minHoursBetweenSlots, minSpacingPerCustomer)
            : minHoursBetweenSlots;
        const minStart = prev.end.getTime() + gapMs(requiredGap);
        if (curr.start.getTime() < minStart) {
          const durationMs = curr.end.getTime() - curr.start.getTime();
          curr.start = new Date(minStart);
          curr.end = new Date(minStart + durationMs);
        }
      }
    };
    if (scope === "per_mode") {
      const byMode = new Map<TransportMode, ScheduledEvent[]>();
      for (const e of newlyScheduled) {
        const list = byMode.get(e.mode) ?? [];
        list.push(e);
        byMode.set(e.mode, list);
      }
      for (const list of byMode.values()) shiftOverlapping(list);
    } else {
      shiftOverlapping(newlyScheduled);
    }
  }

  return {
    events: [...newlyScheduled].sort((a, b) => a.start.getTime() - b.start.getTime()),
    unscheduledRequestIds: unscheduled,
    unscheduled: unscheduledWithReasons
  };
}
