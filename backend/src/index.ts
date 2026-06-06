import express from "express";
import { proposeSchedule, TerminalStateForScheduling } from "./scheduler";
import { TransportRequest } from "./domain";
import { CustomerConfig, TerminalSimulationConfig, runSimulation, StorageEntitlement } from "./simulation";

type TerminalProductConfig = {
  id: string;
  name: string;
  storageCapacity: number;
  unit: "m3" | "tons";
};
type TerminalConfig = {
  periodStart: Date;
  periodEnd: Date;
  numberOfCustomers: number;
  borrowingEnabled: boolean;
  customers: CustomerConfig[];
  products: TerminalProductConfig[];
  fullParcelPercent?: number;
  minHoursBetweenSlots?: number;
  minHoursBetweenSlotsScope?: "all" | "per_mode";
  minSpacingHoursPerCustomer?: number;
  slotAllocationRuleInbound?: "lowest_inventory" | "round_robin";
  slotAllocationRuleOutbound?: "highest_inventory" | "round_robin";
  slotAllocationRuleConflict?: "round_robin" | "inbound_first" | "outbound_first";
  slotAllocationRule?: "highest_inventory" | "round_robin";
  customerStorageEntitlement?: Record<string, StorageEntitlement>;
  terminalStorageEntitlement?: StorageEntitlement;
};

const app = express();
app.use(express.json());

// Simple in-memory state for demo purposes
const terminalState: TerminalStateForScheduling = {
  resources: [],
  existingEvents: []
};

let terminalConfig: TerminalConfig | null = null;

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/terminal/config", (_req, res) => {
  if (!terminalConfig) return res.json({ configured: false });
  return res.json({
    configured: true,
    periodStart: terminalConfig.periodStart.toISOString(),
    periodEnd: terminalConfig.periodEnd.toISOString(),
    numberOfCustomers: terminalConfig.numberOfCustomers,
    borrowingEnabled: terminalConfig.borrowingEnabled,
    customers: terminalConfig.customers,
    products: terminalConfig.products,
    fullParcelPercent: terminalConfig.fullParcelPercent ?? 100,
    minHoursBetweenSlots: terminalConfig.minHoursBetweenSlots ?? 0,
    minHoursBetweenSlotsScope: terminalConfig.minHoursBetweenSlotsScope ?? "all",
    minSpacingHoursPerCustomer: terminalConfig.minSpacingHoursPerCustomer ?? 0,
    slotAllocationRuleInbound: terminalConfig.slotAllocationRuleInbound ?? "lowest_inventory",
    slotAllocationRuleOutbound: terminalConfig.slotAllocationRuleOutbound ?? terminalConfig.slotAllocationRule ?? "highest_inventory",
    slotAllocationRuleConflict: terminalConfig.slotAllocationRuleConflict ?? "inbound_first",
    slotAllocationRule: terminalConfig.slotAllocationRule ?? "highest_inventory",
    customerStorageEntitlement: terminalConfig.customerStorageEntitlement,
    terminalStorageEntitlement: terminalConfig.terminalStorageEntitlement
  });
});

