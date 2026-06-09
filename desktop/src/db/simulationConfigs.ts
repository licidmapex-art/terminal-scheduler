import { randomUUID } from "crypto";
import { getDatabase } from "./database";
import type { SimulationConfig, StorageMode } from "../types";
import { normalizeBargeBerthAllocation } from "../engine/resourceAllocation";

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

function normalizePacerDecile(raw: number | undefined, fallback = 1): number {
  const d = Math.round(raw ?? fallback);
  return Number.isFinite(d) ? Math.min(9, Math.max(1, d)) : fallback;
}

function normalizePacerAllowance(raw: number | undefined, fallback = 0.5): number {
  const a = Number(raw ?? fallback);
  return Number.isFinite(a) ? a : fallback;
}

function pacerFieldsFromRow(r: {
  pacer_inbound_round_at_decile?: number;
  pacer_inbound_allowance?: number;
  pacer_outbound_round_at_decile?: number;
  pacer_outbound_allowance?: number;
  pacer_round_at_decile?: number;
}): Pick<
  SimulationConfig,
  | "pacerInboundRoundAtDecile"
  | "pacerInboundAllowance"
  | "pacerOutboundRoundAtDecile"
  | "pacerOutboundAllowance"
> {
  const legacyDecile = normalizePacerDecile(r.pacer_round_at_decile);
  return {
    pacerInboundRoundAtDecile: normalizePacerDecile(r.pacer_inbound_round_at_decile, legacyDecile),
    pacerInboundAllowance: normalizePacerAllowance(r.pacer_inbound_allowance, 0.5),
    pacerOutboundRoundAtDecile: normalizePacerDecile(r.pacer_outbound_round_at_decile, legacyDecile),
    pacerOutboundAllowance: normalizePacerAllowance(r.pacer_outbound_allowance, 0.5)
  };
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
  pacer_inbound_round_at_decile?: number;
  pacer_inbound_allowance?: number;
  pacer_outbound_round_at_decile?: number;
  pacer_outbound_allowance?: number;
  pacer_round_at_decile?: number;
  optimizer_relative_doc_multiplier?: number;
  optimizer_relative_fulfillment_multiplier?: number;
  barge_berth_allocation?: string;
}): SimulationConfigRow {
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(r.optimizer_relative_doc_multiplier ?? 0)
  );
  const optimizerRelativeFulfillmentMultiplier = Math.max(
    0,
    Number(r.optimizer_relative_fulfillment_multiplier ?? 0)
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
    ...pacerFieldsFromRow(r),
    optimizerRelativeDocMultiplier,
    optimizerRelativeFulfillmentMultiplier,
    preOpsHours: r.pre_ops_hours ?? 0,
    postOpsHours: r.post_ops_hours ?? 0,
    tankCount: r.tank_count ?? 4,
    tankCapacity: r.tank_capacity ?? 7000,
    bargeBerthAllocation: normalizeBargeBerthAllocation(r.barge_berth_allocation)
  };
}

function pacerFieldsFromConfig(config: SimulationConfig) {
  const legacy = normalizePacerDecile(config.pacerRoundAtDecile);
  return {
    inboundDecile: normalizePacerDecile(config.pacerInboundRoundAtDecile, legacy),
    inboundAllowance: normalizePacerAllowance(config.pacerInboundAllowance, 0.5),
    outboundDecile: normalizePacerDecile(config.pacerOutboundRoundAtDecile, legacy),
    outboundAllowance: normalizePacerAllowance(config.pacerOutboundAllowance, 0.5)
  };
}

