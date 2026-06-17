import type { DistributionSpec } from "../../types";

export interface DistributionFields {
  min: string;
  mode: string;
  max: string;
}

const EMPTY_DIST: DistributionFields = { min: "", mode: "", max: "" };

export function distributionFieldsFromSpec(spec?: DistributionSpec): DistributionFields {
  if (!spec) return { ...EMPTY_DIST };
  switch (spec.kind) {
    case "uniform":
      return {
        min: spec.min === 0 ? "" : String(spec.min),
        mode: "",
        max: String(spec.max)
      };
    case "triangular":
      return {
        min: String(spec.min),
        mode: String(spec.mode),
        max: String(spec.max)
      };
    case "fixed":
      return { min: "", mode: String(spec.value), max: String(spec.value) };
    default:
      return { ...EMPTY_DIST };
  }
}

/**
 * Build distribution from min / most likely / max fields.
 * - All empty → null
 * - Max only → uniform 0–max
 * - Most likely + max → triangular (min defaults to 0)
 * - Min + max, no mode → uniform min–max
 * - Min + mode + max → triangular
 */
export function distributionSpecFromFields(fields: DistributionFields): DistributionSpec | null {
  const minRaw = fields.min.trim();
  const modeRaw = fields.mode.trim();
  const maxRaw = fields.max.trim();

  if (!minRaw && !modeRaw && !maxRaw) return null;

  if (!maxRaw) return null;
  const hi = Math.max(0, Number(maxRaw) || 0);
  if (hi <= 0) return null;

  const lo = minRaw === "" ? 0 : Math.max(0, Number(minRaw) || 0);
  const min = Math.min(lo, hi);

  if (modeRaw !== "") {
    const modeVal = Number(modeRaw);
    if (!Number.isFinite(modeVal)) return null;
    const mode = Math.min(hi, Math.max(min, modeVal));
    return { kind: "triangular", min, mode, max: hi };
  }

  if (minRaw !== "" && min > 0) {
    return { kind: "uniform", min, max: hi };
  }

  return { kind: "uniform", min: 0, max: hi };
}
