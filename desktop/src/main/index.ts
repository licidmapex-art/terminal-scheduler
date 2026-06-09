import { app, BrowserWindow, ipcMain, dialog } from "electron";
import fs from "fs";
import path from "path";

const logFile = path.join(app.getPath("userData"), "scheduler-debug.log");
const logStream = fs.createWriteStream(logFile, { flags: "w" });
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  originalLog(...args);
  logStream.write(
    args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") + "\n"
  );
};
import {
  getAllCustomers,
  getAllResources,
  getAllScheduledSlots,
  createScheduledSlot,
  deleteAllScheduledSlots,
  getAllSimulationConfigs,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  createResource,
  updateResource,
  deleteResource,
  createSimulationConfig,
  updateSimulationConfig,
  listScenarios,
  saveScenario,
  overwriteScenario,
  loadScenario,
  deleteScenario,
  renameScenario
} from "../db";
import { runScheduler } from "../engine";
import { buildSimulationWorkbook, writeSimulationWorkbookToBuffer } from "../engine/simulationExcelExport";
import type { SimulationConfig, ScheduledSlot, ResourceType } from "../types";
import type { SimulationLogRow } from "../engine/simulationLog";

let lastInventoryTimeline: Record<string, number[]> = {};
let lastSimulationConfig: SimulationConfig | null = null;
let lastSimulationLog: SimulationLogRow[] = [];
let lastFeasibilityWarnings: string[] = [];

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    const rendererPath = path.join(app.getAppPath(), "dist", "renderer", "index.html");
    mainWindow.loadFile(rendererPath);
  }
}

function serializeSlot(slot: ScheduledSlot) {
  return {
    ...slot,
    start: slot.start.toISOString(),
    end: slot.end.toISOString()
  };
}

function resolveExportSimulationConfig(): SimulationConfig {
  if (lastSimulationConfig) return lastSimulationConfig;
  const configs = getAllSimulationConfigs();
  return configs[0]
    ? {
        startDate: configs[0].startDate,
        endDate: configs[0].endDate,
        pipelineFlowRate: configs[0].pipelineFlowRate,
        pipelineDirection: configs[0].pipelineDirection,
        totalStorageCapacity: configs[0].totalStorageCapacity ?? 100000,
        storageMode: configs[0].storageMode ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: configs[0].sharedInventoryCustomerDeficitLimitTonnes ?? 0,
        pacerRoundingDirection: configs[0].pacerRoundingDirection ?? "up",
        pacerRoundAtDecile: configs[0].pacerRoundAtDecile ?? 1,
        optimizerRelativeDocMultiplier: configs[0].optimizerRelativeDocMultiplier ?? 0,
        optimizerRelativeFulfillmentMultiplier: configs[0].optimizerRelativeFulfillmentMultiplier ?? 0,
        minSlotIntervalHours: configs[0].minSlotIntervalHours ?? 0,
        preOpsHours: configs[0].preOpsHours ?? 0,
        postOpsHours: configs[0].postOpsHours ?? 0,
        tankCount: configs[0].tankCount ?? 4,
        tankCapacity: configs[0].tankCapacity ?? 7000
      }
    : {
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        pipelineFlowRate: 0,
        pipelineDirection: "inbound",
        totalStorageCapacity: 100000,
        storageMode: "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: 0,
        pacerRoundingDirection: "up",
        pacerRoundAtDecile: 1,
        optimizerRelativeDocMultiplier: 0,
        optimizerRelativeFulfillmentMultiplier: 0,
        minSlotIntervalHours: 0,
        preOpsHours: 0,
        postOpsHours: 0,
        tankCount: 4,
        tankCapacity: 7000
      };
}

