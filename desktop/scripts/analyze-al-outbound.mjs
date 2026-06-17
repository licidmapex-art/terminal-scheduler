import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { runScheduler } = require(path.join(__dirname, "../dist/engine/scheduler.js"));
const { normalizeStorageMode } = require(path.join(__dirname, "../dist/db/simulationConfigs.js"));
const { normalizeBargeBerthAllocation } = require(path.join(__dirname, "../dist/engine/resourceAllocation.js"));
const { resolveCustomerPipelineRates, totalOutboundPipelineTph } = require(path.join(__dirname, "../dist/engine/pipelineFlows.js"));
const { tallyPipelineTonnesFromSimulationLog, tallyRefusedTonnesAtTankExtremes, countPipelineInterruptionHours } = require(path.join(__dirname, "../dist/engine/inventory.js"));
const { outboundTargetSlots, outboundThroughputTonnes } = require(path.join(__dirname, "../dist/engine/customerLegTargets.js"));

import Database from "better-sqlite3";

const dbPath = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "terminal-scheduler-desktop",
  "terminal-scheduler.db"
);
const db = new Database(dbPath, { readonly: true });

const customers = db.prepare("SELECT * FROM customers").all().map((r) => ({
  id: r.id,
  name: r.name,
  declaredInboundThroughput: r.declared_inbound_throughput ?? 0,
  currentInventory: r.current_inventory ?? 0,
  pipelineFlowPerHour: r.pipeline_flow_per_hour ?? 0,
  pipelineInboundPerHour: r.pipeline_inbound_per_hour ?? 0,
  pipelineOutboundPerHour: r.pipeline_outbound_per_hour ?? 0,
  storageShare: r.storage_share ?? 100,
  inboundTransports: r.inbound_transports_json ? JSON.parse(r.inbound_transports_json) : undefined,
  outboundTransports: r.outbound_transports_json ? JSON.parse(r.outbound_transports_json) : undefined,
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
  blackouts: db.prepare("SELECT * FROM blackouts WHERE resource_id = ?").all(r.id).map((b) => ({
    id: b.id,
    resourceId: b.resource_id,
    start: new Date(b.start),
    end: new Date(b.end)
  }))
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
  pacerRoundingDirection: cfgRow.pacer_rounding_direction === "down" ? "down" : "up",
  pacerRoundAtDecile: cfgRow.pacer_round_at_decile ?? 1,
  optimizerRelativeDocMultiplier: cfgRow.optimizer_relative_doc_multiplier ?? 0,
  optimizerRelativeFulfillmentMultiplier: cfgRow.optimizer_relative_fulfillment_multiplier ?? 0,
  preOpsHours: cfgRow.pre_ops_hours ?? 0,
  postOpsHours: cfgRow.post_ops_hours ?? 0,
  tankCount: cfgRow.tank_count ?? 4,
  tankCapacity: cfgRow.tank_capacity ?? 7000,
  bargeBerthAllocation: normalizeBargeBerthAllocation(cfgRow.barge_berth_allocation)
};

const periodHours = (config.endDate.getTime() - config.startDate.getTime()) / 3600000;
const result = runScheduler(customers, resources, config);

const al = customers.find((c) => /^AL$/i.test(c.name.trim()) || /AL/i.test(c.name));
if (!al) {
  console.log("AL customer not found. Customers:", customers.map((c) => c.name).join(", "));
  process.exit(1);
}

const rates = resolveCustomerPipelineRates(al, config);
const outTarget = outboundTargetSlots(al, config, periodHours);
const outThroughput = outboundThroughputTonnes(al, config, periodHours);

const outSlots = result.scheduledSlots.filter(
  (s) => s.customerId === al.id && s.direction === "outbound"
);
const outShipSlots = outSlots.filter((s) => s.mode === "ship");
const outBerthTonnes = outSlots.reduce((sum, s) => sum + (s.volume ?? 0), 0);
const pipelineOutTonnes = rates.outboundTph * periodHours;

const pipeTally = tallyPipelineTonnesFromSimulationLog(result.simulationLog);
const alPipe = pipeTally.get(al.id) ?? { inbound: 0, outbound: 0 };
const { tankTopHours, tankBottomHours } = countPipelineInterruptionHours(customers, config, result.simulationLog);
const refused = tallyRefusedTonnesAtTankExtremes(customers, config, result.simulationLog);
const alRefused = refused.get(al.id) ?? { refusedAtTopTonnes: 0, refusedAtBottomTonnes: 0 };

// Hours AL attributed inv <= 0
let alAtZeroHours = 0;
let alLowHours = 0;
for (const row of result.simulationLog) {
  const inv = row.customerInventories?.[al.id] ?? 0;
  if (inv <= 1) alAtZeroHours++;
  if (inv < rates.outboundTph) alLowHours++;
}

// Sample tank bottom hours
const bottomSamples = [];
for (const row of result.simulationLog) {
  const total = row.terminalTotal ?? 0;
  if (total <= 1) {
    const alInv = row.customerInventories?.[al.id] ?? 0;
    bottomSamples.push({ hour: row.hour, terminal: total, alInv });
    if (bottomSamples.length >= 10) break;
  }
}
const constraintCounts = {};
for (const row of result.simulationLog) {
  const t = row.transportStatus.find(
    (x) => x.customerId === al.id && x.direction === "outbound" && x.mode === "ship"
  );
  if (!t?.blockingConstraint) continue;
  constraintCounts[t.blockingConstraint] = (constraintCounts[t.blockingConstraint] ?? 0) + 1;
}

const invSeries = [];
for (const row of result.simulationLog) {
  const inv = row.customerInventories?.[al.id];
  if (inv != null) invSeries.push({ hour: row.hour, inv });
}

const minInv = invSeries.length ? Math.min(...invSeries.map((x) => x.inv)) : null;
const maxInv = invSeries.length ? Math.max(...invSeries.map((x) => x.inv)) : null;
const finalInv = invSeries.length ? invSeries[invSeries.length - 1].inv : null;

// Tank bottom from terminal total
let terminalBottomHours = 0;
for (const row of result.simulationLog) {
  const total = Object.values(row.customerInventories ?? {}).reduce((s, v) => s + v, 0);
  if (total <= 1) terminalBottomHours++;
}

const lines = [];
lines.push("=== AL outbound analysis ===");
lines.push(`Storage mode: ${config.storageMode}`);
lines.push(`Period: ${periodHours.toFixed(0)} h`);
lines.push(`Nominal pipeline outbound: ${Math.round(pipelineOutTonnes).toLocaleString()} t`);
lines.push(`Actual pipeline outbound (log): ${Math.round(alPipe.outbound).toLocaleString()} t`);
lines.push(`Shortfall vs nominal: ${Math.round(pipelineOutTonnes - alPipe.outbound).toLocaleString()} t (${((1 - alPipe.outbound / pipelineOutTonnes) * 100).toFixed(1)}%)`);
lines.push(`Terminal tank-bottom hours (blocks ALL outbound pipe): ${tankBottomHours}`);
lines.push(`AL refused outbound at tank bottom: ${alRefused.refusedAtBottomTonnes.toLocaleString()} t`);
lines.push(`AL hours attributed inv ≤ 1 t: ${alAtZeroHours}`);
lines.push(`AL hours attributed inv < outbound rate (${rates.outboundTph} t/h): ${alLowHours}`);
lines.push(`Total terminal outbound pipeline: ${totalOutboundPipelineTph(customers, config)} t/h`);
lines.push(`Outbound MEPS: ${al.outboundMEPS}, mode: ${al.outboundMode}`);
lines.push(`Target outbound slots: ${outTarget}, scheduled: ${outShipSlots.length} ship (${outSlots.length} total legs)`);
lines.push(`Berth outbound tonnes: ${Math.round(outBerthTonnes).toLocaleString()} t`);
lines.push(`AL inventory min/final/max: ${minInv?.toFixed(0) ?? "?"} / ${finalInv?.toFixed(0) ?? "?"} / ${maxInv?.toFixed(0) ?? "?"} t`);
lines.push(`Terminal at-bottom hours (≈0 t): ${terminalBottomHours}`);
lines.push("");
if (bottomSamples.length) {
  lines.push("Tank-bottom samples (terminal ~0, AL attributed inv):");
  for (const s of bottomSamples) {
    lines.push(`  h${s.hour}: terminal=${s.terminal.toFixed(0)} t, AL attributed=${s.alInv.toFixed(0)} t`);
  }
  lines.push("");
}
lines.push("Outbound ship idle constraints (hour counts):");
for (const [k, v] of Object.entries(constraintCounts).sort((a, b) => b[1] - a[1])) {
  lines.push(`  ${k}: ${v}`);
}

// Sample hours with tank_full / insufficient on outbound
lines.push("");
lines.push("Sample outbound ship blocking (first 15 non-loading idle hours with detail):");
let n = 0;
for (const row of result.simulationLog) {
  const t = row.transportStatus.find(
    (x) => x.customerId === al.id && x.direction === "outbound" && x.mode === "ship" && x.action === "idle"
  );
  if (!t?.blockingConstraint) continue;
  lines.push(`  h${row.hour}: ${t.blockingConstraint} — ${(t.constraintDetail ?? "").slice(0, 120)}`);
  n++;
  if (n >= 15) break;
}

// Compare other customers outbound pipeline
lines.push("");
lines.push("All customers outbound pipeline vs scheduled berth:");
for (const c of customers) {
  const r = resolveCustomerPipelineRates(c, config);
  const slots = result.scheduledSlots.filter((s) => s.customerId === c.id && s.direction === "outbound");
  const tonnes = slots.reduce((s, x) => s + (x.volume ?? 0), 0);
  const nom = r.outboundTph * periodHours;
  lines.push(
    `  ${c.name}: pipe ${r.outboundTph} t/h (${Math.round(nom).toLocaleString()} t) | berth ${Math.round(tonnes).toLocaleString()} t | ${slots.length} slots`
  );
}

// AL share of positive attributed pool when outbound pipe runs
let sumEffectiveOut = 0;
let sumNominalOut = 0;
let hoursNoPositive = 0;
let hoursAlNonPositive = 0;
for (let i = 1; i < result.simulationLog.length; i++) {
  const row = result.simulationLog[i];
  const invs = row.customerInventories ?? {};
  const positiveTotal = customers.reduce((s, c) => s + Math.max(0, invs[c.id] ?? 0), 0);
  const alBefore = invs[al.id] ?? 0;
  const flow = row.pipelineFlow?.[al.id] ?? 0;
  if (positiveTotal <= 0) {
    hoursNoPositive++;
    continue;
  }
  if (alBefore <= 0) {
    hoursAlNonPositive++;
    continue;
  }
  sumEffectiveOut += -Math.min(0, flow);
  sumNominalOut += rates.outboundTph;
}

lines.push(`Hours terminal has no positive attributed stock: ${hoursNoPositive}`);
lines.push(`Hours AL attributed ≤ 0 (no pipeline take): ${hoursAlNonPositive}`);
lines.push(`Avg AL share of positive pool (sampled): checking...`);

// Hourly share stats
const shares = [];
for (let i = 1; i < result.simulationLog.length; i++) {
  const invs = result.simulationLog[i].customerInventories ?? {};
  const positiveTotal = customers.reduce((s, c) => s + Math.max(0, invs[c.id] ?? 0), 0);
  const alBefore = invs[al.id] ?? 0;
  if (positiveTotal > 0 && alBefore > 0) shares.push(alBefore / positiveTotal);
}
if (shares.length) {
  const avg = shares.reduce((a, b) => a + b, 0) / shares.length;
  const min = Math.min(...shares);
  lines.push(`AL share of positive attributed pool: avg ${(avg * 100).toFixed(1)}%, min ${(min * 100).toFixed(1)}%`);
  lines.push(`Expected effective rate ≈ ${(rates.outboundTph * avg).toFixed(1)} t/h vs nominal ${rates.outboundTph} t/h`);
}

lines.push("");
lines.push("Customer starting inventory:");
for (const c of customers) {
  lines.push(`  ${c.name}: ${(c.currentInventory ?? 0).toLocaleString()} t`);
}

db.close();
const out = lines.join("\n");
fs.writeFileSync(path.join(__dirname, "al-outbound-out.txt"), out);
console.log(out);
