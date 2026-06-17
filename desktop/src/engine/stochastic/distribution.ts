import type { DistributionSpec } from "../../types";

export function sampleDistribution(spec: DistributionSpec, rng: () => number): number {
  switch (spec.kind) {
    case "fixed":
      return spec.value;
    case "uniform": {
      const lo = Math.min(spec.min, spec.max);
      const hi = Math.max(spec.min, spec.max);
      return lo + rng() * (hi - lo);
    }
    case "triangular": {
      const lo = Math.min(spec.min, spec.max);
      const hi = Math.max(spec.min, spec.max);
      const mode = Math.min(hi, Math.max(lo, spec.mode));
      const u = rng();
      const c = (mode - lo) / (hi - lo || 1);
      if (u < c) return lo + Math.sqrt(u * (hi - lo) * (mode - lo));
      return hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
    }
    default:
      return 0;
  }
}
