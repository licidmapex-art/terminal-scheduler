import { describe, it, expect } from "vitest";
import { relativeOptimizerShouldYield } from "./optimizer";

describe("relativeOptimizerShouldYield", () => {
  it("disabled when multiplier is 0", () => {
    expect(relativeOptimizerShouldYield(10, 5, 0)).toBe(false);
  });

  it("yields when leg DoC exceeds multiplier times average", () => {
    expect(relativeOptimizerShouldYield(20, 10, 1)).toBe(true);
    expect(relativeOptimizerShouldYield(15, 10, 1.4)).toBe(true);
  });

  it("does not yield when at or below threshold", () => {
    expect(relativeOptimizerShouldYield(10, 10, 1)).toBe(false);
    expect(relativeOptimizerShouldYield(9, 10, 1)).toBe(false);
    expect(relativeOptimizerShouldYield(14, 10, 1.5)).toBe(false);
  });
});
