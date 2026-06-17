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
const {
  pacerAppliesForLeg,
  pacerInventoryContext,
  paceAllowanceForDirection
} = require(path.join(__dirname, "../dist/engine/pacing.js"));
const { isTerminalTankBottom } = require(path.join(__dirname, "../dist/engine/inventory.js"));

const datePrefix = process.argv[2] ?? "2026-11-23";

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
db.close();

const result = runScheduler(customers, resources, config);
const lines = [];
const log = (s) => lines.push(s);

log(`Sim ${config.startDate.toISOString().slice(0, 10)} → ${config.endDate.toISOString().slice(0, 10)}`);
log(`Storage: ${config.storageMode}, cap ${config.totalStorageCapacity}`);
log(`Analyzing dates starting ${datePrefix}\n`);

const rows = result.simulationLog.filter((r) => (r.datetime ?? "").startsWith(datePrefix.slice(0, 7)));

for (const day of ["2026-11-23", "2026-11-24", "2026-11-25"]) {
  const dayRows = result.simulationLog.filter((r) => (r.datetime ?? "").startsWith(day));
  if (dayRows.length === 0) continue;

  log(`=== ${day} (${dayRows.length} hours) ===`);
  let bottomHours = 0;
  let custBottomHours = 0;
  let paceOnlyInbound = 0;

  for (const row of dayRows) {
    const atBottom = isTerminalTankBottom(row.terminalTotal ?? 0);
    if (atBottom) bottomHours++;
    const anyCustBottom = customers.some((c) => (row.customerInventories[c.id] ?? 0) <= 0);
    if (anyCustBottom) custBottomHours++;

    const inboundShip = (row.transportStatus ?? []).filter(
      (t) => t.direction === "inbound" && t.mode === "ship" && t.action === "idle"
    );
    for (const t of inboundShip) {
      if (t.blockingConstraint !== "pace_ahead") continue;
      paceOnlyInbound++;
      if (day === "2026-11-23" && paceOnlyInbound <= 5) {
        const c = customers.find((x) => x.name === t.customerName);
        const inv = c ? row.customerInventories[c.id] : "?";
        const ctx = c
          ? pacerInventoryContext(config, c, customers, row.terminalTotal, row.customerInventories)
          : null;
        const applies = ctx
          ? pacerAppliesForLeg("inbound", config, ctx.terminalTotal, ctx.customerInventory, ctx.customerMax)
          : "?";
        log(
          `  h${row.hour} ${t.customerName}: pace | term=${row.terminalTotal} custInv=${inv} pacerApplies=${applies} | ${(t.constraintDetail ?? "").slice(0, 70)}`
        );
      }
    }
  }

  log(`  Physical tank-bottom (terminal≤1): ${bottomHours}/${dayRows.length}`);
  log(`  Any customer inv≤0: ${custBottomHours}/${dayRows.length}`);
  log(`  Inbound ship idle pace_ahead count: ${paceOnlyInbound}`);
  log("");
}

const noon = result.simulationLog.find((r) => (r.datetime ?? "").startsWith("2026-11-23T12"));
if (noon) {
  log(`=== Nov 23 ~noon h${noon.hour} terminal=${noon.terminalTotal} ===`);
  for (const c of customers) {
    log(`  ${c.name}: ${noon.customerInventories[c.id]}`);
  }
}

// Sample hour on Nov 23 with pace + bottom
const nov23 = result.simulationLog.filter((r) => (r.datetime ?? "").startsWith("2026-11-23"));
const sample = nov23.find((row) => {
  const atBottom = isTerminalTankBottom(row.terminalTotal ?? 0);
  if (!atBottom) return false;
  return (row.transportStatus ?? []).some(
    (t) => t.direction === "inbound" && t.mode === "ship" && t.blockingConstraint === "pace_ahead"
  );
});

if (sample) {
  log(`=== Sample mismatch h${sample.hour} ${sample.datetime} terminal=${sample.terminalTotal} ===`);
  for (const t of sample.transportStatus.filter((x) => x.direction === "inbound" && x.mode === "ship")) {
    log(`  ${t.customerName}: ${t.blockingConstraint} ${t.constraintDetail?.slice(0, 100) ?? ""}`);
  }
  // Recompute pacerApplies from log row (approximation - we don't have invById in log)
  const c = customers[0];
  if (c) {
    const ctx = {
      terminalTotal: sample.terminalTotal,
      customerInventory: sample.customerInventories[c.id] ?? 0,
      customerMax: config.totalStorageCapacity * (c.storageShare / 100)
    };
    log(`  pacerApplies(inbound) with terminal=${ctx.terminalTotal}: ${pacerAppliesForLeg("inbound", config, ctx.terminalTotal, ctx.customerInventory, ctx.customerMax)}`);
  }
}

const outPath = path.join(__dirname, "nov23-out.txt");
fs.writeFileSync(outPath, lines.join("\n"));
console.log(lines.join("\n"));
