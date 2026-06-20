import { getDatabase } from "./database";
import type { SimulationConfig, StorageMode, SustainabilityGrade, StochasticConfig } from "../types";
import { normalizeBargeBerthAllocation } from "../engine/resourceAllocation";
import type { SimulationConfigRow } from "../lib/simulationConfigRow";
import { simulationConfigFromRow } from "../lib/simulationConfigRow";

export { simulationConfigFromRow, type SimulationConfigRow } from "../lib/simulationConfigRow";

const randomUUID = () => globalThis.crypto.randomUUID();

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

function normalizeDeficitMode(raw: string | undefined): "tonnes" | "percent" {
  return raw === "percent" ? "percent" : "tonnes";
}

function normalizeBerthReservationMode(
  raw: string | undefined
): SimulationConfig["berthReservationMode"] {
  if (raw === "window_of_arrival" || raw === "laycan") return raw;
  return "none";
}

function normalizeBorrowingGradeScope(
  raw: string | undefined
): SimulationConfig["borrowingGradeScope"] {
  if (raw === "same_grade" || raw === "selected_grades") return raw;
  return "all";
}

function parseSelectedBorrowingGrades(
  json: string | null | undefined
): SustainabilityGrade[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (g): g is SustainabilityGrade => g === "green" || g === "blue" || g === "grey"
    );
  } catch {
    return undefined;
  }
}

