import { app, BrowserWindow, ipcMain, dialog } from "electron";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

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
  deleteScheduledSlot,
  updateScheduledSlot,
  getAllSimulationConfigs,
  simulationConfigFromRow,
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
  renameScenario,
  getAllTransportPools,
  createTransportPool,
  updateTransportPool,
  deleteTransportPool,
  deleteAllTransportPools
} from "../db";
import { buildSimulationWorkbook, writeSimulationWorkbookToBuffer } from "../engine/simulationExcelExport";
import type { ScheduleResult } from "../engine/scheduler";
import type { SimulationConfig, ScheduledSlot, ResourceType, Customer, Resource, TransportPool, SustainabilityGrade } from "../types";
import type { SimulationLogRow } from "../engine/simulationLog";
import { poolIdForCustomerSlot } from "../engine/transportPools";
import {
  createRunStateManager,
  cloneSlots,
  computeSlotTweaks,
  buildStochasticRunSnapshot,
  type SimulationRunSnapshot
} from "../lib/simulationRunState";

/** Reload engine modules so `npm run build` takes effect without restarting Electron. */
function reloadEngine(): {
  runScheduler: (
    customers: Customer[],
    resources: Resource[],
    config: SimulationConfig,
    transportPools?: TransportPool[],
    options?: { fixedSlots?: ScheduledSlot[] }
  ) => ScheduleResult;
  replaySimulation: (
    customers: Customer[],
    resources: Resource[],
    config: SimulationConfig,
    assignedSlots: ScheduledSlot[],
    transportPools?: TransportPool[],
    options?: import("../engine/replaySimulation").ReplaySimulationOptions
  ) => ScheduleResult;
  validateScheduledSlots: (
    slots: ScheduledSlot[],
    resources: Resource[],
    config: SimulationConfig
  ) => Array<{ slotId: string; message: string; severity: "amber" | "red" }>;
  finalizeManualSlot: (
    draft: ScheduledSlot,
    customer: Customer,
    allResources: Resource[],
    config: SimulationConfig,
    otherSlots: ScheduledSlot[]
  ) => { ok: true; slot: ScheduledSlot } | { ok: false; error: string };
} {
  const engineRoot = path.join(__dirname, "..", "engine");
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(engineRoot)) {
      delete require.cache[cached];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const engine = require("../engine");
  return {
    runScheduler: engine.runScheduler,
    replaySimulation: engine.replaySimulation,
    validateScheduledSlots: engine.validateScheduledSlots,
    finalizeManualSlot: engine.finalizeManualSlot
  };
}

let lastInventoryTimeline: Record<string, number[]> = {};
let lastGradeLedgerTimeline: Record<string, Record<"green" | "blue" | "grey", number[]>> | null = null;
let lastSimulationConfig: SimulationConfig | null = null;
let lastSimulationLog: SimulationLogRow[] = [];
let lastFeasibilityWarnings: Array<{ key: string; severity: "amber" | "red"; message: string }> = [];
const runState = createRunStateManager();

function applyRunResult(result: ScheduleResult, config: SimulationConfig): void {
  lastInventoryTimeline = Object.fromEntries(result.inventoryTimeline);
  lastGradeLedgerTimeline = result.gradeLedgerTimeline;
  lastSimulationConfig = config;
  lastSimulationLog = result.simulationLog;
  lastFeasibilityWarnings = result.feasibilityWarnings.map((w) => ({
    key: w.key,
    severity: w.severity,
    message: w.message,
    meta: w.meta
  }));
}

function buildSnapshot(slots: ScheduledSlot[]): SimulationRunSnapshot {
  return {
    slots: cloneSlots(slots),
    simulationLog: [...lastSimulationLog],
    inventoryTimeline: Object.fromEntries(
      Object.entries(lastInventoryTimeline).map(([id, arr]) => [id, [...arr]])
    ),
    gradeLedgerTimeline: lastGradeLedgerTimeline
      ? Object.fromEntries(
          Object.entries(lastGradeLedgerTimeline).map(([id, grades]) => [
            id,
            { green: [...grades.green], blue: [...grades.blue], grey: [...grades.grey] }
          ])
        )
      : null,
    feasibilityWarnings: lastFeasibilityWarnings.map((w) => ({ ...w }))
  };
}

