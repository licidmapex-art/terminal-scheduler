import { randomUUID } from "crypto";
import { getDatabase } from "./database";
import type { SimulationConfig, StorageMode } from "../types";

const STORAGE_MODES: readonly StorageMode[] = [
  "fixed_band",
  "shared_shipping",
  "time_shared_storage",
  "shared_inventory"
];

export function normalizeStorageMode(raw: string | undefined): StorageMode {
  if (raw === "commingled") return "shared_shipping";
  if (!raw) return "fixed_band";
  if (STORAGE_MODES.includes(raw as StorageMode)) return raw as StorageMode;
  return "fixed_band";
}

export interface SimulationConfigRow extends SimulationConfig {
  id: string;
}

function rowToConfig(r: {
  id: string;
  start_date: string;
  end_date: string;
  pipeline_flow_rate: number;
  pipeline_direction: string;
  total_storage_capacity?: number;
  storage_mode?: string;
  shared_inventory_customer_deficit_limit_tonnes?: number;
  min_slot_interval_hours?: number;
  pre_ops_hours?: number;
  post_ops_hours?: number;
  tank_count?: number;
  tank_capacity?: number;
  pacer_rounding_direction?: string;
  pacer_round_at_decile?: number;
  optimizer_relative_doc_multiplier?: number;
}): SimulationConfigRow {
  const rawDirection = r.pacer_rounding_direction === "down" ? "down" : "up";
  const rawDecile = Math.round(r.pacer_round_at_decile ?? 1);
  const decile = Number.isFinite(rawDecile) ? Math.min(9, Math.max(1, rawDecile)) : 1;
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(r.optimizer_relative_doc_multiplier ?? 0)
  );
  return {
    id: r.id,
    startDate: new Date(r.start_date),
    endDate: new Date(r.end_date),
    pipelineFlowRate: r.pipeline_flow_rate,
    pipelineDirection: r.pipeline_direction as SimulationConfig["pipelineDirection"],
    totalStorageCapacity: r.total_storage_capacity ?? 100000,
    storageMode: normalizeStorageMode(r.storage_mode),
    sharedInventoryCustomerDeficitLimitTonnes: Math.max(
      0,
      r.shared_inventory_customer_deficit_limit_tonnes ?? 0
    ),
    minSlotIntervalHours: r.min_slot_interval_hours ?? 0,
    pacerRoundingDirection: rawDirection,
    pacerRoundAtDecile: decile,
    optimizerRelativeDocMultiplier,
    preOpsHours: r.pre_ops_hours ?? 0,
    postOpsHours: r.post_ops_hours ?? 0,
    tankCount: r.tank_count ?? 4,
    tankCapacity: r.tank_capacity ?? 7000
  };
}

export function createSimulationConfig(config: SimulationConfig): SimulationConfigRow {
  const db = getDatabase();
  const id = randomUUID();
  const pacerDirection = config.pacerRoundingDirection === "down" ? "down" : "up";
  const pacerDecile = Math.min(9, Math.max(1, Math.round(config.pacerRoundAtDecile ?? 1)));
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeDocMultiplier ?? 0)
  );
  db.prepare(`
    INSERT INTO simulation_configs (id, start_date, end_date, pipeline_flow_rate, pipeline_direction, total_storage_capacity, storage_mode, shared_inventory_customer_deficit_limit_tonnes, pacer_rounding_direction, pacer_round_at_decile, optimizer_relative_doc_multiplier, min_slot_interval_hours, pre_ops_hours, post_ops_hours, tank_count, tank_capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    config.startDate.toISOString(),
    config.endDate.toISOString(),
    config.pipelineFlowRate,
    config.pipelineDirection,
    config.totalStorageCapacity ?? 100000,
    config.storageMode ?? "fixed_band",
    Math.max(0, config.sharedInventoryCustomerDeficitLimitTonnes ?? 0),
    pacerDirection,
    pacerDecile,
    optimizerRelativeDocMultiplier,
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000
  );
  return { ...config, id };
}

export function getAllSimulationConfigs(): SimulationConfigRow[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM simulation_configs").all() as Array<{
    id: string;
    start_date: string;
    end_date: string;
    pipeline_flow_rate: number;
    pipeline_direction: string;
    total_storage_capacity?: number;
    storage_mode?: string;
    min_slot_interval_hours?: number;
    pre_ops_hours?: number;
    post_ops_hours?: number;
    shared_inventory_customer_deficit_limit_tonnes?: number;
    tank_count?: number;
    tank_capacity?: number;
    pacer_rounding_direction?: string;
    pacer_round_at_decile?: number;
    optimizer_relative_doc_multiplier?: number;
  }>;
  return rows.map(rowToConfig);
}

export function getSimulationConfigById(id: string): SimulationConfigRow | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM simulation_configs WHERE id = ?").get(id) as {
    id: string;
    start_date: string;
    end_date: string;
    pipeline_flow_rate: number;
    pipeline_direction: string;
    total_storage_capacity?: number;
    storage_mode?: string;
    min_slot_interval_hours?: number;
    pre_ops_hours?: number;
    post_ops_hours?: number;
    shared_inventory_customer_deficit_limit_tonnes?: number;
    tank_count?: number;
    tank_capacity?: number;
    pacer_rounding_direction?: string;
    pacer_round_at_decile?: number;
    optimizer_relative_doc_multiplier?: number;
  } | undefined;
  if (!row) return null;
  return rowToConfig(row);
}

export function updateSimulationConfig(id: string, config: SimulationConfig): SimulationConfigRow {
  const db = getDatabase();
  const pacerDirection = config.pacerRoundingDirection === "down" ? "down" : "up";
  const pacerDecile = Math.min(9, Math.max(1, Math.round(config.pacerRoundAtDecile ?? 1)));
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeDocMultiplier ?? 0)
  );
  db.prepare(`
    UPDATE simulation_configs SET
      start_date = ?,
      end_date = ?,
      pipeline_flow_rate = ?,
      pipeline_direction = ?,
      total_storage_capacity = ?,
      storage_mode = ?,
      shared_inventory_customer_deficit_limit_tonnes = ?,
      pacer_rounding_direction = ?,
      pacer_round_at_decile = ?,
      optimizer_relative_doc_multiplier = ?,
      min_slot_interval_hours = ?,
      pre_ops_hours = ?,
      post_ops_hours = ?,
      tank_count = ?,
      tank_capacity = ?
    WHERE id = ?
  `).run(
    config.startDate.toISOString(),
    config.endDate.toISOString(),
    config.pipelineFlowRate,
    config.pipelineDirection,
    config.totalStorageCapacity ?? 100000,
    config.storageMode ?? "fixed_band",
    Math.max(0, config.sharedInventoryCustomerDeficitLimitTonnes ?? 0),
    pacerDirection,
    pacerDecile,
    optimizerRelativeDocMultiplier,
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000,
    id
  );
  return { ...config, id };
}

export function deleteSimulationConfig(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM simulation_configs WHERE id = ?").run(id);
}
