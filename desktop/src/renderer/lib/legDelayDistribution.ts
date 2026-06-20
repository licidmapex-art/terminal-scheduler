import type { DistributionSpec, StochasticLegDelayConfig } from "../../types";
import {
  parseProbabilityPercentInput,
  probabilityFractionToPercentString
} from "./stochasticFormUnits";
import {
  distributionFieldsFromSpec,
  type DistributionFields
} from "./stochasticDistributionFields";

export interface LegDelayFields extends DistributionFields {
  /** Delay probability 0–100% (empty → default when saving). */
  probability: string;
}

const EMPTY_FIELDS: LegDelayFields = { probability: "", min: "", mode: "", max: "" };

/** Display values for probability + min / most likely / max delay inputs. */
export function legDelayFieldsFromConfig(cfg?: StochasticLegDelayConfig): LegDelayFields {
  if (!cfg) return { ...EMPTY_FIELDS };
  const fromSpec = distributionFieldsFromSpec(cfg.delayHours);
  return {
    ...fromSpec,
    probability:
      cfg.delayProbability != null
        ? probabilityFractionToPercentString(cfg.delayProbability)
        : ""
  };
}

/** @deprecated use distributionFieldsFromSpec */
export function legDelayFieldsFromSpec(spec?: DistributionSpec): Pick<LegDelayFields, "min" | "mode" | "max"> {
  return distributionFieldsFromSpec(spec);
}

/** @deprecated use legDelayDistributionSpecFromFields */
export function legDelaySpecFromFields(
  fields: Pick<LegDelayFields, "min" | "mode" | "max">
): DistributionSpec | null {
  return legDelayDistributionSpecFromFields(fields);
}

/**
 * Leg delay / early-arrival distribution (signed hours).
 * Negative samples shift the slot earlier; positive samples delay it.
 */
export function legDelayDistributionSpecFromFields(
  fields: Pick<LegDelayFields, "min" | "mode" | "max">
): DistributionSpec | null {
  const minRaw = fields.min.trim();
  const modeRaw = fields.mode.trim();
  const maxRaw = fields.max.trim();

  if (!minRaw && !modeRaw && !maxRaw) return null;

  if (!maxRaw) return null;
  const hiParsed = Number(maxRaw);
  if (!Number.isFinite(hiParsed)) return null;

  const loParsed = minRaw === "" ? 0 : Number(minRaw);
  if (!Number.isFinite(loParsed)) return null;

  const min = Math.min(loParsed, hiParsed);
  const max = Math.max(loParsed, hiParsed);
  if (Math.abs(max - min) <= 1e-9 && modeRaw === "") return null;

  if (modeRaw !== "") {
    const modeVal = Number(modeRaw);
    if (!Number.isFinite(modeVal)) return null;
    const mode = Math.min(max, Math.max(min, modeVal));
    return { kind: "triangular", min, mode, max };
  }

  if (minRaw !== "") {
    return { kind: "uniform", min, max };
  }

  if (hiParsed === 0) return null;
  if (hiParsed > 0) return { kind: "uniform", min: 0, max: hiParsed };
  return { kind: "uniform", min: hiParsed, max: 0 };
}

export function legDelayConfigFromFields(
  fields: LegDelayFields,
  meta: {
    customerId: string;
    direction: "inbound" | "outbound";
    legKey: string | null;
  }
): StochasticLegDelayConfig | null {
  const delayHours = legDelayDistributionSpecFromFields(fields);
  if (!delayHours) return null;

  const parsedProb = parseProbabilityPercentInput(fields.probability);
  const delayProbability = parsedProb === null ? 1 : parsedProb;
  if (delayProbability <= 0) return null;

  return {
    customerId: meta.customerId,
    direction: meta.direction,
    legKey: meta.legKey,
    delayProbability,
    delayHours
  };
}