app.post("/api/terminal/config", (req, res) => {
  try {
  const body = req.body as {
    periodStart?: string;
    periodEnd?: string;
    numberOfCustomers?: number;
    borrowingEnabled?: boolean;
    customers?: Array<any>;
    products?: Array<{ id?: string; name?: string; storageCapacity?: number; unit?: string }>;
    fullParcelPercent?: number;
    minHoursBetweenSlots?: number;
    minHoursBetweenSlotsScope?: "all" | "per_mode";
    minSpacingHoursPerCustomer?: number;
    slotAllocationRuleInbound?: "lowest_inventory" | "round_robin";
    slotAllocationRuleOutbound?: "highest_inventory" | "round_robin";
    slotAllocationRuleConflict?: "round_robin" | "inbound_first" | "outbound_first";
    slotAllocationRule?: "highest_inventory" | "round_robin";
    customerStorageEntitlement?: Record<string, StorageEntitlement>;
    terminalStorageEntitlement?: StorageEntitlement;
  };

  if (!body.periodStart || !body.periodEnd || !Array.isArray(body.products)) {
    return res.status(400).json({ error: "Expected periodStart, periodEnd, and products[]" });
  }

  const numberOfCustomers = Math.max(1, Math.min(50, Math.floor(Number(body.numberOfCustomers) || 1)));
  const borrowingEnabled = Boolean(body.borrowingEnabled);

  const periodStart = new Date(body.periodStart);
  const periodEnd = new Date(body.periodEnd);
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return res.status(400).json({ error: "Invalid periodStart/periodEnd date" });
  }
  if (periodEnd.getTime() <= periodStart.getTime()) {
    return res.status(400).json({ error: "periodEnd must be after periodStart" });
  }

  const defaultUnitForProduct = (id: string): "m3" | "tons" =>
    id.toUpperCase() === "LNG" ? "m3" : "tons";

  const products: TerminalProductConfig[] = body.products.map((p, idx) => {
    const rawId = (p.id && String(p.id).trim()) || `prod-${idx + 1}`;
    const rawName = (p.name && String(p.name).trim()) || `Product ${idx + 1}`;
    const storageCapacity = Number(p.storageCapacity) || 0;
    const unit = (p.unit === "tons" ? "tons" : p.unit === "m3" ? "m3" : defaultUnitForProduct(rawId)) as "m3" | "tons";
    return {
      id: rawId,
      name: rawName,
      storageCapacity,
      unit
    };
  });

  if (products.length === 0) {
    return res.status(400).json({ error: "At least one product is required" });
  }
  for (const p of products) {
    if (!p.id) return res.status(400).json({ error: "Product id cannot be empty" });
    if (p.storageCapacity <= 0) {
      return res.status(400).json({ error: `Storage capacity must be > 0 for ${p.id}` });
    }
  }

  const defaultCustomers: CustomerConfig[] = Array.from({ length: numberOfCustomers }, (_, i) => {
    const id = `cust-${i + 1}`;
    const hasOutbound = i < Math.min(2, numberOfCustomers);
    const hasInbound = i === 0;
    const hasOutboundPipeline = hasOutbound && numberOfCustomers >= 2;
    return {
      id,
      name: `Customer ${i + 1}`,
      initialInventory: hasOutbound ? 20000 : 0,
      inbound: {
        desiredThroughputPerHour: hasInbound ? 100 : 0,
        pipelineRatePerHour: 0,
        transportMode: hasInbound ? "ship" : "none",
        transportUnitSize: hasInbound ? 10000 : 0,
        loadRatePerHour: 500
      },
      outbound: {
        desiredThroughputPerHour: 0,
        pipelineRatePerHour: hasOutboundPipeline ? 50 : 0,
        transportMode: hasOutbound ? "ship" : "none",
        transportUnitSize: hasOutbound ? 18000 : 0,
        loadRatePerHour: 500
      }
    };
  });

  let customers: CustomerConfig[] = Array.isArray(body.customers) ? body.customers : defaultCustomers;
  customers = customers.map((c) => ({
    ...c,
    inbound: {
      ...c.inbound,
      loadRatePerHour: Number(c.inbound?.loadRatePerHour) || 500
    },
    outbound: {
      ...c.outbound,
      loadRatePerHour: Number(c.outbound?.loadRatePerHour) || 500
    }
  }));
  if (customers.length !== numberOfCustomers) {
    return res.status(400).json({ error: "customers[] length must match numberOfCustomers" });
  }

  const fullParcelPercent = Math.max(1, Math.min(100, Number(body.fullParcelPercent) || 100));
  const minHoursBetweenSlots = Math.max(0, Number(body.minHoursBetweenSlots) || 0);
  const minHoursBetweenSlotsScope = body.minHoursBetweenSlotsScope === "per_mode" ? "per_mode" : "all";
  const minSpacingHoursPerCustomer = Math.max(0, Number(body.minSpacingHoursPerCustomer) || 0);
  const slotAllocationRule =
    body.slotAllocationRule === "round_robin" ? "round_robin" : "highest_inventory";
  terminalConfig = {
    periodStart,
    periodEnd,
    numberOfCustomers,
    borrowingEnabled,
    customers,
    products,
    fullParcelPercent,
    minHoursBetweenSlots,
    minHoursBetweenSlotsScope,
    minSpacingHoursPerCustomer,
    slotAllocationRuleInbound: body.slotAllocationRuleInbound ?? "lowest_inventory",
    slotAllocationRuleOutbound: body.slotAllocationRuleOutbound ?? body.slotAllocationRule ?? "highest_inventory",
    slotAllocationRuleConflict: body.slotAllocationRuleConflict ?? "inbound_first",
    slotAllocationRule,
    customerStorageEntitlement: body.customerStorageEntitlement,
    terminalStorageEntitlement: body.terminalStorageEntitlement
  };
  return res.json({ ok: true });
  } catch (err: any) {
    console.error("POST /api/terminal/config error:", err);
    return res.status(500).json({ error: err?.message ?? "Internal server error" });
  }
});

