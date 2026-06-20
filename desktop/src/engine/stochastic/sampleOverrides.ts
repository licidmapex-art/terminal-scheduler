import type {
  Customer,
  ScheduledSlot,
  SimulationConfig,
  SimulationOverrides,
  StochasticConfig,
  StochasticDisruptionEvent,
  StochasticEvent,
  StochasticLegDelayConfig
} from "../../types";
import { sampleDistribution } from "./distribution";
import { hourRangeFromMs, simulationPeriodHours } from "./applyOverrides";
import { createRng, randomSeed } from "./prng";

const randomUUID = () => globalThis.crypto.randomUUID();

const HOUR_MS = 60 * 60 * 1000;

export interface SampleOverridesResult {
  overrides: SimulationOverrides;
  events: StochasticEvent[];
  seed: number;
}

function legDelayConfigForSlot(
  slot: ScheduledSlot,
  configs: StochasticLegDelayConfig[]
): StochasticLegDelayConfig | null {
  const matches = configs.filter(
    (c) =>
      c.customerId === slot.customerId &&
      c.direction === slot.direction &&
      (c.legKey == null || c.legKey === slot.legKey)
  );
  if (matches.length === 0) return null;
  const exact = matches.find((c) => c.legKey != null && c.legKey === slot.legKey);
  return exact ?? matches.find((c) => c.legKey == null) ?? matches[0] ?? null;
}

function sampleEventStartHour(
  spec: StochasticDisruptionEvent,
  periodHours: number,
  rng: () => number
): number {
  if (spec.startHour != null) return Math.max(0, Math.min(periodHours - 1, spec.startHour));
  const lo = Math.max(0, spec.startHourMin ?? 0);
  const hi = Math.max(lo + 1, Math.min(periodHours, spec.startHourMax ?? periodHours));
  return lo + Math.floor(rng() * (hi - lo));
}

function impactMultiplier(
  spec: StochasticDisruptionEvent,
  rng: () => number
): number {
  const impact = spec.impact ?? { kind: "full_stop" as const };
  if (impact.kind === "full_stop") return 0;
  return Math.max(0, sampleDistribution(impact.multiplier, rng));
}

function applyPipelineImpactToHour(
  pipelineMultiplierByHour: Record<number, Record<string, number>>,
  customers: Customer[],
  hour: number,
  hourlyMult: number,
  eventMult: number
): void {
  const row = pipelineMultiplierByHour[hour] ?? {};
  for (const c of customers) {
    const base = row[c.id] ?? hourlyMult;
    const combined = eventMult <= 1e-9 ? 0 : base * eventMult;
    row[c.id] = combined;
  }
  pipelineMultiplierByHour[hour] = row;
}