function persistSlots(slots: ScheduledSlot[]): void {
  deleteAllScheduledSlots();
  for (const slot of slots) {
    createScheduledSlot(slot);
  }
}

function mergeSlotValidationWarnings(
  result: ScheduleResult,
  slots: ScheduledSlot[],
  resources: Resource[],
  config: SimulationConfig
): ScheduleResult {
  const { validateScheduledSlots } = reloadEngine();
  const issues = validateScheduledSlots(slots, resources, config);
  if (issues.length === 0) return result;
  return {
    ...result,
    feasibilityWarnings: [
      ...result.feasibilityWarnings,
      ...issues.map((i) => ({
        key: `slot_validation_${i.slotId}`,
        severity: i.severity,
        message: `Slot ${i.slotId.slice(0, 8)}…: ${i.message}`
      }))
    ]
  };
}

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

function deserializeSlotPayload(raw: {
  id?: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
  end: string;
  legKey?: string | null;
}): ScheduledSlot {
  return {
    id: raw.id ?? randomUUID(),
    customerId: raw.customerId,
    resourceId: raw.resourceId,
    direction: raw.direction as ScheduledSlot["direction"],
    mode: raw.mode as ScheduledSlot["mode"],
    legKey: raw.legKey ?? null,
    volume: Math.max(0, Number(raw.volume)),
    start: new Date(raw.start),
    end: new Date(raw.end),
    reservationStart: null,
    reservationEnd: null,
    status: "manual_override",
    conflictReason: null
  };
}

function serializeSlot(slot: ScheduledSlot) {
  return {
    ...slot,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    reservationStart: slot.reservationStart?.toISOString() ?? null,
    reservationEnd: slot.reservationEnd?.toISOString() ?? null
  };
}

