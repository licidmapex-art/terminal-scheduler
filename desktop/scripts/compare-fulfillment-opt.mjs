import fs from "fs";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { runScheduler } = require(path.join(__dirname, "../dist/engine/scheduler.js"));
const { normalizeStorageMode } = require(path.join(__dirname, "../dist/db/simulationConfigs.js"));
const { normalizeBargeBerthAllocation } = require(path.join(__dirname, "../dist/engine/resourceAllocation.js"));

const dbPath = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "terminal-scheduler-desktop",
  "terminal-scheduler.db"
);
const db = new Database(dbPath, { readonly: true });
const parseTransportJson = (raw) => {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};

const customers = db.prepare("SELECT * FROM customers").all().map((r) => ({
  id: r.id,
  name: r.name,
  declaredInboundThroughput: r.declared_inbound_throughput ?? 0,
  currentInventory: r.current_inventory ?? 0,
  pipelineFlowPerHour: r.pipeline_flow_per_hour ?? 0,
  pipelineInboundPerHour: r.pipeline_inbound_per_hour ?? 0,
  pipelineOutboundPerHour: r.pipeline_outbound_per_hour ?? 0,
  storageShare: r.storage_share ?? 100,
  inboundTransports: parseTransportJson(r.inbound_transports_json),
  outboundTransports: parseTransportJson(r.outbound_transports_json),
  inboundMEPS: r.inbound_meps ?? 0,
  inboundMode: r.inbound_mode ?? "ship",
  outboundMEPS: r.outbound_meps ?? 0,
  outboundMode: r.outbound_mode ?? "ship",
  inboundRoundtripHours: r.inbound_roundtrip_hours ?? 0,
  outboundRoundtripHours: r.outbound_roundtrip_hours ?? 0,
  timeSharedMinBand: r.time_shared_min_band ?? 0,
  timeSharedDuration: r.time_shared_duration ?? 24,
  chartColor: r.chart_color ?? null
}));

const resources = db.prepare("SELECT * FROM resources").all().map((r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  flowRate: r.flow_rate,
  blackouts: db
    .prepare("SELECT * FROM blackouts WHERE resource_id = ?")
    .all(r.id)
    .map((b) => ({ id: b.id, resourceId: b.resource_id, start: new Date(b.start), end: new Date(b.end) }))
}));

const cfgRow = db.prepare("SELECT * FROM simulation_configs LIMIT 1").get();
function makeConfig(fulfillmentMult) {
  return {
    startDate: new Date(cfgRow.start_date),
    endDate: new Date(cfgRow.end_date),
    pipelineFlowRate: cfgRow.pipeline_flow_rate,
    pipelineDirection: cfgRow.pipeline_direction,
    totalStorageCapacity: cfgRow.total_storage_capacity ?? 100000,
    storageMode: normalizeStorageMode(cfgRow.storage_mode),
    sharedInventoryCustomerDeficitLimitTonnes: cfgRow.shared_inventory_customer_deficit_limit_tonnes ?? 0,
    minSlotIntervalHours: cfgRow.min_slot_interval_hours ?? 0,
    pacerRoundingDirection: cfgRow.pacer_rounding_direction === "down" ? "down" : "up",
    pacerRoundAtDecile: cfgRow.pacer_round_at_decile ?? 1,
    optimizerRelativeDocMultiplier: cfgRow.optimizer_relative_doc_multiplier ?? 0,
    optimizerRelativeFulfillmentMultiplier: fulfillmentMult,
    preOpsHours: cfgRow.pre_ops_hours ?? 0,
    postOpsHours: cfgRow.post_ops_hours ?? 0,
    tankCount: cfgRow.tank_count ?? 4,
    tankCapacity: cfgRow.tank_capacity ?? 7000,
    bargeBerthAllocation: normalizeBargeBerthAllocation(cfgRow.barge_berth_allocation)
  };
}

const nameById = Object.fromEntries(customers.map((c) => [c.id, c.name]));

const lines = [];
const log = (s) => lines.push(s);