export function sampleSimulationOverrides(
  baselineSlots: ScheduledSlot[],
  customers: Customer[],
  config: SimulationConfig,
  stochasticConfig: StochasticConfig,
  seed?: number
): SampleOverridesResult {
  const resolvedSeed = seed ?? stochasticConfig.seed ?? randomSeed();
  const rng = createRng(resolvedSeed);
  const simStartMs = new Date(config.startDate).getTime();
  const periodHours = simulationPeriodHours(config);

  const slotAdjustments: SimulationOverrides["slotAdjustments"] = [];
  const events: StochasticEvent[] = [];

  for (const slot of baselineSlots) {
    const legCfg = legDelayConfigForSlot(slot, stochasticConfig.legDelays);
    if (!legCfg) continue;
    const delayP = Math.min(1, Math.max(0, legCfg.delayProbability ?? 1));
    if (rng() >= delayP) continue;
    const delayHours = sampleDistribution(legCfg.delayHours, rng);
    if (Math.abs(delayHours) <= 1e-9) continue;
    const deltaMs = Math.round(delayHours * HOUR_MS);
    const delayLabel =
      delayHours >= 0
        ? `+${delayHours.toFixed(1)}h delay`
        : `${delayHours.toFixed(1)}h early`;
    slotAdjustments.push({
      slotId: slot.id,
      deltaStartMs: deltaMs,
      deltaEndMs: deltaMs,
      reason: `Arrival ${delayLabel}`
    });
    const shiftedStart = slot.start.getTime() + deltaMs;
    const { hourStart, hourEnd } = hourRangeFromMs(
      simStartMs,
      shiftedStart,
      shiftedStart + HOUR_MS,
      periodHours
    );
    events.push({
      id: randomUUID(),
      kind: "arrival_delay",
      hourStart,
      hourEnd,
      customerId: slot.customerId,
      slotId: slot.id,
      legKey: slot.legKey ?? null,
      magnitude: delayHours,
      label: delayLabel
    });
  }

  const pipelineMultiplierByHour: Record<number, Record<string, number>> = {};
  const hourlyMultipliers: Record<number, number> = {};
  for (let h = 1; h <= periodHours; h++) {
    const mult = sampleDistribution(stochasticConfig.pipeline.flowMultiplier, rng);
    hourlyMultipliers[h] = mult;
    if (Math.abs(mult - 1) > 1e-9) {
      const row: Record<string, number> = {};
      for (const c of customers) row[c.id] = Math.max(0, mult);
      pipelineMultiplierByHour[h] = row;
    }
  }

  const immobilisationWindows: SimulationOverrides["immobilisationWindows"] = [];
  for (const spec of stochasticConfig.immobilisation.events) {
    const kind = spec.kind ?? "terminal";
    const occurrenceP = Math.min(1, Math.max(0, spec.occurrenceProbability ?? 1));
    if (rng() >= occurrenceP) continue;

    const durationHours = Math.max(
      0,
      sampleDistribution(spec.durationHours ?? { kind: "fixed", value: 4 }, rng)
    );
    if (durationHours <= 0) continue;

    const startHour = sampleEventStartHour(spec, periodHours, rng);
    const startMs = simStartMs + startHour * HOUR_MS;
    const endMs = startMs + durationHours * HOUR_MS;
    const { hourStart, hourEnd } = hourRangeFromMs(simStartMs, startMs, endMs, periodHours);
    const label =
      spec.label ?? (kind === "pipeline" ? "Pipeline disruption" : "Terminal immobilised");

    if (kind === "pipeline") {
      const eventMult = impactMultiplier(spec, rng);
      for (let h = hourStart; h < hourEnd; h++) {
        if (h < 1 || h > periodHours) continue;
        applyPipelineImpactToHour(
          pipelineMultiplierByHour,
          customers,
          h,
          hourlyMultipliers[h] ?? 1,
          eventMult
        );
      }
      const stopped = eventMult <= 1e-9;
      events.push({
        id: randomUUID(),
        kind: stopped ? "pipeline_stop" : "pipeline_reduction",
        hourStart,
        hourEnd,
        magnitude: stopped ? 0 : eventMult,
        label: stopped ? label : `${label} (${(eventMult * 100).toFixed(0)}%)`
      });
      continue;
    }

    immobilisationWindows.push({
      resourceId: spec.resourceId,
      startMs,
      endMs,
      label
    });
    events.push({
      id: randomUUID(),
      kind: "immobilisation",
      hourStart,
      hourEnd,
      resourceId: spec.resourceId,
      magnitude: durationHours,
      label
    });
  }

  for (let h = 1; h <= periodHours; h++) {
    const row = pipelineMultiplierByHour[h];
    if (!row) continue;
    const stopped = Object.values(row).every((m) => m === 0);
    const reduced = !stopped && Object.values(row).some((m) => m < 1);
    if (!stopped && !reduced) continue;
    const alreadyLogged = events.some(
      (e) =>
        (e.kind === "pipeline_stop" || e.kind === "pipeline_reduction") &&
        h >= e.hourStart &&
        h < e.hourEnd
    );
    if (alreadyLogged) continue;
    events.push({
      id: randomUUID(),
      kind: stopped ? "pipeline_stop" : "pipeline_reduction",
      hourStart: h,
      hourEnd: h + 1,
      magnitude: stopped ? 0 : Math.min(...Object.values(row)),
      label: stopped ? "Pipeline stop" : "Pipeline flow reduced"
    });
  }

  return {
    overrides: {
      slotAdjustments,
      pipelineMultiplierByHour,
      immobilisationWindows
    },
    events,
    seed: resolvedSeed
  };
}
