import { contextBridge, ipcRenderer } from "electron";

export type ScheduleResult = {
  scheduledSlots: Array<{
    id: string;
    customerId: string;
    resourceId: string;
    direction: string;
    mode: string;
    legKey?: string | null;
    volume: number;
    start: string;
    end: string;
    reservationStart?: string | null;
    reservationEnd?: string | null;
    status: string;
    conflictReason: string | null;
  }>;
  feasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }>;
  inventoryTimeline: Record<string, number[]>;
};

contextBridge.exposeInMainWorld("scenarioAPI", {
  list: () => ipcRenderer.invoke("scenario:list") as Promise<Array<{ id: string; name: string; created_at: string }>>,
  save: (name: string) => ipcRenderer.invoke("scenario:save", name) as Promise<void>,
  overwrite: (id: string) => ipcRenderer.invoke("scenario:overwrite", id) as Promise<void>,
  load: (id: string) => ipcRenderer.invoke("scenario:load", id) as Promise<void>,
  delete: (id: string) => ipcRenderer.invoke("scenario:delete", id) as Promise<void>,
  rename: (id: string, name: string) =>
    ipcRenderer.invoke("scenario:rename", id, name) as Promise<void>
});

contextBridge.exposeInMainWorld("schedulerAPI", {
  run: () => ipcRenderer.invoke("scheduler:run") as Promise<ScheduleResult>,
  getSlots: () => ipcRenderer.invoke("scheduler:getSlots"),
  getTweakState: () => ipcRenderer.invoke("scheduler:getTweakState"),
  sampleStochastic: (seed?: number) => ipcRenderer.invoke("scheduler:sampleStochastic", seed),
  getStochasticState: () => ipcRenderer.invoke("scheduler:getStochasticState"),
  clearStochastic: () => ipcRenderer.invoke("scheduler:clearStochastic"),
  runMonteCarlo: (payload: { iterations?: number; baseSeed?: number }) =>
    ipcRenderer.invoke("scheduler:runMonteCarlo", payload),
  getMonteCarloState: () => ipcRenderer.invoke("scheduler:getMonteCarloState"),
  setMonteCarloIteration: (index: number) => ipcRenderer.invoke("scheduler:setMonteCarloIteration", index),
  clearMonteCarlo: () => ipcRenderer.invoke("scheduler:clearMonteCarlo"),
  cancelMonteCarlo: () => ipcRenderer.invoke("scheduler:cancelMonteCarlo"),
  onMonteCarloProgress: (callback: (payload: { done: number; total: number; phase: string }) => void) => {
    const handler = (_e: unknown, payload: { done: number; total: number; phase: string }) =>
      callback(payload);
    ipcRenderer.on("scheduler:monteCarloProgress", handler);
    return () => ipcRenderer.removeListener("scheduler:monteCarloProgress", handler);
  },
  updateSimulation: () => ipcRenderer.invoke("scheduler:updateSimulation"),
  restoreBaseline: () => ipcRenderer.invoke("scheduler:restoreBaseline"),
  undo: () => ipcRenderer.invoke("scheduler:undo"),
  deleteSlot: (slotId: string) => ipcRenderer.invoke("scheduler:deleteSlot", slotId),
  upsertSlot: (payload: unknown) => ipcRenderer.invoke("scheduler:upsertSlot", payload),
  getInventoryTimeline: () => ipcRenderer.invoke("scheduler:getInventoryTimeline"),
  getSimulationLog: () => ipcRenderer.invoke("scheduler:getSimulationLog"),
  getFeasibilityWarnings: () =>
    ipcRenderer.invoke("scheduler:getFeasibilityWarnings") as Promise<
      Array<{ key: string; severity: "amber" | "red"; message: string }>
    >,
  exportSimulationExcel: () =>
    ipcRenderer.invoke("export:simulationExcel") as Promise<
      { ok: true; path: string } | { ok: false; error: string }
    >
});

contextBridge.exposeInMainWorld("dbAPI", {
  getCustomers: () => ipcRenderer.invoke("db:getCustomers"),
  createCustomer: (c: unknown) => ipcRenderer.invoke("db:createCustomer", c),
  updateCustomer: (c: unknown) => ipcRenderer.invoke("db:updateCustomer", c),
  deleteCustomer: (id: string) => ipcRenderer.invoke("db:deleteCustomer", id),
  getResources: () => ipcRenderer.invoke("db:getResources"),
  createResource: (r: unknown) => ipcRenderer.invoke("db:createResource", r),
  updateResource: (r: unknown) => ipcRenderer.invoke("db:updateResource", r),
  deleteResource: (id: string) => ipcRenderer.invoke("db:deleteResource", id),
  getTransportPools: () => ipcRenderer.invoke("db:getTransportPools"),
  createTransportPool: (p: unknown) => ipcRenderer.invoke("db:createTransportPool", p),
  updateTransportPool: (p: unknown) => ipcRenderer.invoke("db:updateTransportPool", p),
  deleteTransportPool: (id: string) => ipcRenderer.invoke("db:deleteTransportPool", id),
  getSimulationConfigs: () => ipcRenderer.invoke("db:getSimulationConfigs"),
  createSimulationConfig: (c: unknown) => ipcRenderer.invoke("db:createSimulationConfig", c),
  updateSimulationConfig: (id: string, c: unknown) => ipcRenderer.invoke("db:updateSimulationConfig", id, c)
});
