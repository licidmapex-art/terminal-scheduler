import type {
  DistributionSpec,
  StochasticDisruptionEvent,
  StochasticDisruptionImpact
} from "../../types";
import {
  distributionFieldsFromSpec,
  distributionSpecFromFields,
  type DistributionFields
} from "./stochasticDistributionFields";

export interface DisruptionEventFields {
  kind: StochasticDisruptionEvent["kind"];
  label: string;
  probability: string;
  startHourMin: string;
  startHourMax: string;
  duration: DistributionFields;
  impactKind: "full_stop" | "partial";
  impact: DistributionFields;
}

const EMPTY_DURATION: DistributionFields = { min: "", mode: "", max: "" };

export function disruptionEventFieldsFromConfig(ev?: StochasticDisruptionEvent): DisruptionEventFields {
  if (!ev) {
    return {
      kind: "terminal",
      label: "",
      probability: "",
      startHourMin: "0",
      startHourMax: "168",
      duration: { ...EMPTY_DURATION },
      impactKind: "full_stop",
      impact: { ...EMPTY_DURATION }
    };
  }
  const impact = ev.impact ?? { kind: "full_stop" as const };
  return {
    kind: ev.kind ?? "terminal",
    label: ev.label ?? "",
    probability: ev.occurrenceProbability != null ? String(ev.occurrenceProbability) : "",
    startHourMin: String(ev.startHourMin ?? ev.startHour ?? 0),
    startHourMax: String(ev.startHourMax ?? 168),
    duration: distributionFieldsFromSpec(ev.durationHours),
    impactKind: impact.kind === "partial" ? "partial" : "full_stop",
    impact:
      impact.kind === "partial"
        ? distributionFieldsFromSpec(impact.multiplier)
        : { ...EMPTY_DURATION }
  };
}

export function disruptionEventFromFields(fields: DisruptionEventFields): StochasticDisruptionEvent | null {
  const durationHours = distributionSpecFromFields(fields.duration);
  if (!durationHours) return null;

  const probRaw = fields.probability.trim();
  const occurrenceProbability =
    probRaw === "" ? 1 : Math.min(1, Math.max(0, Number(probRaw) || 0));
  if (occurrenceProbability <= 0) return null;

  let impact: StochasticDisruptionImpact = { kind: "full_stop" };
  if (fields.impactKind === "partial") {
    const multiplier = distributionSpecFromFields(fields.impact);
    if (!multiplier) return null;
    impact = { kind: "partial", multiplier };
  }

  const startHourMin = Math.max(0, Number(fields.startHourMin) || 0);
  const startHourMax = Math.max(startHourMin + 1, Number(fields.startHourMax) || 168);

  return {
    kind: fields.kind,
    label: fields.label.trim() || undefined,
    occurrenceProbability,
    durationHours,
    startHourMin,
    startHourMax,
    impact
  };
}

/** Fields for pipeline flow multiplier (no probability gate). */
export function flowMultiplierFieldsFromSpec(spec?: DistributionSpec): DistributionFields {
  return distributionFieldsFromSpec(spec);
}

export function flowMultiplierSpecFromFields(fields: DistributionFields): DistributionSpec {
  return (
    distributionSpecFromFields(fields) ?? { kind: "triangular", min: 0.85, mode: 0.95, max: 1 }
  );
}
