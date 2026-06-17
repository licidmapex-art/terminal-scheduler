import type { StorageMode } from "../types";

/** Map legacy DB values to the two active engine modes (Individual / Shared). */
export function parseStorageMode(raw: unknown): StorageMode {
  if (raw === "commingled" || raw === "shared_shipping") return "shared_inventory";
  if (raw === "time_shared_storage") return "fixed_band";
  if (raw === "fixed_band" || raw === "shared_inventory") return raw;
  return "fixed_band";
}

export function isSharedStorageMode(mode: StorageMode | string | undefined): boolean {
  return parseStorageMode(mode) === "shared_inventory";
}

export function isIndividualStorageMode(mode: StorageMode | string | undefined): boolean {
  return !isSharedStorageMode(mode);
}

export function normalizeStorageModeToUi(mode: StorageMode): "individual" | "shared" {
  return isSharedStorageMode(mode) ? "shared" : "individual";
}
