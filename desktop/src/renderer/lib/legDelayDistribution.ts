import type { DistributionSpec, StochasticLegDelayConfig } from "../../types";
import {
  distributionFieldsFromSpec,
  distributionSpecFromFields,
  type DistributionFields
} from "./stochasticDistributionFields";

export interface LegDelayFields extends DistributionFields {
  /** Delay probability 0–1 (empty → default when saving). */
  probability: string;
}

const EMPTY_FIELDS: LegDelayFields = { probability: "", min: "", mode: "", max: "" };

/** Display values for probability + min / most likely / max delay inputs. */
export function legDelayFieldsFromConfig(cfg?: StochasticLegDelayConfig): LegDelayFields {
  if (!cfg) return { ...EMPTY_FIELDS };
  const fromSpec = distributionFieldsFromSpec(cfg.delayHours);
  return {
    ...fromSpec,
    probability: cfg.delayProbability != null ? String(cfg.delayProbability) : ""
  };
}

/** @deprecated use distributionFieldsFromSpec */
export function legDelayFieldsFromSpec(spec?: DistributionSpec): Pick<LegDelayFields, "min" | "mode" | "max"> {
  return distributionFieldsFromSpec(spec);
}

/** @deprecated use distributionSpecFromFields */
export function legDelaySpecFromFields(
  fields: Pick<LegDelayFields, "min" | "mode" | "max">
): DistributionSpec | null {
  return distributionSpecFromFields(fields);
}

export function legDelayConfigFromFields(
  fields: LegDelayFields,
  meta: {
    customerId: string;
    direction: "inbound" | "outbound";
    legKey: string | null;
  }
): StochasticLegDelayConfig | null {
  const delayHours = distributionSpecFromFields(fields);
  if (!delayHours) return null;

  const probRaw = fields.probability.trim();
  const delayProbability =
    probRaw === "" ? 1 : Math.min(1, Math.max(0, Number(probRaw) || 0));
  if (delayProbability <= 0) return null;

  return {
    customerId: meta.customerId,
    direction: meta.direction,
    legKey: meta.legKey,
    delayProbability,
    delayHours
  };
}
