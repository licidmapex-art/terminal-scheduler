/**
 * Browser-compatible implementation of window.scenarioAPI.
 * Scenarios are stored in localStorage as JSON blobs.
 */

import type { Customer, Resource, SimulationConfig, StorageMode } from "../types";
import { _store } from "./db-api";

const STORAGE_MODES: readonly StorageMode[] = [
  "fixed_band",
  "shared_shipping",
  "time_shared_storage",
  "shared_inventory"
];
function normalizeStorageMode(raw: string | undefined): StorageMode {
  if (raw === "commingled") return "shared_shipping";
  if (!raw) return "fixed_band";
  if (STORAGE_MODES.includes(raw as StorageMode)) return raw as StorageMode;
  return "fixed_band";
}

const uuid = () => globalThis.crypto.randomUUID();
const LS_KEY = "terminal-scheduler-scenarios";

interface StoredScenario {
  id: string;
  name: string;
  created_at: string;
  data: string;
}

function readAll(): StoredScenario[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as StoredScenario[]) : [];
  } catch {
    return [];
  }
}

function writeAll(rows: StoredScenario[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(rows));
}

export const browserScenarioApi = {
  list: (): Promise<Array<{ id: string; name: string; created_at: string }>> => {
    return Promise.resolve(
      readAll()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .map(({ id, name, created_at }) => ({ id, name, created_at }))
    );
  },

  save: (name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("Scenario name is required"));

    const payload = {
      v: 1,
      customers: _store.customers,
      resources: _store.resources.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        flowRate: r.flowRate,
        blackouts: r.blackouts.map((b) => ({
          id: b.id,
          resourceId: b.resourceId,
          start: b.start instanceof Date ? b.start.toISOString() : String(b.start),
          end: b.end instanceof Date ? b.end.toISOString() : String(b.end)
        }))
      })),
      config: _store.simulationConfigs[0]
        ? {
            ...(_store.simulationConfigs[0] as SimulationConfig & { id: string }),
            startDate:
              _store.simulationConfigs[0].startDate instanceof Date
                ? _store.simulationConfigs[0].startDate.toISOString()
                : String(_store.simulationConfigs[0].startDate),
            endDate:
              _store.simulationConfigs[0].endDate instanceof Date
                ? _store.simulationConfigs[0].endDate.toISOString()
                : String(_store.simulationConfigs[0].endDate)
          }
        : null
    };

    const rows = readAll();
    rows.push({ id: uuid(), name: trimmed, created_at: new Date().toISOString(), data: JSON.stringify(payload) });
    writeAll(rows);
    return Promise.resolve();
  },

  load: (id: string): Promise<void> => {
    const rows = readAll();
    const row = rows.find((r) => r.id === id);
    if (!row) return Promise.reject(new Error("Scenario not found"));

    let payload: {
      v: number;
      customers: Customer[];
      resources: Array<{
        id: string;
        name: string;
        type: string;
        flowRate: number;
        blackouts: Array<{ id: string; resourceId: string; start: string; end: string }>;
      }>;
      config: (SimulationConfig & { startDate: string; endDate: string; id?: string }) | null;
    };
    try {
      payload = JSON.parse(row.data);
    } catch {
      return Promise.reject(new Error("Invalid scenario data"));
    }

    _store.customers = payload.customers ?? [];
    _store.resources = (payload.resources ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as Resource["type"],
      flowRate: r.flowRate,
      blackouts: (r.blackouts ?? []).map((b) => ({
        id: b.id,
        resourceId: b.resourceId,
        start: new Date(b.start),
        end: new Date(b.end)
      }))
    }));

    if (payload.config) {
      const cfg = payload.config;
      _store.simulationConfigs = [
        {
          ...cfg,
          id: cfg.id ?? uuid(),
          startDate: new Date(cfg.startDate),
          endDate: new Date(cfg.endDate),
          storageMode: normalizeStorageMode(cfg.storageMode)
        }
      ];
    } else {
      _store.simulationConfigs = [];
    }

    return Promise.resolve();
  },

  delete: (id: string): Promise<void> => {
    writeAll(readAll().filter((r) => r.id !== id));
    return Promise.resolve();
  },

  rename: (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("Name is required"));
    const rows = readAll();
    const row = rows.find((r) => r.id === id);
    if (!row) return Promise.reject(new Error("Scenario not found"));
    row.name = trimmed;
    writeAll(rows);
    return Promise.resolve();
  }
};