function parsePerGradeDeficitLimits(
  json: string | null | undefined
): Partial<Record<SustainabilityGrade, number>> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const out: Partial<Record<SustainabilityGrade, number>> = {};
    for (const g of ["green", "blue", "grey"] as const) {
      const v = parsed[g];
      if (typeof v === "number" && Number.isFinite(v)) out[g] = Math.max(0, v);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function parseStochasticConfig(json: string | null | undefined): StochasticConfig | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as StochasticConfig;
  } catch {
    return undefined;
  }
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
  grade_mass_balancing_enabled?: number;
  grade_mass_balance_deficit_limit_tonnes?: number;
  grade_mass_balance_deficit_mode?: string;
  grade_mass_balance_deficit_limit_pct?: number;
  barge_berth_allocation?: string;
  berth_reservation_mode?: string;
  feasibility_warnings_json?: string | null;
  borrowing_grade_scope?: string;
  selected_borrowing_grades_json?: string | null;
  per_grade_deficit_limit_json?: string | null;
  stochastic_config_json?: string | null;
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
    gradeMassBalancingEnabled: !!r.grade_mass_balancing_enabled,
    gradeMassBalanceDeficitMode: normalizeDeficitMode(r.grade_mass_balance_deficit_mode),
    gradeMassBalanceDeficitLimitTonnes: Math.max(
      0,
      Number(r.grade_mass_balance_deficit_limit_tonnes ?? 0)
    ),
    gradeMassBalanceDeficitLimitPct: Math.max(0, Number(r.grade_mass_balance_deficit_limit_pct ?? 0)),
    preOpsHours: r.pre_ops_hours ?? 0,
    postOpsHours: r.post_ops_hours ?? 0,
    tankCount: r.tank_count ?? 4,
    tankCapacity: r.tank_capacity ?? 7000,
    bargeBerthAllocation: normalizeBargeBerthAllocation(r.barge_berth_allocation),
    berthReservationMode: normalizeBerthReservationMode(r.berth_reservation_mode),
    feasibilityWarnings: (() => {
      if (!r.feasibility_warnings_json) return undefined;
      try {
        const parsed = JSON.parse(r.feasibility_warnings_json) as unknown;
        return (parsed && typeof parsed === "object") ? (parsed as SimulationConfig["feasibilityWarnings"]) : undefined;
      } catch {
        return undefined;
      }
    })(),
    borrowingGradeScope: normalizeBorrowingGradeScope(r.borrowing_grade_scope),
    selectedBorrowingGrades: parseSelectedBorrowingGrades(r.selected_borrowing_grades_json),
    perGradeDeficitLimitTonnes: parsePerGradeDeficitLimits(r.per_grade_deficit_limit_json),
    stochasticConfig: parseStochasticConfig(r.stochastic_config_json)
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
      grade_mass_balancing_enabled, grade_mass_balance_deficit_limit_tonnes,
      grade_mass_balance_deficit_mode, grade_mass_balance_deficit_limit_pct,
      min_slot_interval_hours, pre_ops_hours, post_ops_hours, tank_count, tank_capacity, barge_berth_allocation,
      berth_reservation_mode, feasibility_warnings_json,
      borrowing_grade_scope, selected_borrowing_grades_json, per_grade_deficit_limit_json,
      stochastic_config_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    config.gradeMassBalancingEnabled ? 1 : 0,
    Math.max(0, config.gradeMassBalanceDeficitLimitTonnes ?? 0),
    normalizeDeficitMode(config.gradeMassBalanceDeficitMode),
    Math.max(0, config.gradeMassBalanceDeficitLimitPct ?? 0),
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000,
    normalizeBargeBerthAllocation(config.bargeBerthAllocation),
    normalizeBerthReservationMode(config.berthReservationMode),
    config.feasibilityWarnings ? JSON.stringify(config.feasibilityWarnings) : null,
    normalizeBorrowingGradeScope(config.borrowingGradeScope),
    config.selectedBorrowingGrades?.length
      ? JSON.stringify(config.selectedBorrowingGrades)
      : null,
    config.perGradeDeficitLimitTonnes
      ? JSON.stringify(config.perGradeDeficitLimitTonnes)
      : null,
    config.stochasticConfig ? JSON.stringify(config.stochasticConfig) : null
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
    grade_mass_balancing_enabled?: number;
    grade_mass_balance_deficit_limit_tonnes?: number;
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
    grade_mass_balancing_enabled?: number;
    grade_mass_balance_deficit_limit_tonnes?: number;
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
      grade_mass_balancing_enabled = ?,
      grade_mass_balance_deficit_limit_tonnes = ?,
      grade_mass_balance_deficit_mode = ?,
      grade_mass_balance_deficit_limit_pct = ?,
      min_slot_interval_hours = ?,
      pre_ops_hours = ?,
      post_ops_hours = ?,
      tank_count = ?,
      tank_capacity = ?,
      barge_berth_allocation = ?,
      berth_reservation_mode = ?,
      feasibility_warnings_json = ?,
      borrowing_grade_scope = ?,
      selected_borrowing_grades_json = ?,
      per_grade_deficit_limit_json = ?,
      stochastic_config_json = ?
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
    config.gradeMassBalancingEnabled ? 1 : 0,
    Math.max(0, config.gradeMassBalanceDeficitLimitTonnes ?? 0),
    normalizeDeficitMode(config.gradeMassBalanceDeficitMode),
    Math.max(0, config.gradeMassBalanceDeficitLimitPct ?? 0),
    config.minSlotIntervalHours ?? 0,
    config.preOpsHours ?? 0,
    config.postOpsHours ?? 0,
    config.tankCount ?? 4,
    config.tankCapacity ?? 7000,
    normalizeBargeBerthAllocation(config.bargeBerthAllocation),
    normalizeBerthReservationMode(config.berthReservationMode),
    config.feasibilityWarnings ? JSON.stringify(config.feasibilityWarnings) : null,
    normalizeBorrowingGradeScope(config.borrowingGradeScope),
    config.selectedBorrowingGrades?.length
      ? JSON.stringify(config.selectedBorrowingGrades)
      : null,
    config.perGradeDeficitLimitTonnes
      ? JSON.stringify(config.perGradeDeficitLimitTonnes)
      : null,
    config.stochasticConfig ? JSON.stringify(config.stochasticConfig) : null,
    id
  );
  return { ...config, id };
}

export function deleteSimulationConfig(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM simulation_configs WHERE id = ?").run(id);
}