ipcMain.handle("scheduler:run", async () => {
  const customers = getAllCustomers();
  const resources = getAllResources();
  const configs = getAllSimulationConfigs();

  console.log(
    "[scheduler:run] Loaded",
    customers.length,
    "customers,",
    resources.length,
    "resources"
  );

  if (customers.length === 0 || resources.length === 0) {
    lastSimulationLog = [];
    lastFeasibilityWarnings = ["Add customers and resources before running the scheduler"];
    return {
      scheduledSlots: [],
      feasibilityWarnings: lastFeasibilityWarnings,
      inventoryTimeline: {}
    };
  }

  const config: SimulationConfig = configs[0]
    ? {
        startDate: configs[0].startDate,
        endDate: configs[0].endDate,
        pipelineFlowRate: configs[0].pipelineFlowRate,
        pipelineDirection: configs[0].pipelineDirection,
        totalStorageCapacity: configs[0].totalStorageCapacity ?? 100000,
        storageMode: configs[0].storageMode ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: configs[0].sharedInventoryCustomerDeficitLimitTonnes ?? 0,
        pacerRoundingDirection: configs[0].pacerRoundingDirection ?? "up",
        pacerRoundAtDecile: configs[0].pacerRoundAtDecile ?? 1,
        optimizerRelativeDocMultiplier: configs[0].optimizerRelativeDocMultiplier ?? 0,
        optimizerRelativeFulfillmentMultiplier: configs[0].optimizerRelativeFulfillmentMultiplier ?? 0,
        minSlotIntervalHours: configs[0].minSlotIntervalHours ?? 0,
        preOpsHours: configs[0].preOpsHours ?? 0,
        postOpsHours: configs[0].postOpsHours ?? 0,
        tankCount: configs[0].tankCount ?? 4,
        tankCapacity: configs[0].tankCapacity ?? 7000
      }
    : {
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        pipelineFlowRate: 0,
        pipelineDirection: "inbound" as const,
        totalStorageCapacity: 100000,
        storageMode: "fixed_band" as const,
        sharedInventoryCustomerDeficitLimitTonnes: 0,
        pacerRoundingDirection: "up" as const,
        pacerRoundAtDecile: 1,
        optimizerRelativeDocMultiplier: 0,
        optimizerRelativeFulfillmentMultiplier: 0,
        minSlotIntervalHours: 0,
        preOpsHours: 0,
        postOpsHours: 0,
        tankCount: 4,
        tankCapacity: 7000
      };

  const result = runScheduler(customers, resources, config);

  console.log("[scheduler:run] Scheduled slots:", result.scheduledSlots.length);

  if (result.feasibilityWarnings.length > 0) {
    console.log("[feasibility] Warnings count:", result.feasibilityWarnings.length);
    result.feasibilityWarnings.forEach((w) => console.log("[feasibility]", w));
  } else {
    console.log("[feasibility] No warnings");
  }

  deleteAllScheduledSlots();
  for (const slot of result.scheduledSlots) {
    createScheduledSlot(slot);
  }

  lastInventoryTimeline = Object.fromEntries(result.inventoryTimeline);
  lastSimulationConfig = config;
  lastSimulationLog = result.simulationLog;
  lastFeasibilityWarnings = [...result.feasibilityWarnings];

  result.scheduledSlots.forEach((s) => {
    console.log("[scheduled]", {
      direction: s.direction,
      mode: s.mode,
      volume: s.volume,
      status: s.status,
      start: s.start,
      end: s.end,
      resource: s.resourceId
    });
  });

  return {
    scheduledSlots: result.scheduledSlots.map(serializeSlot),
    feasibilityWarnings: result.feasibilityWarnings,
    inventoryTimeline: lastInventoryTimeline
  };
});

ipcMain.handle("scheduler:getSlots", async () => {
  const slots = getAllScheduledSlots();
  return slots.map(serializeSlot);
});

ipcMain.handle("scheduler:getSimulationLog", () => lastSimulationLog ?? []);

ipcMain.handle(
  "export:simulationExcel",
  async (): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    const log = lastSimulationLog ?? [];
    if (log.length === 0) {
      return { ok: false, error: "Run the simulation first to build the log." };
    }
    const mainWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin ?? undefined, {
      title: "Export simulation to Excel",
      defaultPath: "simulation-export.xlsx",
      filters: [{ name: "Excel", extensions: ["xlsx"] }]
    });
    if (canceled || !filePath) {
      return { ok: false, error: "Export cancelled." };
    }
    try {
      const customers = getAllCustomers();
      const slots = getAllScheduledSlots();
      const config = resolveExportSimulationConfig();
      const wb = buildSimulationWorkbook(log, slots, config, customers);
      const buf = writeSimulationWorkbookToBuffer(wb);
      fs.writeFileSync(filePath, buf);
      return { ok: true, path: filePath };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[export:simulationExcel]", e);
      return { ok: false, error: msg };
    }
  }
);

ipcMain.handle("scheduler:getFeasibilityWarnings", () => lastFeasibilityWarnings);

ipcMain.handle("scheduler:getInventoryTimeline", async () => {
  if (!lastInventoryTimeline || Object.keys(lastInventoryTimeline).length === 0) {
    return null;
  }
  const result: Record<string, number[]> = {};
  for (const [customerId, values] of Object.entries(lastInventoryTimeline)) {
    result[customerId] = values;
  }
  return {
    timeline: result,
    startDate: lastSimulationConfig?.startDate?.toISOString() ?? null,
    totalStorageCapacity: lastSimulationConfig?.totalStorageCapacity ?? null
  };
});

