/**
 * Named scenario snapshots: customers, resources (incl. blackouts), and simulation config.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "./database";
import { getAllCustomers, createCustomer } from "./customers";
import { getAllResources, createResource } from "./resources";
import {
  getAllSimulationConfigs,
  createSimulationConfig,
  updateSimulationConfig,
  normalizeStorageMode
} from "./simulationConfigs";
import type { Customer, Resource, SimulationConfig } from "../types";

const DATA_VERSION = 1;

export interface ScenarioListRow {
  id: string;
  name: string;
  created_at: string;
}

interface SerializedBlackout {
  id: string;
  resourceId: string;
  start: string;
  end: string;
}

interface SerializedResource {
  id: string;
  name: string;
  type: string;
  flowRate: number;
  blackouts: SerializedBlackout[];
}

interface ScenarioPayload {
  v: number;
  customers: Customer[];
  resources: SerializedResource[];
  config: {
    startDate: string;
    endDate: string;
    pipelineFlowRate: number;
    pipelineDirection: string;
    totalStorageCapacity: number;
    storageMode: string;
    pacerRoundingDirection?: "up" | "down";
    pacerRoundAtDecile?: number;
    minSlotIntervalHours: number;
    preOpsHours?: number;
    postOpsHours?: number;
    tankCount?: number;
    tankCapacity?: number;
    sharedInventoryCustomerDeficitLimitTonnes?: number;
    optimizerRelativeDocMultiplier?: number;
    optimizerRelativeFulfillmentMultiplier?: number;
    bargeBerthAllocation?: "alternate" | "small_only" | "prefer_small";
  } | null;
}

export function listScenarios(): ScenarioListRow[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT id, name, created_at FROM scenarios ORDER BY created_at DESC")
    .all() as ScenarioListRow[];
  return rows;
}

function buildScenarioPayload(): ScenarioPayload {
  const customers = getAllCustomers();
  const resources = getAllResources();
  const configs = getAllSimulationConfigs();
  const cfg = configs[0] ?? null;

  return {
    v: DATA_VERSION,
    customers,
    resources: resources.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      flowRate: r.flowRate,
      blackouts: r.blackouts.map((b) => ({
        id: b.id,
        resourceId: b.resourceId,
        start: b.start.toISOString(),
        end: b.end.toISOString()
      }))
    })),
    config: cfg
      ? {
          startDate: cfg.startDate.toISOString(),
          endDate: cfg.endDate.toISOString(),
          pipelineFlowRate: cfg.pipelineFlowRate,
          pipelineDirection: cfg.pipelineDirection,
          totalStorageCapacity: cfg.totalStorageCapacity ?? 100000,
          storageMode: cfg.storageMode ?? "fixed_band",
          pacerRoundingDirection: cfg.pacerRoundingDirection ?? "up",
          pacerRoundAtDecile: cfg.pacerRoundAtDecile ?? 1,
          minSlotIntervalHours: cfg.minSlotIntervalHours ?? 0,
          preOpsHours: cfg.preOpsHours ?? 0,
          postOpsHours: cfg.postOpsHours ?? 0,
          tankCount: cfg.tankCount ?? 4,
          tankCapacity: cfg.tankCapacity ?? 7000,
          sharedInventoryCustomerDeficitLimitTonnes:
            cfg.sharedInventoryCustomerDeficitLimitTonnes ?? 0,
          optimizerRelativeDocMultiplier: cfg.optimizerRelativeDocMultiplier ?? 0,
          optimizerRelativeFulfillmentMultiplier: cfg.optimizerRelativeFulfillmentMultiplier ?? 0,
          bargeBerthAllocation: cfg.bargeBerthAllocation ?? "alternate"
        }
      : null
  };
}

export function saveScenario(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Scenario name is required");

  const db = getDatabase();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO scenarios (id, name, created_at, data) VALUES (?, ?, ?, ?)"
  ).run(id, trimmed, createdAt, JSON.stringify(buildScenarioPayload()));
}

export function overwriteScenario(id: string): void {
  const db = getDatabase();
  const row = db.prepare("SELECT id FROM scenarios WHERE id = ?").get(id);
  if (!row) throw new Error("Scenario not found");
  const createdAt = new Date().toISOString();
  db.prepare("UPDATE scenarios SET data = ?, created_at = ? WHERE id = ?").run(
    JSON.stringify(buildScenarioPayload()),
    createdAt,
    id
  );
}

function clearOperationalData(db: ReturnType<typeof getDatabase>): void {
  db.exec("DELETE FROM scheduled_slots");
  db.exec("DELETE FROM inventory_snapshots");
  db.exec("DELETE FROM blackouts");
  db.exec("DELETE FROM resources");
  db.exec("DELETE FROM customers");
  db.exec("DELETE FROM simulation_configs");
}

export function loadScenario(id: string): void {
  const db = getDatabase();
  const row = db.prepare("SELECT data FROM scenarios WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  if (!row) throw new Error("Scenario not found");

  let payload: ScenarioPayload;
  try {
    payload = JSON.parse(row.data) as ScenarioPayload;
  } catch {
    throw new Error("Invalid scenario data");
  }
  if (!payload.customers || !Array.isArray(payload.resources)) {
    throw new Error("Invalid scenario format");
  }

  db.transaction(() => {
    clearOperationalData(db);

    const cfgRate = payload.config?.pipelineFlowRate ?? 0;
    for (const raw of payload.customers) {
      const c = raw as Customer & { pipelineShare?: number };
      const { pipelineShare: _legacyShare, ...base } = c;
      const pipelineFlowPerHour =
        typeof c.pipelineFlowPerHour === "number"
          ? c.pipelineFlowPerHour
          : ((_legacyShare ?? 0) * cfgRate) / 100;
      createCustomer({
        ...base,
        pipelineFlowPerHour,
        pipelineInboundPerHour:
          typeof c.pipelineInboundPerHour === "number"
            ? c.pipelineInboundPerHour
            : Math.max(0, pipelineFlowPerHour),
        pipelineOutboundPerHour:
          typeof c.pipelineOutboundPerHour === "number"
            ? c.pipelineOutboundPerHour
            : Math.max(0, -pipelineFlowPerHour),
        timeSharedMinBand: c.timeSharedMinBand ?? 0,
        timeSharedDuration: c.timeSharedDuration ?? 24
      });
    }

    for (const r of payload.resources) {
      const resource: Resource = {
        id: r.id,
        name: r.name,
        type: r.type as Resource["type"],
        flowRate: r.flowRate,
        blackouts: r.blackouts.map((b) => ({
          id: b.id,
          resourceId: b.resourceId,
          start: new Date(b.start),
          end: new Date(b.end)
        }))
      };
      createResource(resource);
    }

    if (payload.config) {
      const cfg: SimulationConfig = {
        startDate: new Date(payload.config.startDate),
        endDate: new Date(payload.config.endDate),
        pipelineFlowRate: 0,
        pipelineDirection: payload.config.pipelineDirection as SimulationConfig["pipelineDirection"],
        totalStorageCapacity: payload.config.totalStorageCapacity ?? 100000,
        storageMode: normalizeStorageMode(payload.config.storageMode),
        pacerRoundingDirection: payload.config.pacerRoundingDirection === "down" ? "down" : "up",
        pacerRoundAtDecile: Math.min(9, Math.max(1, Math.round(payload.config.pacerRoundAtDecile ?? 1))),
        minSlotIntervalHours: payload.config.minSlotIntervalHours ?? 0,
        preOpsHours: payload.config.preOpsHours ?? 0,
        postOpsHours: payload.config.postOpsHours ?? 0,
        tankCount: payload.config.tankCount ?? 4,
        tankCapacity: payload.config.tankCapacity ?? 7000,
        sharedInventoryCustomerDeficitLimitTonnes: Math.max(
          0,
          payload.config.sharedInventoryCustomerDeficitLimitTonnes ??
            (payload.config as { sharedInventoryMinStockTonnes?: number }).sharedInventoryMinStockTonnes ??
            0
        ),
        optimizerRelativeDocMultiplier: Math.max(
          0,
          Number(payload.config.optimizerRelativeDocMultiplier ?? 0)
        ),
        optimizerRelativeFulfillmentMultiplier: Math.max(
          0,
          Number(payload.config.optimizerRelativeFulfillmentMultiplier ?? 0)
        ),
        bargeBerthAllocation:
          payload.config.bargeBerthAllocation === "small_only" ||
          payload.config.bargeBerthAllocation === "prefer_small"
            ? payload.config.bargeBerthAllocation
            : "alternate"
      };
      const created = createSimulationConfig(cfg);
      updateSimulationConfig(created.id, cfg);
    }
  })();
}

export function deleteScenario(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM scenarios WHERE id = ?").run(id);
}

export function renameScenario(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");
  const db = getDatabase();
  const res = db.prepare("UPDATE scenarios SET name = ? WHERE id = ?").run(trimmed, id);
  if (res.changes === 0) throw new Error("Scenario not found");
}