export function createSimulationConfig(config: SimulationConfig): SimulationConfigRow {
  const db = getDatabase();
  const id = randomUUID();
  const pacer = pacerFieldsFromConfig(config);
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeDocMultiplier ?? 0)
  );
  const optimizerRelativeFulfillmentMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeFulfillmentMultiplier ?? 0)
  );
  db.prepare(`
    INSERT INTO simulation_configs (
      id, start_date, end_date, pipeline_flow_rate, pipeline_direction, total_storage_capacity,
      storage_mode, shared_inventory_customer_deficit_limit_tonnes,
      pacer_rounding_direction, pacer_round_at_decile,
      pacer_inbound_round_at_decile, pacer_inbound_allowance,
      pacer_outbound_round_at_decile, pacer_outbound_allowance,
      optimizer_relative_doc_multiplier, optimizer_relative_fulfillment_multiplier,
      min_slot_interval_hours, pre_ops_hours, post_ops_hours, tank_count, tank_capacity, barge_berth_allocation
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    config.startDate.toISOString(),
    config.endDate.toISOString(),
    config.pipelineFlowRate,
    config.pipelineDirection,
    config.totalStorageCapacity ?? 100000,
    config.storageMode ?? "fixed_band",
    Math.max(0, config.sharedInventoryCustomerDeficitLimitTonnes ?? 0),
    "up",
    pacer.inboundDecile,
    pacer.inboundDecile,
    pacer.inboundAllowance,
    pacer.outboundDecile,
    pacer.outboundAllowance,
    optimizerRelativeDocMultiplier,
    optimizerRelativeFulfillmentMultiplier,
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000,
    normalizeBargeBerthAllocation(config.bargeBerthAllocation)
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
    pacer_inbound_round_at_decile?: number;
    pacer_inbound_allowance?: number;
    pacer_outbound_round_at_decile?: number;
    pacer_outbound_allowance?: number;
    pacer_round_at_decile?: number;
    optimizer_relative_doc_multiplier?: number;
    optimizer_relative_fulfillment_multiplier?: number;
    barge_berth_allocation?: string;
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
    pacer_inbound_round_at_decile?: number;
    pacer_inbound_allowance?: number;
    pacer_outbound_round_at_decile?: number;
    pacer_outbound_allowance?: number;
    pacer_round_at_decile?: number;
    optimizer_relative_doc_multiplier?: number;
    optimizer_relative_fulfillment_multiplier?: number;
    barge_berth_allocation?: string;
  } | undefined;
  if (!row) return null;
  return rowToConfig(row);
}

export function updateSimulationConfig(id: string, config: SimulationConfig): SimulationConfigRow {
  const db = getDatabase();
  const pacer = pacerFieldsFromConfig(config);
  const optimizerRelativeDocMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeDocMultiplier ?? 0)
  );
  const optimizerRelativeFulfillmentMultiplier = Math.max(
    0,
    Number(config.optimizerRelativeFulfillmentMultiplier ?? 0)
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
      pacer_inbound_round_at_decile = ?,
      pacer_inbound_allowance = ?,
      pacer_outbound_round_at_decile = ?,
      pacer_outbound_allowance = ?,
      optimizer_relative_doc_multiplier = ?,
      optimizer_relative_fulfillment_multiplier = ?,
      min_slot_interval_hours = ?,
      pre_ops_hours = ?,
      post_ops_hours = ?,
      tank_count = ?,
      tank_capacity = ?,
      barge_berth_allocation = ?
    WHERE id = ?
  `).run(
    config.startDate.toISOString(),
    config.endDate.toISOString(),
    config.pipelineFlowRate,
    config.pipelineDirection,
    config.totalStorageCapacity ?? 100000,
    config.storageMode ?? "fixed_band",
    Math.max(0, config.sharedInventoryCustomerDeficitLimitTonnes ?? 0),
    "up",
    pacer.inboundDecile,
    pacer.inboundDecile,
    pacer.inboundAllowance,
    pacer.outboundDecile,
    pacer.outboundAllowance,
    optimizerRelativeDocMultiplier,
    optimizerRelativeFulfillmentMultiplier,
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000,
    normalizeBargeBerthAllocation(config.bargeBerthAllocation),
    id
  );
  return { ...config, id };
}

export function deleteSimulationConfig(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM simulation_configs WHERE id = ?").run(id);
}