ipcMain.handle("db:getCustomers", async () => {
  const customers = getAllCustomers();
  return customers;
});

ipcMain.handle("db:createCustomer", async (_e, customer: unknown) => {
  const c = customer as Parameters<typeof createCustomer>[0];
  return createCustomer(c);
});

ipcMain.handle("db:updateCustomer", async (_e, customer: unknown) => {
  const c = customer as Parameters<typeof updateCustomer>[0];
  return updateCustomer(c);
});

ipcMain.handle("db:deleteCustomer", async (_e, id: string) => {
  return deleteCustomer(id);
});

ipcMain.handle("db:getResources", async () => {
  const resources = getAllResources();
  return resources.map((r) => ({
    ...r,
    blackouts: r.blackouts.map((b) => ({
      ...b,
      start: b.start.toISOString(),
      end: b.end.toISOString()
    }))
  }));
});

ipcMain.handle("db:createResource", async (_e, resource: unknown) => {
  const r = resource as { id: string; name: string; type: string; flowRate: number; blackouts?: Array<{ id: string; resourceId: string; start: string; end: string }> };
  const res = {
    ...r,
    type: r.type as ResourceType,
    blackouts: (r.blackouts ?? []).map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      start: new Date(b.start),
      end: new Date(b.end)
    }))
  };
  return createResource(res);
});

ipcMain.handle("db:updateResource", async (_e, resource: unknown) => {
  const r = resource as { id: string; name: string; type: string; flowRate: number; blackouts?: Array<{ id: string; resourceId: string; start: string; end: string }> };
  const res = {
    ...r,
    type: r.type as ResourceType,
    blackouts: (r.blackouts ?? []).map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      start: new Date(b.start),
      end: new Date(b.end)
    }))
  };
  return updateResource(res);
});

ipcMain.handle("db:deleteResource", async (_e, id: string) => {
  return deleteResource(id);
});

ipcMain.handle("db:getSimulationConfigs", async () => {
  const configs = getAllSimulationConfigs();
  return configs.map((c) => ({
    ...c,
    startDate: c.startDate.toISOString(),
    endDate: c.endDate.toISOString()
  }));
});

ipcMain.handle("db:createSimulationConfig", async (_e, config: unknown) => {
  const c = config as {
    startDate: string;
    endDate: string;
    pipelineFlowRate: number;
    pipelineDirection: string;
    totalStorageCapacity?: number;
    storageMode?: string;
    minSlotIntervalHours?: number;
    preOpsHours?: number;
    postOpsHours?: number;
    tankCount?: number;
    tankCapacity?: number;
    sharedInventoryCustomerDeficitLimitTonnes?: number;
    pacerRoundingDirection?: "up" | "down";
    pacerRoundAtDecile?: number;
    optimizerRelativeDocMultiplier?: number;
    optimizerRelativeFulfillmentMultiplier?: number;
    bargeBerthAllocation?: string;
  };
  const pacerDecileRaw = Math.round(c.pacerRoundAtDecile ?? 1);
  return createSimulationConfig({
    startDate: new Date(c.startDate),
    endDate: new Date(c.endDate),
    pipelineFlowRate: c.pipelineFlowRate,
    pipelineDirection: c.pipelineDirection as "inbound" | "outbound",
    totalStorageCapacity: c.totalStorageCapacity ?? 100000,
    storageMode: (c.storageMode as SimulationConfig["storageMode"]) ?? "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes:
      typeof c.sharedInventoryCustomerDeficitLimitTonnes === "number" && c.sharedInventoryCustomerDeficitLimitTonnes >= 0
        ? c.sharedInventoryCustomerDeficitLimitTonnes
        : 0,
    pacerRoundingDirection: c.pacerRoundingDirection === "down" ? "down" : "up",
    pacerRoundAtDecile:
      Number.isFinite(pacerDecileRaw) ? Math.min(9, Math.max(1, pacerDecileRaw)) : 1,
    optimizerRelativeDocMultiplier:
      typeof c.optimizerRelativeDocMultiplier === "number" && Number.isFinite(c.optimizerRelativeDocMultiplier)
        ? Math.max(0, c.optimizerRelativeDocMultiplier)
        : 0,
    optimizerRelativeFulfillmentMultiplier:
      typeof c.optimizerRelativeFulfillmentMultiplier === "number" &&
      Number.isFinite(c.optimizerRelativeFulfillmentMultiplier)
        ? Math.max(0, c.optimizerRelativeFulfillmentMultiplier)
        : 0,
    minSlotIntervalHours: c.minSlotIntervalHours ?? 0,
    preOpsHours: c.preOpsHours ?? 0,
    postOpsHours: c.postOpsHours ?? 0,
    tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? Math.floor(c.tankCount) : 4,
    tankCapacity: typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
    bargeBerthAllocation:
      c.bargeBerthAllocation === "small_only" || c.bargeBerthAllocation === "prefer_small"
        ? c.bargeBerthAllocation
        : "alternate"
  });
});

