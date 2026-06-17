import { describe, expect, it } from "vitest";
import { createRng } from "./prng";
import { sampleDistribution } from "./distribution";

describe("sampleDistribution", () => {
  it("samples fixed values deterministically", () => {
    const rng = createRng(42);
    expect(sampleDistribution({ kind: "fixed", value: 3.5 }, rng)).toBe(3.5);
    expect(sampleDistribution({ kind: "fixed", value: 3.5 }, rng)).toBe(3.5);
  });

  it("samples uniform values within bounds", () => {
    const rng = createRng(99);
    for (let i = 0; i < 20; i++) {
      const v = sampleDistribution({ kind: "uniform", min: 2, max: 8 }, rng);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it("is reproducible for the same seed", () => {
    const a = sampleDistribution({ kind: "uniform", min: 0, max: 1 }, createRng(12345));
    const b = sampleDistribution({ kind: "uniform", min: 0, max: 1 }, createRng(12345));
    expect(a).toBe(b);
  });
});
