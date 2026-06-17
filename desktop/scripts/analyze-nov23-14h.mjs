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
const { pacerAppliesForLeg, pacerInventoryContext } = require(path.join(__dirname, "../dist/engine/pacing.js"));
const { isTerminalTankBottom } = require(path.join(__dirname, "../dist/engine/inventory.js"));

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
const config = {
  startDate: new Date(cfgRow.start_date),
  endDate: new Date(cfgRow.end_date),
  pipelineFlowRate: cfgRow.pipeline_flow_rate,
  pipelineDirection: cfgRow.pipeline_direction,
  totalStorageCapacity: cfgRow.total_storage_capacity ?? 100000,
  storageMode: normalizeStorageMode(cfgRow.storage_mode),
  sharedInventoryCustomerDeficitLimitTonnes: cfgRow.shared_inventory_customer_deficit_limit_tonnes ?? 0,
  minSlotIntervalHours: cfgRow.min_slot_interval_hours ?? 0,
  pacerInboundRoundAtDecile: cfgRow.pacer_inbound_round_at_decile ?? 1,
  pacerInboundAllowance: cfgRow.pacer_inbound_allowance ?? 0.5,
  pacerOutboundRoundAtDecile: cfgRow.pacer_outbound_round_at_decile ?? 1,
  pacerOutboundAllowance: cfgRow.pacer_outbound_allowance ?? 0.5,
  optimizerRelativeDocMultiplier: cfgRow.optimizer_relative_doc_multiplier ?? 0,
  optimizerRelativeFulfillmentMultiplier: cfgRow.optimizer_relative_fulfillment_multiplier ?? 0,
  preOpsHours: cfgRow.pre_ops_hours ?? 0,
  postOpsHours: cfgRow.post_ops_hours ?? 0,
  tankCount: cfgRow.tank_count ?? 4,
  tankCapacity: cfgRow.tank_capacity ?? 7000,
  bargeBerthAllocation: normalizeBargeBerthAllocation(cfgRow.barge_berth_allocation)
};

const scenario = db.prepare("SELECT id, name FROM scenarios LIMIT 5").all();
db.close();

const result = runScheduler(customers, resources, config);
const lines = [];
const log = (s) => lines.push(s);

log(`Config start: ${config.startDate.toISOString()}`);
log(`Config end:   ${config.endDate.toISOString()}`);
log(`Storage mode: ${config.storageMode}`);
log(`Customers: ${customers.map((c) => c.name).join(", ")}`);
log(`Scenarios in DB: ${JSON.stringify(scenario)}`);
log("");

// Find Nov 23 rows - show local (en-GB) and UTC for hours around 14:00
const nov23 = result.simulationLog.filter((r) => (r.datetime ?? "").includes("2026-11-23"));
log(`Nov 23 rows in log: ${nov23.length}`);

// Re-run with hour-start vs end-of-hour terminal (matches Gantt pipeline row)
const simStartMs = config.startDate.getTime();
let prevTerminal = customers.reduce((s, c) => s + c.currentInventory, 0);
log(`Initial terminal: ${prevTerminal}`);
log("");

for (const row of nov23) {
  const d = new Date(row.datetime);
  const localFull = d.toLocaleString("en-GB");
  if (!localFull.includes("23/11/2026")) continue;
  const hourNum = parseInt(localFull.split(", ")[1]?.split(":")[0] ?? "-1", 10);
  if (hourNum < 13 || hourNum > 15) continue;
  const termEnd = row.terminalTotal ?? 0;
  // hour-start terminal = previous row end (or initial for h0)
  const prevRow = result.simulationLog.find((r) => r.hour === row.hour - 1);
  const termStart = prevRow ? (prevRow.terminalTotal ?? 0) : prevTerminal;
  log(`\nh${row.hour} local ${localFull}`);
  log(`  terminal at hour START (Gantt pipeline uses this): ${termStart} bottom=${isTerminalTankBottom(termStart)}`);
  log(`  terminal at hour END (log/Gantt tooltip): ${termEnd} bottom=${isTerminalTankBottom(termEnd)}`);
  for (const c of customers) {
    const inv = row.customerInventories[c.id] ?? 0;
    const inbound = (row.transportStatus ?? []).find(
      (t) => t.customerId === c.id && t.direction === "inbound" && t.mode === "ship"
    );
    if (inbound?.action === "idle" && inbound.blockingConstraint === "pace_ahead") {
      log(`  ${c.name} pace_ahead (end-of-hour inv=${inv})`);
    }
  }
}

// Also match rows where terminal is 0 on Nov 23
log("\n=== Nov 23 hours with terminalTotal <= 1 ===");
for (const row of nov23.filter((r) => (r.terminalTotal ?? 0) <= 1)) {
  log(`h${row.hour} ${row.datetime} terminal=${row.terminalTotal}`);
}

log("\n=== Nov 23 hours where ANY customer inv <= 0 AND terminal <= 1000 ===");
for (const row of nov23) {
  const term = row.terminalTotal ?? 0;
  const anyNeg = customers.some((c) => (row.customerInventories[c.id] ?? 0) <= 0);
  if (term <= 1000 && anyNeg) {
    log(`h${row.hour} local=${new Date(row.datetime).toLocaleString("en-GB")} term=${term}`);
  }
}

const outPath = path.join(__dirname, "nov23-14h-out.txt");
fs.writeFileSync(outPath, lines.join("\n"));
console.log(lines.join("\n"));
