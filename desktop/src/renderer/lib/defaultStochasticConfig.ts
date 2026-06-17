import type { Customer, DistributionSpec, StochasticConfig, StochasticDisruptionEvent } from "../../types";
import { customerSchedulableTransports } from "../../engine/customerTransports";

export function defaultStochasticConfig(): StochasticConfig {
  return {
    enabled: false,
    legDelays: [],
    pipeline: {
      flowMultiplier: { kind: "triangular", min: 0.85, mode: 0.95, max: 1 }
    },
    immobilisation: { events: [] }
  };
}

function parseDistribution(raw: unknown, fallback: DistributionSpec): DistributionSpec {
  if (!raw || typeof raw !== "object") return fallback;
  const d = raw as Record<string, unknown>;
  if (d.kind === "fixed" && typeof d.value === "number") return { kind: "fixed", value: d.value };
  if (d.kind === "uniform" && typeof d.min === "number" && typeof d.max === "number") {
    return { kind: "uniform", min: d.min, max: d.max };
  }
  if (
    d.kind === "triangular" &&
    typeof d.min === "number" &&
    typeof d.mode === "number" &&
    typeof d.max === "number"
  ) {
    return { kind: "triangular", min: d.min, mode: d.mode, max: d.max };
  }
  return fallback;
}

function parseDisruptionEvent(raw: unknown): StochasticDisruptionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind === "pipeline" ? "pipeline" : "terminal";
  const occurrenceProbability =
    e.occurrenceProbability != null && Number.isFinite(Number(e.occurrenceProbability))
      ? Math.min(1, Math.max(0, Number(e.occurrenceProbability)))
      : undefined;

  let impact = e.impact as StochasticDisruptionEvent["impact"];
  if (!impact || typeof impact !== "object") {
    impact = { kind: "full_stop" };
  } else if ((impact as { kind?: string }).kind === "partial") {
    const mult = parseDistribution(
      (impact as { multiplier?: unknown }).multiplier,
      { kind: "triangular", min: 0.5, mode: 0.75, max: 0.9 }
    );
    impact = { kind: "partial", multiplier: mult };
  } else {
    impact = { kind: "full_stop" };
  }

  return {
    kind,
    label: typeof e.label === "string" ? e.label : undefined,
    occurrenceProbability,
    durationHours: parseDistribution(e.durationHours, { kind: "fixed", value: 8 }),
    startHour: typeof e.startHour === "number" ? e.startHour : undefined,
    startHourMin: typeof e.startHourMin === "number" ? e.startHourMin : undefined,
    startHourMax: typeof e.startHourMax === "number" ? e.startHourMax : undefined,
    impact,
    resourceId: typeof e.resourceId === "string" ? e.resourceId : undefined
  };
}

/** Migrate legacy per-hour pipeline stop to a period disruption event. */
function migrateLegacyPipelineStop(
  stopProbabilityPerHour: number,
  events: StochasticDisruptionEvent[]
): StochasticDisruptionEvent[] {
  if (stopProbabilityPerHour <= 0) return events;
  if (events.some((e) => (e.kind ?? "terminal") === "pipeline")) return events;
  const periodHours = 168;
  const occurrenceProbability = Math.min(1, 1 - Math.pow(1 - stopProbabilityPerHour, periodHours));
  return [
    ...events,
    {
      kind: "pipeline",
      label: "Pipeline stop",
      occurrenceProbability,
      durationHours: { kind: "triangular", min: 2, mode: 6, max: 12 },
      startHourMin: 0,
      startHourMax: periodHours,
      impact: { kind: "full_stop" }
    }
  ];
}

export function normalizeStochasticConfig(raw: unknown): StochasticConfig {
  const base = defaultStochasticConfig();
  if (!raw || typeof raw !== "object") return base;
  const o = raw as Record<string, unknown>;

  const pipelineRaw = o.pipeline as Record<string, unknown> | undefined;
  const legacyStopP = Math.min(
    1,
    Math.max(0, Number(pipelineRaw?.stopProbabilityPerHour ?? 0))
  );

  let events = Array.isArray((o.immobilisation as { events?: unknown })?.events)
    ? ((o.immobilisation as { events: unknown[] }).events
        .map(parseDisruptionEvent)
        .filter((e): e is StochasticDisruptionEvent => e != null) ?? [])
    : [];

  events = migrateLegacyPipelineStop(legacyStopP, events);

  return {
    enabled: !!o.enabled,
    seed: typeof o.seed === "number" && Number.isFinite(o.seed) ? Math.floor(o.seed) : undefined,
    legDelays: Array.isArray(o.legDelays)
      ? (o.legDelays as StochasticConfig["legDelays"])
          .filter(
            (l) =>
              l &&
              typeof l.customerId === "string" &&
              (l.direction === "inbound" || l.direction === "outbound")
          )
          .map((l) => ({
            ...l,
            delayProbability:
              l.delayProbability != null && Number.isFinite(l.delayProbability)
                ? Math.min(1, Math.max(0, l.delayProbability))
                : undefined
          }))
      : [],
    pipeline: {
      flowMultiplier: parseDistribution(pipelineRaw?.flowMultiplier, base.pipeline.flowMultiplier)
    },
    immobilisation: { events }
  };
}

/** Unique schedulable legs for per-leg delay configuration. */
export function schedulableLegRows(
  customers: Customer[]
): Array<{ customerId: string; customerName: string; direction: "inbound" | "outbound"; legKey: string | null; mode: string }> {
  const rows: Array<{
    customerId: string;
    customerName: string;
    direction: "inbound" | "outbound";
    legKey: string | null;
    mode: string;
  }> = [];
  const seen = new Set<string>();
  for (const c of customers) {
    for (const direction of ["inbound", "outbound"] as const) {
      for (const row of customerSchedulableTransports(c, direction)) {
        const key = `${c.id}|${direction}|${row.legKey ?? ""}|${row.mode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          customerId: c.id,
          customerName: c.name,
          direction,
          legKey: row.legKey ?? null,
          mode: row.mode
        });
      }
    }
  }
  return rows;
}