app.post("/api/resources", (req, res) => {
  const body = req.body;
  if (!Array.isArray(body)) {
    return res.status(400).json({ error: "Expected an array of resources" });
  }
  terminalState.resources = body;
  res.json({ ok: true, count: terminalState.resources.length });
});

app.post("/api/schedule/propose", (req, res) => {
  if (!terminalConfig) {
    return res.status(400).json({ error: "Terminal not configured. Set /api/terminal/config first." });
  }

  const { requests } = req.body as { requests: TransportRequest[] };
  if (!Array.isArray(requests)) {
    return res.status(400).json({ error: "Expected 'requests' array" });
  }

  // Convert date strings to Date objects
  const hydratedRequests: TransportRequest[] = requests.map((r) => ({
    ...r,
    requestedWindow: {
      earliest: new Date((r as any).requestedWindow.earliest),
      latest: new Date((r as any).requestedWindow.latest)
    }
  }));

  const proposal = proposeSchedule(
    terminalState,
    hydratedRequests,
    {},
    {
      periodStart: terminalConfig.periodStart,
      periodEnd: terminalConfig.periodEnd,
      products: terminalConfig.products.map((p) => ({
        id: p.id,
        storageCapacity: p.storageCapacity
      })),
      minHoursBetweenSlots: terminalConfig.minHoursBetweenSlots ?? 0,
      minHoursBetweenSlotsScope: terminalConfig.minHoursBetweenSlotsScope ?? "all",
      minSpacingHoursPerCustomer: terminalConfig.minSpacingHoursPerCustomer ?? 0
    }
  );
  res.json(proposal);
});

app.post("/api/simulate/run", (req, res) => {
  if (!terminalConfig) {
    return res.status(400).json({ error: "Terminal not configured. Set /api/terminal/config first." });
  }

  // If resources weren't configured, provide simple defaults so the demo runs.
  if (terminalState.resources.length === 0) {
    terminalState.resources = [
      { id: "berth-1", name: "Berth 1", type: "berth" },
      { id: "arm-1", name: "Arm 1", type: "loading_arm" },
      { id: "pipeline-1", name: "Pipeline 1", type: "pipeline" },
      { id: "siding-1", name: "Siding 1", type: "rail_siding" }
    ] as any;
  }

  const body = req.body as { periodStart?: string; periodEnd?: string } | undefined;
  const periodStart = body?.periodStart ? new Date(body.periodStart) : terminalConfig.periodStart;
  const periodEnd = body?.periodEnd ? new Date(body.periodEnd) : terminalConfig.periodEnd;
  if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return res.status(400).json({ error: "Invalid periodStart/periodEnd" });
  }
  if (periodEnd.getTime() <= periodStart.getTime()) {
    return res.status(400).json({ error: "periodEnd must be after periodStart" });
  }

  const product = terminalConfig.products[0];
  const simCfg: TerminalSimulationConfig = {
    periodStart,
    periodEnd,
    unit: product.unit,
    terminalCapacity: product.storageCapacity,
    borrowingEnabled: terminalConfig.borrowingEnabled,
    productId: product.id,
    customers: terminalConfig.customers,
    fullParcelPercent: terminalConfig.fullParcelPercent ?? 100,
    minHoursBetweenSlots: terminalConfig.minHoursBetweenSlots ?? 0,
    minHoursBetweenSlotsScope: terminalConfig.minHoursBetweenSlotsScope ?? "all",
    minSpacingHoursPerCustomer: terminalConfig.minSpacingHoursPerCustomer ?? 0,
    slotAllocationRuleInbound: terminalConfig.slotAllocationRuleInbound ?? "lowest_inventory",
    slotAllocationRuleOutbound: terminalConfig.slotAllocationRuleOutbound ?? terminalConfig.slotAllocationRule ?? "highest_inventory",
    slotAllocationRuleConflict: terminalConfig.slotAllocationRuleConflict ?? "inbound_first",
    customerStorageEntitlement: terminalConfig.customerStorageEntitlement,
    terminalStorageEntitlement: terminalConfig.terminalStorageEntitlement
  };

  const result = runSimulation(terminalState, simCfg);
  res.json(result);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${PORT}`);
});

