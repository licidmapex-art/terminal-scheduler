import type { CustomerTransportConfig } from "../types";
import { isPoolOnlyTransportRow } from "./customerTransports";

const MODE_LABEL: Record<CustomerTransportConfig["mode"], string> = {
  ship: "Ship",
  barge: "Barge",
  train: "Train",
  pool: "Pool"
};

/** Display label per row, numbering within each mode (Ship 1, Ship 2, Pool 1, …). */
export function legLabelsForTransports(rows: CustomerTransportConfig[]): string[] {
  const counts: Record<CustomerTransportConfig["mode"], number> = {
    ship: 0,
    barge: 0,
    train: 0,
    pool: 0
  };
  return rows.map((r) => {
    counts[r.mode] += 1;
    return `${MODE_LABEL[r.mode]} ${counts[r.mode]}`;
  });
}

export function modeDisplayName(mode: CustomerTransportConfig["mode"]): string {
  return MODE_LABEL[mode];
}

/** Rows shown in transport leg tables (scheduling legs + pool-only membership). */
export function transportLegEditorRows(rows: CustomerTransportConfig[]): CustomerTransportConfig[] {
  return rows;
}

export function schedulableLegLabels(rows: CustomerTransportConfig[]): string[] {
  return legLabelsForTransports(rows.filter((r) => !isPoolOnlyTransportRow(r)));
}
