import { describe, expect, it } from "vitest";
import {
  legDelayConfigFromFields,
  legDelayFieldsFromConfig,
  legDelaySpecFromFields
} from "./legDelayDistribution";

describe("legDelaySpecFromFields", () => {
  it("returns null when all duration fields empty", () => {
    expect(legDelaySpecFromFields({ min: "", mode: "", max: "" })).toBeNull();
  });

  it("max only → uniform 0–max", () => {
    expect(legDelaySpecFromFields({ min: "", mode: "", max: "24" })).toEqual({
      kind: "uniform",
      min: 0,
      max: 24
    });
  });

  it("mode + max → triangular with min 0", () => {
    expect(legDelaySpecFromFields({ min: "", mode: "8", max: "24" })).toEqual({
      kind: "triangular",
      min: 0,
      mode: 8,
      max: 24
    });
  });
});

describe("legDelayConfigFromFields", () => {
  const meta = { customerId: "c1", direction: "inbound" as const, legKey: null };

  it("includes delayProbability default 1 when probability blank", () => {
    const cfg = legDelayConfigFromFields(
      { probability: "", min: "", mode: "8", max: "24" },
      meta
    );
    expect(cfg?.delayProbability).toBe(1);
    expect(cfg?.delayHours).toEqual({ kind: "triangular", min: 0, mode: 8, max: 24 });
  });

  it("returns null when probability is 0", () => {
    expect(
      legDelayConfigFromFields({ probability: "0", min: "", mode: "8", max: "24" }, meta)
    ).toBeNull();
  });

  it("round-trips probability via fields", () => {
    const cfg = {
      customerId: "c1",
      direction: "inbound" as const,
      legKey: null,
      delayProbability: 0.3,
      delayHours: { kind: "triangular" as const, min: 0, mode: 6, max: 18 }
    };
    const fields = legDelayFieldsFromConfig(cfg);
    expect(fields.probability).toBe("30");
    expect(legDelayConfigFromFields(fields, meta)).toEqual(cfg);
  });
});
