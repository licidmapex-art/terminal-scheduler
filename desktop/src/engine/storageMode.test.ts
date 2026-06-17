import { describe, expect, it } from "vitest";
import {
  isIndividualStorageMode,
  isSharedStorageMode,
  normalizeStorageModeToUi,
  parseStorageMode
} from "../lib/storageMode";

describe("parseStorageMode", () => {
  it("maps legacy commingled and shared_shipping to shared_inventory", () => {
    expect(parseStorageMode("commingled")).toBe("shared_inventory");
    expect(parseStorageMode("shared_shipping")).toBe("shared_inventory");
  });

  it("maps legacy time_shared_storage to fixed_band", () => {
    expect(parseStorageMode("time_shared_storage")).toBe("fixed_band");
  });

  it("preserves active modes", () => {
    expect(parseStorageMode("fixed_band")).toBe("fixed_band");
    expect(parseStorageMode("shared_inventory")).toBe("shared_inventory");
  });

  it("defaults unknown values to fixed_band", () => {
    expect(parseStorageMode(undefined)).toBe("fixed_band");
    expect(parseStorageMode("unknown")).toBe("fixed_band");
  });
});

describe("storage mode UI helpers", () => {
  it("normalizes to individual vs shared", () => {
    expect(normalizeStorageModeToUi("fixed_band")).toBe("individual");
    expect(normalizeStorageModeToUi("shared_inventory")).toBe("shared");
    expect(normalizeStorageModeToUi("shared_shipping")).toBe("shared");
    expect(normalizeStorageModeToUi("time_shared_storage")).toBe("individual");
  });

  it("classifies individual vs shared after legacy mapping", () => {
    expect(isSharedStorageMode("shared_shipping")).toBe(true);
    expect(isIndividualStorageMode("time_shared_storage")).toBe(true);
    expect(isIndividualStorageMode("fixed_band")).toBe(true);
    expect(isSharedStorageMode("shared_inventory")).toBe(true);
  });
});
