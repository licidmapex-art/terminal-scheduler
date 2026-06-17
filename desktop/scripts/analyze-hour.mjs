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
const { paceAllowanceForDirection } = require(path.join(__dirname, "../dist/engine/pacing.js"));
const {
  compareSchedulingLegs,
  countLegSlotsThroughHour,
  hoursSinceLastLegSlot,
  legSortMetric,
  customerLegFulfillmentRatio
} = require(path.join(__dirname, "../dist/engine/optimizer.js"));
const { inboundTargetSlotsByLane } = require(path.join(__dirname, "../dist/engine/customerLegTargets.js"));

const HOUR_MS = 60 * 60 * 1000;
const TARGET_HOUR = Number(process.argv[2] ?? 6717);

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
  pacerRoundAtDecile: cfgRow.pacer_round_at_decile ?? 1,
  pacerInboundRoundAtDecile: cfgRow.pacer_inbound_round_at_decile ?? cfgRow.pacer_round_at_decile ?? 1,
  pacerInboundAllowance: cfgRow.pacer_inbound_allowance ?? 0.5,
  pacerOutboundRoundAtDecile: cfgRow.pacer_outbound_round_at_decile ?? cfgRow.pacer_round_at_decile ?? 1,
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
const simStartMs = config.startDate.getTime();
const periodHours = Math.floor((new Date(config.endDate).getTime() - simStartMs) / HOUR_MS);
const sharedShipping = config.storageMode === "shared_shipping";
const sharedInventory = config.storageMode === "shared_inventory";
const periodHoursSafe = Math.max(periodHours, 1);
const inboundShipLegs = customers
  .map((c) => {
    const lanes = inboundTargetSlotsByLane(c, periodHoursSafe).filter((t) => t.mode === "ship" && t.targetSlots > 0);
    if (lanes.length === 0) return null;
    const lane = lanes[0];
    return {
      customer: c,
      direction: "inbound",
      mode: "ship",
      targetSlots: lane.targetSlots,
      meps: c.inboundMEPS
    };
  })
  .filter(Boolean);

const row = result.simulationLog.find((r) => r.hour === TARGET_HOUR);
const lines = [];
const log = (s) => lines.push(s);

log(`Hour ${TARGET_HOUR} (${row?.datetime ?? "?"})`);
log(`Storage mode: ${config.storageMode}`);
log(
  `Pacer inbound: decile ${config.pacerInboundRoundAtDecile}, allowance ${config.pacerInboundAllowance}; outbound: decile ${config.pacerOutboundRoundAtDecile}, allowance ${config.pacerOutboundAllowance}`
);

function slotStartHour(s) {
  return Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
}

const slotsAtH = result.scheduledSlots.filter((s) => slotStartHour(s) === TARGET_HOUR);
log(`\nSlots starting at h${TARGET_HOUR}:`);
for (const s of slotsAtH) {
  const c = customers.find((x) => x.id === s.customerId);
  log(`  ${c?.name ?? s.customerId} ${s.direction} ${s.mode} vol=${s.volume} resource=${s.resourceId}`);
}
if (slotsAtH.length === 0) {
  log("  (none — checking h-2..h+1)");
  for (const s of result.scheduledSlots.filter((x) => {
    const sh = slotStartHour(x);
    return sh >= TARGET_HOUR - 2 && sh <= TARGET_HOUR + 1;
  })) {
    const c = customers.find((x) => x.id === s.customerId);
    log(`  h${slotStartHour(s)} ${c?.name ?? s.customerId} ${s.direction} ${s.mode}`);
  }
}

if (!row) {
  log("\nNo simulation log row for this hour.");
} else {
  log("\n=== Transport status (all ship) ===");
  for (const t of row.transportStatus.filter((x) => x.mode === "ship")) {
    log(
      `${t.customerName} ${t.direction}: action=${t.action} block=${t.blockingConstraint ?? "—"} doc=${t.daysOfCover ?? "—"} opt=${t.optimizerDaysOfCover ?? "—"}`
    );
    if (t.constraintDetail) log(`  detail: ${t.constraintDetail}`);
  }
}

// Reconstruct scheduler state at start of hour TARGET_HOUR
const assignedBefore = result.scheduledSlots.filter((s) => {
  const sh = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
  return sh < TARGET_HOUR;
});

function loadsStartedByHourAgg(h, direction, mode) {
  if (h < 0) return 0;
  return assignedBefore.filter((s) => {
    if (s.direction !== direction || s.mode !== mode) return false;
    const sh = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
    return sh <= h;
  }).length;
}

function loadsStartedByHour(h, customerId, direction, mode) {
  if (h < 0) return 0;
  return assignedBefore.filter((s) => {
    if (s.customerId !== customerId || s.direction !== direction || s.mode !== mode) return false;
    const sh = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
    return sh <= h;
  }).length;
}

const aggInboundTarget = inboundShipLegs.reduce((s, l) => s + l.targetSlots, 0);

