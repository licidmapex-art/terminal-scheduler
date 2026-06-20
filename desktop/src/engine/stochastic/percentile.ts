/** Linear interpolation percentile on a sorted numeric array (p in 0–100). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const w = rank - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

/** For each hour index, compute p10/p50/p90 across iterations. */
export function percentileSeries(valuesByHour: number[][]): {
  p10: number[];
  p50: number[];
  p90: number[];
} {
  const hours = valuesByHour[0]?.length ?? 0;
  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (let h = 0; h < hours; h++) {
    const vals = valuesByHour.map((row) => row[h] ?? 0).sort((a, b) => a - b);
    p10.push(percentile(vals, 10));
    p50.push(percentile(vals, 50));
    p90.push(percentile(vals, 90));
  }
  return { p10, p50, p90 };
}
