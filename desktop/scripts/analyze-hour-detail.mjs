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
  averagePoolFulfillmentRatioAtHour,
  countLegSlotsThroughHour,
  customerLegFulfillmentRatio,
  relativeFulfillmentOptimizerShouldYield
} = require(path.join(__dirname, "../dist/engine/optimizer.js"));
const { inboundTargetSlotsByLane } = require(path.join(__dirname, "../dist/engine/customerLegTargets.js"));

const HOUR_MS = 60 * 60 * 1000;
const h = Number(process.argv[2] ?? 6716);

const dbPath = path.join(os.homedir(), "AppData", "Roaming", "terminal-scheduler-desktop", "terminal-scheduler.db");
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
const simStartMs = config.startDate.getTime();
const periodHours = Math.max(Math.floor((new Date(config.endDate).getTime() - simStartMs) / HOUR_MS), 1);
const mult = config.optimizerRelativeFulfillmentMultiplier;

const legs = customers
  .map((c) => {
    const lane = inboundTargetSlotsByLane(c, periodHours).find((t) => t.mode === "ship" && t.targetSlots > 0);
    if (!lane) return null;
    return {
      customer: c,
      direction: "inbound",
      mode: "ship",
      laneKey: `${lane.mode}-lane${lane.laneIndex}`,
      targetSlots: lane.targetSlots,
      meps: c.inboundMEPS,
      roundtripHours: c.inboundRoundtripHours ?? 0
    };
  })
  .filter(Boolean);

const slotsBefore = result.scheduledSlots.filter(
  (s) => Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS) < h
);
const sampleLeg = legs[0];
const avg = averagePoolFulfillmentRatioAtHour(
  sampleLeg,
  legs,
  slotsBefore,
  simStartMs,
  h,
  false,
  true
);

console.log(`Hour ${h} — fulfillment optimizer mult ${mult}, pool avg ${avg != null ? (avg * 100).toFixed(2) : "?"}%`);
for (const leg of legs) {
  const slotsThrough = countLegSlotsThroughHour(leg, slotsBefore, simStartMs, h - 1);
  const ratio = customerLegFulfillmentRatio(leg, slotsThrough);
  const yields = relativeFulfillmentOptimizerShouldYield(ratio, avg, mult);
  console.log(
    `${leg.customer.name}: ${slotsThrough}/${leg.targetSlots} (${(ratio * 100).toFixed(1)}%) yield=${yields}`
  );
}

const row = result.simulationLog.find((r) => r.hour === h);
console.log("\nLog:");
for (const t of row.transportStatus.filter((x) => x.direction === "inbound" && x.mode === "ship")) {
  console.log(`${t.customerName}: ${t.action} ${t.blockingConstraint ?? ""}`);
  if (t.constraintDetail) console.log(`  ${t.constraintDetail}`);
}

const newSlots = result.scheduledSlots.filter(
  (s) => Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS) === h
);
console.log("\nNew slots at h:", newSlots.map((s) => customers.find((c) => c.id === s.customerId)?.name).join(", ") || "(none)");
