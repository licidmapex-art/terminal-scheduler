import type { SimulationConfig } from "../types";

export interface SimulationConfigRow extends SimulationConfig {
  id: string;
}

/** Strip DB id — use for scheduler / replay. */
export function simulationConfigFromRow(row: SimulationConfigRow): SimulationConfig {
  const { id: _id, ...config } = row;
  return config;
}
