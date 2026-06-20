import { describe, expect, it } from "vitest";
import { percentile, percentileSeries } from "./percentile";

describe("percentile", () => {
  it("returns single value for length 1", () => {
    expect(percentile([5], 50)).toBe(5);
  });

  it("interpolates median", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("builds hourly percentile series", () => {
    const series = percentileSeries([
      [10, 20],
      [30, 40],
      [50, 60]
    ]);
    expect(series.p50).toEqual([30, 40]);
    expect(series.p10.length).toBe(2);
    expect(series.p90.length).toBe(2);
  });
});