const nBeforeAgg = loadsStartedByHourAgg(TARGET_HOUR - 1, "inbound", "ship");
const paceInbound = paceAllowanceForDirection(
  TARGET_HOUR,
  Math.max(periodHours, 1),
  aggInboundTarget,
  "inbound",
  config
);
log(`\n=== Inbound ship pool pace at h${TARGET_HOUR} ===`);
log(`Combined target: ${aggInboundTarget}`);
log(`Slots started through h${TARGET_HOUR - 1} (agg): ${nBeforeAgg}`);
log(
  `Pace continuous ${paceInbound.continuous.toFixed(3)} → allowance ${paceInbound.allowance} (decile ${paceInbound.settings.roundAtDecile}, offset ${paceInbound.settings.allowance})`
);
log(`Pace blocks new slot? ${nBeforeAgg >= paceInbound.allowance || nBeforeAgg >= aggInboundTarget}`);

const inboundStarts = result.scheduledSlots
  .filter((s) => s.direction === "inbound" && s.mode === "ship")
  .map((s) => ({
    h: slotStartHour(s),
    name: customers.find((c) => c.id === s.customerId)?.name ?? s.customerId,
    id: s.customerId
  }))
  .sort((a, b) => a.h - b.h);
log(`\n=== Inbound ship slot #22-26 (pool position) ===`);
for (let i = 21; i < Math.min(26, inboundStarts.length); i++) {
  const s = inboundStarts[i];
  log(`  #${i + 1} h${s.h} ${s.name}`);
}
const slot24 = inboundStarts[23];
if (slot24) {
  const row24 = result.simulationLog.find((r) => r.hour === slot24.h);
  log(`\n=== Hour ${slot24.h} when pool slot #24 (${slot24.name}) was assigned ===`);
  if (row24) {
    for (const t of row24.transportStatus.filter((x) => x.mode === "ship" && x.direction === "inbound")) {
      log(`${t.customerName}: ${t.action} ${t.blockingConstraint ?? ""} ${(t.constraintDetail ?? "").slice(0, 90)}`);
    }
  }
}

log("\n=== Per-customer inbound ship pace (if per-customer) ===");
for (const leg of inboundShipLegs) {
  const c = leg.customer;
  const nBefore = loadsStartedByHour(TARGET_HOUR - 1, c.id, "inbound", "ship");
  const pace = paceAllowanceForDirection(TARGET_HOUR, Math.max(periodHours, 1), leg.targetSlots, "inbound", config);
  const ratio = customerLegFulfillmentRatio(leg, countLegSlotsThroughHour(leg, assignedBefore, simStartMs, TARGET_HOUR));
  log(
    `${c.name}: slots ${nBefore}/${leg.targetSlots}, per-cust allowance ${pace.allowance}, fulfilment ${(ratio * 100).toFixed(1)}%`
  );
}

// Merit order for inbound ship legs at this hour (inventory from log row before slots)
const invAtHour = row?.customerInventories ?? {};
const poolProportional = sharedShipping;
const terminalInv = row?.terminalTotal ?? 0;
const ordered = [...inboundShipLegs].sort((a, b) => {
  const invA = poolProportional ? terminalInv : (invAtHour[a.customer.id] ?? 0);
  const invB = poolProportional ? terminalInv : (invAtHour[b.customer.id] ?? 0);
  const maxA = config.totalStorageCapacity ?? 100000;
  const maxB = maxA;
  const mA = legSortMetric(
    a,
    invA,
    maxA,
    config,
    periodHoursSafe,
    poolProportional,
    a.customer,
    customers,
    inboundShipLegs
  );
  const mB = legSortMetric(
    b,
    invB,
    maxB,
    config,
    periodHoursSafe,
    poolProportional,
    b.customer,
    customers,
    inboundShipLegs
  );
  const slotsA = countLegSlotsThroughHour(a, assignedBefore, simStartMs, TARGET_HOUR);
  const slotsB = countLegSlotsThroughHour(b, assignedBefore, simStartMs, TARGET_HOUR);
  const waitA = hoursSinceLastLegSlot(a, assignedBefore, simStartMs, TARGET_HOUR);
  const waitB = hoursSinceLastLegSlot(b, assignedBefore, simStartMs, TARGET_HOUR);
  return compareSchedulingLegs(
    a,
    b,
    mA,
    mB,
    sharedShipping,
    slotsA,
    slotsB,
    sharedInventory,
    waitA,
    waitB
  );
});

log("\n=== Merit order inbound ship at h${TARGET_HOUR} (first = tried first) ===".replace("${TARGET_HOUR}", String(TARGET_HOUR)));
for (const leg of ordered) {
  const slots = countLegSlotsThroughHour(leg, assignedBefore, simStartMs, TARGET_HOUR - 1);
  const slotsThroughH = countLegSlotsThroughHour(leg, result.scheduledSlots, simStartMs, TARGET_HOUR - 1);
  const ratio = customerLegFulfillmentRatio(leg, slots);
  const wait = hoursSinceLastLegSlot(leg, assignedBefore, simStartMs, TARGET_HOUR);
  log(
    `  ${leg.customer.name}: fulfil ${(ratio * 100).toFixed(1)}%, wait ${wait}h, target ${leg.targetSlots}, slots through h-1: ${slotsThroughH}`
  );
}

const outPath = path.join(__dirname, `hour-${TARGET_HOUR}-out.txt`);
fs.writeFileSync(outPath, lines.join("\n"));
console.log(lines.join("\n"));
console.log("\nWrote " + outPath);