ipcMain.handle("db:updateSimulationConfig", async (_e, id: string, config: unknown) => {
  const c = config as {
    startDate: string;
    endDate: string;
    pipelineFlowRate: number;
    pipelineDirection: string;
    totalStorageCapacity?: number;
    storageMode?: string;
    minSlotIntervalHours?: number;
    preOpsHours?: number;
    postOpsHours?: number;
    tankCount?: number;
    tankCapacity?: number;
    sharedInventoryCustomerDeficitLimitTonnes?: number;
    pacerRoundingDirection?: "up" | "down";
    pacerRoundAtDecile?: number;
    optimizerRelativeDocMultiplier?: number;
    optimizerRelativeFulfillmentMultiplier?: number;
    bargeBerthAllocation?: string;
  };
  const pacerDecileRaw = Math.round(c.pacerRoundAtDecile ?? 1);
  return updateSimulationConfig(id, {
    startDate: new Date(c.startDate),
    endDate: new Date(c.endDate),
    pipelineFlowRate: c.pipelineFlowRate,
    pipelineDirection: c.pipelineDirection as "inbound" | "outbound",
    totalStorageCapacity: c.totalStorageCapacity ?? 100000,
    storageMode: (c.storageMode as SimulationConfig["storageMode"]) ?? "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes:
      typeof c.sharedInventoryCustomerDeficitLimitTonnes === "number" && c.sharedInventoryCustomerDeficitLimitTonnes >= 0
        ? c.sharedInventoryCustomerDeficitLimitTonnes
        : 0,
    pacerRoundingDirection: c.pacerRoundingDirection === "down" ? "down" : "up",
    pacerRoundAtDecile:
      Number.isFinite(pacerDecileRaw) ? Math.min(9, Math.max(1, pacerDecileRaw)) : 1,
    optimizerRelativeDocMultiplier:
      typeof c.optimizerRelativeDocMultiplier === "number" && Number.isFinite(c.optimizerRelativeDocMultiplier)
        ? Math.max(0, c.optimizerRelativeDocMultiplier)
        : 0,
    optimizerRelativeFulfillmentMultiplier:
      typeof c.optimizerRelativeFulfillmentMultiplier === "number" &&
      Number.isFinite(c.optimizerRelativeFulfillmentMultiplier)
        ? Math.max(0, c.optimizerRelativeFulfillmentMultiplier)
        : 0,
    minSlotIntervalHours: c.minSlotIntervalHours ?? 0,
    preOpsHours: c.preOpsHours ?? 0,
    postOpsHours: c.postOpsHours ?? 0,
    tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? Math.floor(c.tankCount) : 4,
    tankCapacity: typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
    bargeBerthAllocation:
      c.bargeBerthAllocation === "small_only" || c.bargeBerthAllocation === "prefer_small"
        ? c.bargeBerthAllocation
        : "alternate"
  });
});

ipcMain.handle("scenario:list", async () => listScenarios());

ipcMain.handle("scenario:save", async (_e, name: string) => {
  saveScenario(String(name ?? ""));
});

ipcMain.handle("scenario:overwrite", async (_e, id: string) => {
  overwriteScenario(String(id));
});

ipcMain.handle("scenario:load", async (_e, id: string) => {
  loadScenario(String(id));
  lastInventoryTimeline = {};
  lastSimulationConfig = null;
  lastSimulationLog = [];
  lastFeasibilityWarnings = [];
});

ipcMain.handle("scenario:delete", async (_e, id: string) => {
  deleteScenario(String(id));
});

ipcMain.handle("scenario:rename", async (_e, id: string, name: string) => {
  renameScenario(String(id), String(name ?? ""));
});

app.whenReady().then(() => {
  // Fresh session: no stale scheduler run from a previous app launch (DB + in-memory).
  deleteAllScheduledSlots();
  lastInventoryTimeline = {};
  lastSimulationConfig = null;
  lastSimulationLog = [];
  lastFeasibilityWarnings = [];
  createWindow();
});

app.on("window-all-closed", () => {
  const { closeDatabase } = require("../db/database");
  closeDatabase();
  app.quit();
});
