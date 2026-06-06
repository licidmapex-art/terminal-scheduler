/**
 * Browser-compatible implementation of window.dbAPI.
 * Stores customers, resources, and simulation configs in memory.
 * The save/load buttons in App.tsx persist this state to a JSON file.
 */

import type { Customer, Resource, SimulationConfig, StorageMode } from "../types";

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

export interface SimulationConfigRow extends SimulationConfig {
  id: string;
}

export interface AppSnapshot {
  version: 1;
  customers: Customer[];
  resources: Array<{
    id: string;
    name: string;
    type: string;
    flowRate: number;
    blackouts: Array<{ id: string; resourceId: string; start: string; end: string }>;
  }>;
  simulationConfigs: Array<SimulationConfigRow & { startDate: string; endDate: string }>;
}

const uuid = () => globalThis.crypto.randomUUID();

// ── In-memory stores ─────────────────────────────────────────────────────────

export const _store = {
  customers: [] as Customer[],
  resources: [] as Resource[],
  simulationConfigs: [] as SimulationConfigRow[]
};

const LOCAL_STORAGE_KEY = "terminal-scheduler-app-snapshot";

function persistStoreToLocalStorage(): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(serializeStore()));
  } catch {
    /* quota or private mode */
  }
}

export function syncAppStoreToLocalStorage(): void {
  persistStoreToLocalStorage();
}

export function isValidAppSnapshot(raw: unknown): raw is AppSnapshot {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Record<string, unknown>;
  return Array.isArray(s.customers) && Array.isArray(s.resources);
}

function initStoreFromLocalStorage(): void {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidAppSnapshot(parsed)) return;
    applySnapshotToStore(parsed);
  } catch {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }
}

function applySnapshotToStore(snapshot: AppSnapshot): void {
  _store.customers = snapshot.customers ?? [];
  _store.resources = (snapshot.resources ?? []).map((r) => ({
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
  _store.simulationConfigs = (snapshot.simulationConfigs ?? []).map((c) => ({
    ...c,
    storageMode: normalizeStorageMode(c.storageMode),
    startDate: new Date(c.startDate as unknown as string),
    endDate: new Date(c.endDate as unknown as string)
  }));
}

// ── Customers ────────────────────────────────────────────────────────────────

export const browserDbApi = {
  getCustomers: (): Promise<Customer[]> => Promise.resolve([..._store.customers]),

  createCustomer: (c: unknown): Promise<Customer> => {
    const customer = c as Customer;
    _store.customers.push(customer);
    persistStoreToLocalStorage();
    return Promise.resolve(customer);
  },

  updateCustomer: (c: unknown): Promise<Customer> => {
    const customer = c as Customer;
    const idx = _store.customers.findIndex((x) => x.id === customer.id);
    if (idx >= 0) _store.customers[idx] = customer;
    persistStoreToLocalStorage();
    return Promise.resolve(customer);
  },

  deleteCustomer: (id: string): Promise<void> => {
    _store.customers = _store.customers.filter((c) => c.id !== id);
    persistStoreToLocalStorage();
    return Promise.resolve();
  },

  // ── Resources ──────────────────────────────────────────────────────────────

  getResources: (): Promise<Resource[]> =>
    Promise.resolve(
      _store.resources.map((r) => ({
        ...r,
        blackouts: r.blackouts.map((b) => ({
          ...b,
          start: b.start instanceof Date ? b.start : new Date(b.start as unknown as string),
          end: b.end instanceof Date ? b.end : new Date(b.end as unknown as string)
        }))
      }))
    ),

  createResource: (r: unknown): Promise<Resource> => {
    const resource = r as Resource;
    _store.resources.push(resource);
    persistStoreToLocalStorage();
    return Promise.resolve(resource);
  },

  updateResource: (r: unknown): Promise<Resource> => {
    const resource = r as Resource;
    const idx = _store.resources.findIndex((x) => x.id === resource.id);
    if (idx >= 0) _store.resources[idx] = resource;
    persistStoreToLocalStorage();
    return Promise.resolve(resource);
  },

  deleteResource: (id: string): Promise<void> => {
    _store.resources = _store.resources.filter((r) => r.id !== id);
    persistStoreToLocalStorage();
    return Promise.resolve();
  },

  // ── Simulation configs ─────────────────────────────────────────────────────

  getSimulationConfigs: (): Promise<SimulationConfigRow[]> => {
    return Promise.resolve(
      _store.simulationConfigs.map((c) => ({
        ...c,
        startDate: c.startDate instanceof Date ? c.startDate : new Date(c.startDate as unknown as string),
        endDate: c.endDate instanceof Date ? c.endDate : new Date(c.endDate as unknown as string)
      }))
    );
  },

  createSimulationConfig: (c: unknown): Promise<SimulationConfigRow> => {
    const config = c as SimulationConfig;
    const row: SimulationConfigRow = {
      ...config,
      id: uuid(),
      storageMode: normalizeStorageMode(config.storageMode)
    };
    _store.simulationConfigs = [row]; // only one config at a time
    persistStoreToLocalStorage();
    return Promise.resolve(row);
  },

  updateSimulationConfig: (id: string, c: unknown): Promise<SimulationConfigRow> => {
    const config = c as SimulationConfig;
    const row: SimulationConfigRow = {
      ...config,
      id,
      storageMode: normalizeStorageMode(config.storageMode)
    };
    const idx = _store.simulationConfigs.findIndex((x) => x.id === id);
    if (idx >= 0) {
      _store.simulationConfigs[idx] = row;
    } else {
      _store.simulationConfigs = [row];
    }
    persistStoreToLocalStorage();
    return Promise.resolve(row);
  }
};

// ── Serialization helpers (used by Save / Load buttons) ──────────────────────

export function serializeStore(): AppSnapshot {
  return {
    version: 1,
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
    simulationConfigs: _store.simulationConfigs.map((c) => ({
      ...c,
      startDate: c.startDate instanceof Date ? c.startDate.toISOString() : String(c.startDate),
      endDate: c.endDate instanceof Date ? c.endDate.toISOString() : String(c.endDate)
    })) as AppSnapshot["simulationConfigs"]
  };
}

export function hydrateStore(snapshot: AppSnapshot): void {
  applySnapshotToStore(snapshot);
  persistStoreToLocalStorage();
}

// Restore last session on page load (web build only)
initStoreFromLocalStorage();
