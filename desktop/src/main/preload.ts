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
    status: string;
    conflictReason: string | null;
  }>;
  feasibilityWarnings: string[];
  inventoryTimeline: Record<string, number[]>;
};

contextBridge.exposeInMainWorld("scenarioAPI", {
  list: () => ipcRenderer.invoke("scenario:list") as Promise<Array<{ id: string; name: string; created_at: string }>>,
  save: (name: string) => ipcRenderer.invoke("scenario:save", name) as Promise<void>,
  load: (id: string) => ipcRenderer.invoke("scenario:load", id) as Promise<void>,
  delete: (id: string) => ipcRenderer.invoke("scenario:delete", id) as Promise<void>,
  rename: (id: string, name: string) =>
    ipcRenderer.invoke("scenario:rename", id, name) as Promise<void>
});

contextBridge.exposeInMainWorld("schedulerAPI", {
  run: () => ipcRenderer.invoke("scheduler:run") as Promise<ScheduleResult>,
  getSlots: () => ipcRenderer.invoke("scheduler:getSlots"),
  getInventoryTimeline: () => ipcRenderer.invoke("scheduler:getInventoryTimeline"),
  getSimulationLog: () => ipcRenderer.invoke("scheduler:getSimulationLog"),
  getFeasibilityWarnings: () => ipcRenderer.invoke("scheduler:getFeasibilityWarnings") as Promise<string[]>,
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
  getSimulationConfigs: () => ipcRenderer.invoke("db:getSimulationConfigs"),
  createSimulationConfig: (c: unknown) => ipcRenderer.invoke("db:createSimulationConfig", c),
  updateSimulationConfig: (id: string, c: unknown) => ipcRenderer.invoke("db:updateSimulationConfig", id, c)
});
