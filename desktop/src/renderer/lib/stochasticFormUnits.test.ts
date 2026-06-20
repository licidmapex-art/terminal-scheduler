import { describe, expect, it } from "vitest";
import {
  formatHourAsPeriodPercent,
  parseProbabilityPercentInput,
  probabilityFractionToPercentString,
  simulationPeriodHoursFromDates
} from "./stochasticFormUnits";

describe("probabilityFractionToPercentString", () => {
  it("converts fractions to percent display", () => {
    expect(probabilityFractionToPercentString(0.25)).toBe("25");
    expect(probabilityFractionToPercentString(0.1)).toBe("10");
    expect(probabilityFractionToPercentString(1)).toBe("100");
  });
});

describe("parseProbabilityPercentInput", () => {
  it("parses percent to fraction", () => {
    expect(parseProbabilityPercentInput("25")).toBe(0.25);
    expect(parseProbabilityPercentInput("100")).toBe(1);
    expect(parseProbabilityPercentInput("")).toBeNull();
  });

  it("clamps to 0–100%", () => {
    expect(parseProbabilityPercentInput("150")).toBe(1);
    expect(parseProbabilityPercentInput("-5")).toBe(0);
  });
});

describe("formatHourAsPeriodPercent", () => {
  it("formats hours as share of period", () => {
    expect(formatHourAsPeriodPercent(24, 168)).toBe("14.3% of period");
    expect(formatHourAsPeriodPercent(168, 168)).toBe("100% of period");
  });

  it("returns empty for invalid input", () => {
    expect(formatHourAsPeriodPercent(NaN, 168)).toBe("");
    expect(formatHourAsPeriodPercent(24, 0)).toBe("");
  });
});

describe("simulationPeriodHoursFromDates", () => {
  it("computes whole hours between dates", () => {
    const start = new Date("2025-01-01T00:00:00Z");
    const end = new Date("2025-01-08T00:00:00Z");
    expect(simulationPeriodHoursFromDates(start, end)).toBe(168);
  });
});
