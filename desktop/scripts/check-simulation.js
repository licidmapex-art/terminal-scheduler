#!/usr/bin/env node
/**
 * Check the latest simulation data from the database.
 * Run: node scripts/check-simulation.js
 */
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.platform === "win32"
  ? path.join(process.env.APPDATA || "", "terminal-scheduler-desktop", "terminal-scheduler.db")
  : path.join(process.env.HOME || "", ".config", "terminal-scheduler-desktop", "terminal-scheduler.db");

try {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  console.log("\n=== SIMULATION CONFIG ===\n");
  const config = db.prepare("SELECT * FROM simulation_configs LIMIT 1").get();
  if (config) {
    console.log("Period:", config.start_date, "->", config.end_date);
    console.log("Pipeline direction (config):", config.pipeline_direction, "(legacy total rate field:", config.pipeline_flow_rate, "— use customer pipeline_flow_per_hour)");
    console.log("Storage:", config.storage_mode, "| Capacity:", config.total_storage_capacity);
    console.log("Min slot interval:", config.min_slot_interval_hours, "h");
  } else {
    console.log("No config");
  }

  console.log("\n=== CUSTOMERS ===\n");
  const customers = db.prepare("SELECT id, name, outbound_mode, outbound_meps, current_inventory, pipeline_flow_per_hour FROM customers").all();
  customers.forEach((c) => {
    console.log(`${c.name} (${c.id}): outbound=${c.outbound_mode}, MEPS=${c.outbound_meps}t, inventory=${c.current_inventory}, pipelineFlow=${c.pipeline_flow_per_hour} t/h`);
  });

  console.log("\n=== RESOURCES ===\n");
  const resources = db.prepare("SELECT id, name, type, flow_rate FROM resources").all();
  resources.forEach((r) => {
    console.log(`${r.name} (${r.type}): ${r.flow_rate} t/h`);
  });

  console.log("\n=== TRANSPORT REQUESTS (generated) ===\n");
  const requests = db.prepare(`
    SELECT tr.id, tr.customer_id, tr.direction, tr.mode, tr.volume, tr.earliest_start, c.name as customer_name
    FROM transport_requests tr
    LEFT JOIN customers c ON c.id = tr.customer_id
  `).all();
  requests.forEach((r) => {
    console.log(`${r.customer_name} | ${r.direction} ${r.mode} ${r.volume}t | earliest: ${r.earliest_start}`);
  });

  console.log("\n=== SCHEDULED SLOTS ===\n");
  const slots = db.prepare(`
    SELECT ss.id, ss.request_id, ss.customer_id, ss.resource_id, ss.start, ss.end, ss.status,
           c.name as customer_name, r.name as resource_name, r.type as resource_type, tr.mode
    FROM scheduled_slots ss
    LEFT JOIN customers c ON c.id = ss.customer_id
    LEFT JOIN resources r ON r.id = ss.resource_id
    LEFT JOIN transport_requests tr ON tr.id = ss.request_id
    ORDER BY ss.start
  `).all();
  if (slots.length === 0) {
    console.log("No slots scheduled");
  } else {
    slots.forEach((s) => {
      console.log(`${s.customer_name} | ${s.mode || "?"} @ ${s.resource_name} (${s.resource_type}) | ${s.start} -> ${s.end} | ${s.status || "scheduled"}`);
    });
  }

  console.log("\n");
  db.close();
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
