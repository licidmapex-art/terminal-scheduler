/** Fallback palette when `chartColor` is unset (matches prior hardcoded behavior). */
export const CUSTOMER_CHART_COLOR_PALETTE = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#ef4444",
  "#0891b2",
  "#ec4899"
] as const;

export function normalizeChartColorHex(input: string | null | undefined): string | null {
  if (input == null || typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
  if (!m) return null;
  let hex = m[1]!.toLowerCase();
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex}`;
}

export function resolveCustomerChartColor(
  chartColor: string | null | undefined,
  fallbackIndex: number
): string {
  const normalized = normalizeChartColorHex(chartColor);
  if (normalized) return normalized;
  const i = Number.isFinite(fallbackIndex) ? Math.max(0, Math.floor(fallbackIndex)) : 0;
  return CUSTOMER_CHART_COLOR_PALETTE[i % CUSTOMER_CHART_COLOR_PALETTE.length]!;
}
