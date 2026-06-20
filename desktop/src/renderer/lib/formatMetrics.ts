/** Format a fulfilment ratio (0–1+) for display. */
export function formatFulfillmentRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "∞";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Format a fulfilment percentage (0–100+) for display. */
export function formatFulfillmentPercent(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct.toFixed(1)}%`;
}

/** Format fulfilment vs pool / peer average in percentage points (e.g. +3.2 pp). */
export function formatFulfillmentDeltaPp(pp: number | null | undefined): string {
  if (pp == null || !Number.isFinite(pp)) return "—";
  const rounded = Math.round(pp * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1)} pp`;
}