function summarize(label, result) {
  const inboundShips = result.scheduledSlots.filter((s) => s.direction === "inbound" && s.mode === "ship");
  const byCust = {};
  for (const s of inboundShips) {
    const n = nameById[s.customerId];
    byCust[n] = (byCust[n] ?? 0) + 1;
  }
  const yieldHours = result.simulationLog.filter((row) =>
    row.transportStatus.some((t) => t.blockingConstraint === "optimizer_fulfillment")
  ).length;
  const yieldByCust = {};
  for (const row of result.simulationLog) {
    for (const t of row.transportStatus) {
      if (t.blockingConstraint !== "optimizer_fulfillment") continue;
      yieldByCust[t.customerName] = (yieldByCust[t.customerName] ?? 0) + 1;
    }
  }
  log(`\n=== ${label} ===`);
  log("Inbound ship slots: " + JSON.stringify(byCust));
  log("Total inbound ship slots: " + inboundShips.length);
  log("Hours with optimizer_fulfillment idle: " + yieldHours);
  log("optimizer_fulfillment by customer: " + JSON.stringify(yieldByCust));
  return { byCust, inboundShips, yieldHours };
}

const config = makeConfig(0);
log("Storage mode: " + config.storageMode);
log("DB fulfillment multiplier: " + (cfgRow.optimizer_relative_fulfillment_multiplier ?? "(null)"));

const off = runScheduler(customers, resources, makeConfig(0));
const on1 = runScheduler(customers, resources, makeConfig(1));

const sOff = summarize("OFF (0)", off);
const sOn = summarize("ON (1.0)", on1);

log("\n=== Diff OFF vs ON(1.0) ===");
for (const c of customers) {
  const n = c.name;
  const a = sOff.byCust[n] ?? 0;
  const b = sOn.byCust[n] ?? 0;
  if (a !== b) log(`${n}: ${a} -> ${b}`);
}
const same =
  sOff.inboundShips.length === sOn.inboundShips.length &&
  JSON.stringify(sOff.byCust) === JSON.stringify(sOn.byCust);
log(same ? "NO DIFFERENCE in slot assignment at multiplier 1.0" : "Slot assignment changed");

const ineos = customers.find((c) => /ineos/i.test(c.name));

// Compare slot start hours for Ineos
if (ineos) {
  const startsOff = off.scheduledSlots
    .filter((s) => s.customerId === ineos.id && s.direction === "inbound" && s.mode === "ship")
    .map((s) => Math.round((new Date(s.start).getTime() - config.startDate.getTime()) / 3600000))
    .sort((a, b) => a - b);
  const startsOn = on1.scheduledSlots
    .filter((s) => s.customerId === ineos.id && s.direction === "inbound" && s.mode === "ship")
    .map((s) => Math.round((new Date(s.start).getTime() - config.startDate.getTime()) / 3600000))
    .sort((a, b) => a - b);
  log("\n=== Ineos slot start hours OFF vs ON ===");
  log("OFF: " + startsOff.join(", "));
  log("ON:  " + startsOn.join(", "));
  log("Same hours: " + (startsOff.join() === startsOn.join()));
}

// At h5870: who would win without optimizer, why does AL/Yara fail?
log("\n=== Hour 5870 blocking (ON 1.0) ===");
const h5870 = on1.simulationLog.find((r) => r.hour === 5870);
if (h5870) {
  for (const t of h5870.transportStatus.filter((x) => x.direction === "inbound" && x.mode === "ship")) {
    if (t.action === "idle") log(`${t.customerName}: ${t.blockingConstraint} — ${(t.constraintDetail ?? "").slice(0, 100)}`);
  }
}

if (ineos) {
  log("\n=== Ineos optimizer_fulfillment hours ON 1.0 (h5800-6500) ===");
  let n = 0;
  for (const row of on1.simulationLog) {
    if (row.hour < 5800 || row.hour > 6500) continue;
    const t = row.transportStatus.find(
      (x) => x.customerId === ineos.id && x.direction === "inbound" && x.mode === "ship" && x.action === "idle"
    );
    if (!t || t.blockingConstraint !== "optimizer_fulfillment") continue;
    log(`h${row.hour}: ${(t.constraintDetail ?? "").slice(0, 120)}`);
    n++;
    if (n >= 15) break;
  }
  if (n === 0) log("(none)");
}

db.close();
fs.writeFileSync(path.join(__dirname, "compare-out.txt"), lines.join("\n"));