function resolveExportSimulationConfig(): SimulationConfig {
  const configs = getAllSimulationConfigs();
  if (configs[0]) {
    return simulationConfigFromRow(configs[0]);
  }
  if (lastSimulationConfig) return lastSimulationConfig;
  return {
    startDate: new Date(),
    endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100000,
    storageMode: "fixed_band",
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    borrowingGradeScope: "all",
    pacerInboundRoundAtDecile: 1,
    pacerInboundAllowance: 0.5,
    pacerOutboundRoundAtDecile: 1,
    pacerOutboundAllowance: 0.5,
    optimizerRelativeDocMultiplier: 0,
    optimizerRelativeFulfillmentMultiplier: 0,
    gradeMassBalancingEnabled: false,
    gradeMassBalanceDeficitMode: "tonnes",
    gradeMassBalanceDeficitLimitTonnes: 0,
    gradeMassBalanceDeficitLimitPct: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000,
    berthReservationMode: "none"
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
    lastFeasibilityWarnings = [
      { key: "missing_customers_or_resources", severity: "red", message: "Add customers and resources before running the scheduler" }
    ];
    return {
      scheduledSlots: [],
      feasibilityWarnings: lastFeasibilityWarnings,
      inventoryTimeline: {}
    };
  }

  const config: SimulationConfig = configs[0]
    ? simulationConfigFromRow(configs[0])
    : {
        startDate: new Date(),
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        pipelineFlowRate: 0,
        pipelineDirection: "inbound" as const,
        totalStorageCapacity: 100000,
        storageMode: "fixed_band" as const,
        sharedInventoryCustomerDeficitLimitTonnes: 0,
        borrowingGradeScope: "all" as const,
        pacerInboundRoundAtDecile: 1,
        pacerInboundAllowance: 0.5,
        pacerOutboundRoundAtDecile: 1,
        pacerOutboundAllowance: 0.5,
        optimizerRelativeDocMultiplier: 0,
        optimizerRelativeFulfillmentMultiplier: 0,
        gradeMassBalancingEnabled: false,
        gradeMassBalanceDeficitMode: "tonnes" as const,
        gradeMassBalanceDeficitLimitTonnes: 0,
        gradeMassBalanceDeficitLimitPct: 0,
        minSlotIntervalHours: 0,
        preOpsHours: 0,
        postOpsHours: 0,
        tankCount: 4,
        tankCapacity: 7000,
        berthReservationMode: "none" as const
      };

  const transportPools = getAllTransportPools();
  const { runScheduler } = reloadEngine();
  const result = runScheduler(customers, resources, config, transportPools);

  console.log("[scheduler:run] storageMode:", config.storageMode);
  console.log("[scheduler:run] transportPools:", transportPools.length);
  for (const c of customers) {
    const rows = c.outboundTransports ?? [];
    const poolIds = rows.map((r) => r.poolId ?? null).filter(Boolean);
    console.log(
      "[scheduler:run] customer",
      c.name,
      "outbound poolIds:",
      poolIds.length > 0 ? poolIds.join(", ") : "(none)"
    );
  }
  const poolSlots = result.scheduledSlots.filter((s) => {
    const c = customers.find((x) => x.id === s.customerId);
    return c != null && poolIdForCustomerSlot(c, s, transportPools) != null;
  }).length;
  console.log("[scheduler:run] Pool-attributed slots:", poolSlots, "of", result.scheduledSlots.length);

  console.log("[scheduler:run] Scheduled slots:", result.scheduledSlots.length);

  if (result.feasibilityWarnings.length > 0) {
    console.log("[feasibility] Warnings count:", result.feasibilityWarnings.length);
    result.feasibilityWarnings.forEach((w) => console.log("[feasibility]", w.message));
  } else {
    console.log("[feasibility] No warnings");
  }

  persistSlots(result.scheduledSlots);
  applyRunResult(result, config);
  runState.captureBaseline(buildSnapshot(result.scheduledSlots));

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

function serializeStochasticRun(run: ReturnType<typeof runState.getStochasticRun>) {
  if (!run) return null;
  return {
    stochasticSeed: run.stochasticSeed,
    slots: run.slots.map(serializeSlot),
    ghostSlots: run.ghostSlots.map(serializeSlot),
    simulationLog: run.simulationLog,
    inventoryTimeline: run.inventoryTimeline,
    feasibilityWarnings: run.feasibilityWarnings,
    slotAdjustments: run.slotAdjustments,
    immobilisationWindows: run.immobilisationWindows,
    stochasticEvents: run.stochasticEvents ?? []
  };
}

ipcMain.handle("scheduler:getStochasticState", async () => {
  const run = runState.getStochasticRun();
  return {
    active: run != null,
    run: serializeStochasticRun(run)
  };
});

ipcMain.handle("scheduler:sampleStochastic", async (_e, seed?: number) => {
  const customers = getAllCustomers();
  const resources = getAllResources();
  const slots = getAllScheduledSlots();

  if (customers.length === 0 || resources.length === 0 || slots.length === 0) {
    return { ok: false as const, error: "Run the scheduler first and keep at least one slot." };
  }

  const config = resolveExportSimulationConfig();
  if (!config.stochasticConfig?.enabled) {
    return {
      ok: false as const,
      error: "Enable stochastics under Configuration → Stochastics, then save."
    };
  }

  const transportPools = getAllTransportPools();
  const { replaySimulation } = reloadEngine();
  let result = replaySimulation(customers, resources, config, slots, transportPools, {
    stochasticConfig: config.stochasticConfig,
    seed: typeof seed === "number" && Number.isFinite(seed) ? seed : undefined
  });
  result = mergeSlotValidationWarnings(result, slots, resources, config);
  runState.setStochasticRun(buildStochasticRunSnapshot(slots, result));

  return {
    ok: true as const,
    run: serializeStochasticRun(runState.getStochasticRun())
  };
});

ipcMain.handle("scheduler:clearStochastic", async () => {
  runState.clearStochasticRun();
  return { ok: true as const };
});

ipcMain.handle("scheduler:getTweakState", async () => {
  const slots = getAllScheduledSlots();
  const baseline = runState.getBaseline();
  return {
    hasBaseline: runState.hasBaseline(),
    canUndo: runState.canUndo(),
    needsReplay: runState.needsReplay(slots),
    isTweaked: runState.isTweaked(slots),
    slotTweaks: computeSlotTweaks(slots, baseline?.slots ?? null),
    baselineSlots: baseline ? baseline.slots.map(serializeSlot) : []
  };
});

ipcMain.handle("scheduler:updateSimulation", async () => {
  const customers = getAllCustomers();
  const resources = getAllResources();
  const configs = getAllSimulationConfigs();
  const slots = getAllScheduledSlots();

  if (customers.length === 0 || resources.length === 0 || slots.length === 0) {
    return { ok: false as const, error: "Run the scheduler first and keep at least one slot." };
  }

  const config = resolveExportSimulationConfig();
  const transportPools = getAllTransportPools();
  const { replaySimulation } = reloadEngine();
  let result = replaySimulation(customers, resources, config, slots, transportPools);
  result = mergeSlotValidationWarnings(result, slots, resources, config);
  applyRunResult(result, config);
  runState.setLastReplayed(slots);

  return {
    ok: true as const,
    scheduledSlots: slots.map(serializeSlot),
    feasibilityWarnings: lastFeasibilityWarnings,
    inventoryTimeline: lastInventoryTimeline
  };
});

ipcMain.handle("scheduler:restoreBaseline", async () => {
  const baseline = runState.getBaseline();
  if (!baseline) {
    return { ok: false as const, error: "No baseline — run the scheduler first." };
  }

  runState.pushUndo(getAllScheduledSlots());
  persistSlots(baseline.slots);
  lastInventoryTimeline = Object.fromEntries(
    Object.entries(baseline.inventoryTimeline).map(([id, arr]) => [id, [...arr]])
  );
  lastGradeLedgerTimeline = baseline.gradeLedgerTimeline
    ? Object.fromEntries(
        Object.entries(baseline.gradeLedgerTimeline).map(([id, grades]) => [
          id,
          { green: [...grades.green], blue: [...grades.blue], grey: [...grades.grey] }
        ])
      )
    : null;
  lastSimulationLog = baseline.simulationLog.map((r) => ({
    ...r,
    customerInventories: { ...r.customerInventories },
    pipelineFlow: { ...r.pipelineFlow },
    transportStatus: [...r.transportStatus]
  }));
  lastFeasibilityWarnings = baseline.feasibilityWarnings.map((w) => ({ ...w }));
  runState.setLastReplayed(baseline.slots);
  runState.clearStochasticRun();

  return {
    ok: true as const,
    scheduledSlots: baseline.slots.map(serializeSlot),
    feasibilityWarnings: lastFeasibilityWarnings,
    inventoryTimeline: lastInventoryTimeline
  };
});

ipcMain.handle("scheduler:undo", async () => {
  const prev = runState.popUndo();
  if (!prev) {
    return { ok: false as const, error: "Nothing to undo." };
  }

  persistSlots(prev);
  const customers = getAllCustomers();
  const resources = getAllResources();
  const config = resolveExportSimulationConfig();
  const transportPools = getAllTransportPools();
  const { replaySimulation } = reloadEngine();
  let result = replaySimulation(customers, resources, config, prev, transportPools);
  result = mergeSlotValidationWarnings(result, prev, resources, config);
  applyRunResult(result, config);
  runState.setLastReplayed(prev);

  return {
    ok: true as const,
    scheduledSlots: prev.map(serializeSlot),
    feasibilityWarnings: lastFeasibilityWarnings,
    inventoryTimeline: lastInventoryTimeline
  };
});

ipcMain.handle("scheduler:deleteSlot", async (_e, slotId: string) => {
  const id = String(slotId ?? "");
  if (!id) return { ok: false as const, error: "Slot id required." };

  const existing = getAllScheduledSlots();
  if (!existing.some((s) => s.id === id)) {
    return { ok: false as const, error: "Slot not found." };
  }

  runState.pushUndo(existing);
  deleteScheduledSlot(id);
  runState.markDirty();

  return { ok: true as const, slotId: id };
});

ipcMain.handle("scheduler:upsertSlot", async (_e, payload: unknown) => {
  const p = payload as {
    slot: {
      id?: string;
      customerId: string;
      resourceId: string;
      direction: string;
      mode: string;
      volume: number;
      start: string;
      end: string;
      legKey?: string | null;
    };
    isNew?: boolean;
  };
  if (!p?.slot) return { ok: false as const, error: "Slot payload required." };

  const customers = getAllCustomers();
  const resources = getAllResources();
  const config = resolveExportSimulationConfig();
  const customer = customers.find((c) => c.id === p.slot.customerId);
  if (!customer) return { ok: false as const, error: "Customer not found." };

  const existing = getAllScheduledSlots();
  runState.pushUndo(existing);

  const draft = deserializeSlotPayload(p.slot);
  const others = existing.filter((s) => s.id !== draft.id);
  const { finalizeManualSlot } = reloadEngine();
  const built = finalizeManualSlot(draft, customer, resources, config, others);
  if (!built.ok) return { ok: false as const, error: built.error };

  if (p.isNew || !existing.some((s) => s.id === built.slot.id)) {
    createScheduledSlot(built.slot);
  } else {
    updateScheduledSlot(built.slot);
  }
  runState.markDirty();

  return { ok: true as const, slot: serializeSlot(built.slot) };
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
    gradeTimeline: lastGradeLedgerTimeline,
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

ipcMain.handle("db:getTransportPools", async () => getAllTransportPools());

ipcMain.handle("db:createTransportPool", async (_e, pool: unknown) => {
  return createTransportPool(pool as TransportPool);
});

ipcMain.handle("db:updateTransportPool", async (_e, pool: unknown) => {
  return updateTransportPool(pool as TransportPool);
});

ipcMain.handle("db:deleteTransportPool", async (_e, id: string) => {
  deleteTransportPool(id);
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
    borrowingGradeScope?: string;
    selectedBorrowingGrades?: SustainabilityGrade[];
    perGradeDeficitLimitTonnes?: Partial<Record<"green" | "blue" | "grey", number>>;
    pacerInboundRoundAtDecile?: number;
    pacerInboundAllowance?: number;
    pacerOutboundRoundAtDecile?: number;
    pacerOutboundAllowance?: number;
    pacerRoundAtDecile?: number;
    optimizerRelativeDocMultiplier?: number;
    optimizerRelativeFulfillmentMultiplier?: number;
    gradeMassBalancingEnabled?: boolean;
    gradeMassBalanceDeficitMode?: string;
    gradeMassBalanceDeficitLimitTonnes?: number;
    gradeMassBalanceDeficitLimitPct?: number;
    bargeBerthAllocation?: string;
    berthReservationMode?: string;
    feasibilityWarnings?: SimulationConfig["feasibilityWarnings"];
    stochasticConfig?: SimulationConfig["stochasticConfig"];
  };
  const legacyDecile = Math.min(9, Math.max(1, Math.round(c.pacerRoundAtDecile ?? 1)));
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
    borrowingGradeScope:
      c.borrowingGradeScope === "same_grade" || c.borrowingGradeScope === "selected_grades"
        ? c.borrowingGradeScope
        : "all",
    selectedBorrowingGrades: c.selectedBorrowingGrades,
    perGradeDeficitLimitTonnes: c.perGradeDeficitLimitTonnes,
    pacerInboundRoundAtDecile: Math.min(
      9,
      Math.max(1, Math.round(c.pacerInboundRoundAtDecile ?? legacyDecile))
    ),
    pacerInboundAllowance:
      typeof c.pacerInboundAllowance === "number" && Number.isFinite(c.pacerInboundAllowance)
        ? c.pacerInboundAllowance
        : 0.5,
    pacerOutboundRoundAtDecile: Math.min(
      9,
      Math.max(1, Math.round(c.pacerOutboundRoundAtDecile ?? legacyDecile))
    ),
    pacerOutboundAllowance:
      typeof c.pacerOutboundAllowance === "number" && Number.isFinite(c.pacerOutboundAllowance)
        ? c.pacerOutboundAllowance
        : 0.5,
    optimizerRelativeDocMultiplier:
      typeof c.optimizerRelativeDocMultiplier === "number" && Number.isFinite(c.optimizerRelativeDocMultiplier)
        ? Math.max(0, c.optimizerRelativeDocMultiplier)
        : 0,
    optimizerRelativeFulfillmentMultiplier:
      typeof c.optimizerRelativeFulfillmentMultiplier === "number" &&
      Number.isFinite(c.optimizerRelativeFulfillmentMultiplier)
        ? Math.max(0, c.optimizerRelativeFulfillmentMultiplier)
        : 0,
    gradeMassBalancingEnabled: !!c.gradeMassBalancingEnabled,
    gradeMassBalanceDeficitMode: c.gradeMassBalanceDeficitMode === "percent" ? "percent" : "tonnes",
    gradeMassBalanceDeficitLimitTonnes:
      typeof c.gradeMassBalanceDeficitLimitTonnes === "number" &&
      Number.isFinite(c.gradeMassBalanceDeficitLimitTonnes)
        ? Math.max(0, c.gradeMassBalanceDeficitLimitTonnes)
        : 0,
    gradeMassBalanceDeficitLimitPct:
      typeof c.gradeMassBalanceDeficitLimitPct === "number" &&
      Number.isFinite(c.gradeMassBalanceDeficitLimitPct)
        ? Math.max(0, c.gradeMassBalanceDeficitLimitPct)
        : 0,
    minSlotIntervalHours: c.minSlotIntervalHours ?? 0,
    preOpsHours: c.preOpsHours ?? 0,
    postOpsHours: c.postOpsHours ?? 0,
    tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? Math.floor(c.tankCount) : 4,
    tankCapacity: typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
    bargeBerthAllocation:
      c.bargeBerthAllocation === "small_only" || c.bargeBerthAllocation === "prefer_small"
        ? c.bargeBerthAllocation
        : "alternate",
    berthReservationMode:
      c.berthReservationMode === "window_of_arrival" || c.berthReservationMode === "laycan"
        ? c.berthReservationMode
        : "none",
    feasibilityWarnings: c.feasibilityWarnings,
    stochasticConfig: c.stochasticConfig
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
    borrowingGradeScope?: string;
    selectedBorrowingGrades?: SustainabilityGrade[];
    perGradeDeficitLimitTonnes?: Partial<Record<"green" | "blue" | "grey", number>>;
    pacerInboundRoundAtDecile?: number;
    pacerInboundAllowance?: number;
    pacerOutboundRoundAtDecile?: number;
    pacerOutboundAllowance?: number;
    pacerRoundAtDecile?: number;
    optimizerRelativeDocMultiplier?: number;
    optimizerRelativeFulfillmentMultiplier?: number;
    gradeMassBalancingEnabled?: boolean;
    gradeMassBalanceDeficitMode?: string;
    gradeMassBalanceDeficitLimitTonnes?: number;
    gradeMassBalanceDeficitLimitPct?: number;
    bargeBerthAllocation?: string;
    berthReservationMode?: string;
    feasibilityWarnings?: SimulationConfig["feasibilityWarnings"];
    stochasticConfig?: SimulationConfig["stochasticConfig"];
  };
  const legacyDecile = Math.min(9, Math.max(1, Math.round(c.pacerRoundAtDecile ?? 1)));
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
    borrowingGradeScope:
      c.borrowingGradeScope === "same_grade" || c.borrowingGradeScope === "selected_grades"
        ? c.borrowingGradeScope
        : "all",
    selectedBorrowingGrades: c.selectedBorrowingGrades,
    perGradeDeficitLimitTonnes: c.perGradeDeficitLimitTonnes,
    pacerInboundRoundAtDecile: Math.min(
      9,
      Math.max(1, Math.round(c.pacerInboundRoundAtDecile ?? legacyDecile))
    ),
    pacerInboundAllowance:
      typeof c.pacerInboundAllowance === "number" && Number.isFinite(c.pacerInboundAllowance)
        ? c.pacerInboundAllowance
        : 0.5,
    pacerOutboundRoundAtDecile: Math.min(
      9,
      Math.max(1, Math.round(c.pacerOutboundRoundAtDecile ?? legacyDecile))
    ),
    pacerOutboundAllowance:
      typeof c.pacerOutboundAllowance === "number" && Number.isFinite(c.pacerOutboundAllowance)
        ? c.pacerOutboundAllowance
        : 0.5,
    optimizerRelativeDocMultiplier:
      typeof c.optimizerRelativeDocMultiplier === "number" && Number.isFinite(c.optimizerRelativeDocMultiplier)
        ? Math.max(0, c.optimizerRelativeDocMultiplier)
        : 0,
    optimizerRelativeFulfillmentMultiplier:
      typeof c.optimizerRelativeFulfillmentMultiplier === "number" &&
      Number.isFinite(c.optimizerRelativeFulfillmentMultiplier)
        ? Math.max(0, c.optimizerRelativeFulfillmentMultiplier)
        : 0,
    gradeMassBalancingEnabled: !!c.gradeMassBalancingEnabled,
    gradeMassBalanceDeficitMode: c.gradeMassBalanceDeficitMode === "percent" ? "percent" : "tonnes",
    gradeMassBalanceDeficitLimitTonnes:
      typeof c.gradeMassBalanceDeficitLimitTonnes === "number" &&
      Number.isFinite(c.gradeMassBalanceDeficitLimitTonnes)
        ? Math.max(0, c.gradeMassBalanceDeficitLimitTonnes)
        : 0,
    gradeMassBalanceDeficitLimitPct:
      typeof c.gradeMassBalanceDeficitLimitPct === "number" &&
      Number.isFinite(c.gradeMassBalanceDeficitLimitPct)
        ? Math.max(0, c.gradeMassBalanceDeficitLimitPct)
        : 0,
    minSlotIntervalHours: c.minSlotIntervalHours ?? 0,
    preOpsHours: c.preOpsHours ?? 0,
    postOpsHours: c.postOpsHours ?? 0,
    tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? Math.floor(c.tankCount) : 4,
    tankCapacity: typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
    bargeBerthAllocation:
      c.bargeBerthAllocation === "small_only" || c.bargeBerthAllocation === "prefer_small"
        ? c.bargeBerthAllocation
        : "alternate",
    berthReservationMode:
      c.berthReservationMode === "window_of_arrival" || c.berthReservationMode === "laycan"
        ? c.berthReservationMode
        : "none",
    feasibilityWarnings: c.feasibilityWarnings,
    stochasticConfig: c.stochasticConfig
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
  lastGradeLedgerTimeline = null;
  lastSimulationConfig = null;
  lastSimulationLog = [];
  lastFeasibilityWarnings = [];
  runState.reset();
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
  lastGradeLedgerTimeline = null;
  lastSimulationConfig = null;
  lastSimulationLog = [];
  lastFeasibilityWarnings = [];
  runState.reset();
  createWindow();
});

app.on("window-all-closed", () => {
  const { closeDatabase } = require("../db/database");
  closeDatabase();
  app.quit();
});
