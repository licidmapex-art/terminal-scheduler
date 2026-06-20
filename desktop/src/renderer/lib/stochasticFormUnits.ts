import type { DistributionSpec } from "../../types";

/** Display a stored 0–1 probability as a 0–100 percent string. */
export function probabilityFractionToPercentString(fraction: number): string {
  const pct = fraction * 100;
  if (!Number.isFinite(pct)) return "";
  const rounded = Math.round(pct * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** Parse a percent input (0–100) to a 0–1 fraction; blank → null. */
export function parseProbabilityPercentInput(input: string): number | null {
  const raw = input.trim();
  if (raw === "") return null;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(1, Math.max(0, pct / 100));
}

export function simulationPeriodHoursFromDates(startDate: unknown, endDate: unknown): number {
  const start = startDate instanceof Date ? startDate : new Date(String(startDate ?? ""));
  const end = endDate instanceof Date ? endDate : new Date(String(endDate ?? ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60)));
}

/** Hours as a share of the simulation period, for inline hints. */
export function formatHourAsPeriodPercent(hours: number, periodHours: number): string {
  if (!(periodHours > 0) || !Number.isFinite(hours) || hours === 0) return "";
  const pct = (Math.abs(hours) / periodHours) * 100;
  if (pct > 0 && pct < 0.05) return "<0.1% of period";
  const rounded = Math.round(pct * 10) / 10;
  const signed = hours < 0 ? `−${rounded}` : `${rounded}`;
  return `${signed}% of period`;
}

/** Human-readable label for a delay / duration distribution (tooltips). */
export function formatDistributionSpec(spec: DistributionSpec): string {
  switch (spec.kind) {
    case "fixed":
      return `fixed ${spec.value}h`;
    case "uniform":
      return `uniform ${spec.min}–${spec.max}h`;
    case "triangular":
      return `triangular ${spec.min}–${spec.mode}–${spec.max}h`;
    default:
      return "distribution";
  }
}
