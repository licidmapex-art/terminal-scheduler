import { getDatabase } from "./database";
import type { Customer } from "../types";
import {
  customerDirectionTransports,
  legacyDirectionTransport
} from "../engine/customerTransports";

function parseTransportJson(raw: string | null | undefined): Customer["inboundTransports"] {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as Customer["inboundTransports"]) : undefined;
  } catch {
    return undefined;
  }
}

export function createCustomer(customer: Customer): Customer {
  const db = getDatabase();
  const inRows = customerDirectionTransports(customer, "inbound");
  const outRows = customerDirectionTransports(customer, "outbound");
  const legacyIn = legacyDirectionTransport(customer, "inbound");
  const legacyOut = legacyDirectionTransport(customer, "outbound");
  const stmt = db.prepare(`
    INSERT INTO customers (id, name, declared_inbound_throughput, current_inventory, pipeline_flow_per_hour, storage_share, inbound_meps, inbound_mode, outbound_meps, outbound_mode, inbound_roundtrip_hours, outbound_roundtrip_hours, inbound_transports_json, outbound_transports_json, time_shared_min_band, time_shared_duration, chart_color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    customer.id,
    customer.name,
    customer.declaredInboundThroughput,
    customer.currentInventory,
    customer.pipelineFlowPerHour,
    customer.storageShare,
    legacyIn.meps,
    legacyIn.mode,
    legacyOut.meps,
    legacyOut.mode,
    legacyIn.roundtripHours,
    legacyOut.roundtripHours,
    JSON.stringify(inRows),
    JSON.stringify(outRows),
    customer.timeSharedMinBand ?? 0,
    customer.timeSharedDuration ?? 24,
    customer.chartColor ?? null
  );
  return customer;
}

export function getAllCustomers(): Customer[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM customers").all() as Array<{
    id: string;
    name: string;
    declared_inbound_throughput: number;
    current_inventory: number;
    pipeline_flow_per_hour: number;
    storage_share: number;
    inbound_meps: number;
    inbound_mode: string;
    outbound_meps: number;
    outbound_mode: string;
    inbound_roundtrip_hours?: number;
    outbound_roundtrip_hours?: number;
    inbound_transports_json?: string | null;
    outbound_transports_json?: string | null;
    time_shared_min_band?: number;
    time_shared_duration?: number;
    chart_color?: string | null;
  }>;
  return rows.map((r) => {
    const inboundTransports = parseTransportJson(r.inbound_transports_json);
    const outboundTransports = parseTransportJson(r.outbound_transports_json);
    return {
      id: r.id,
      name: r.name,
      declaredInboundThroughput: r.declared_inbound_throughput,
      currentInventory: r.current_inventory,
      pipelineFlowPerHour: r.pipeline_flow_per_hour ?? 0,
      storageShare: r.storage_share,
      inboundTransports,
      outboundTransports,
      inboundMEPS: r.inbound_meps ?? 0,
      inboundMode: (r.inbound_mode ?? "ship") as Customer["inboundMode"],
      outboundMEPS: r.outbound_meps ?? 0,
      outboundMode: (r.outbound_mode ?? "ship") as Customer["outboundMode"],
      inboundRoundtripHours: r.inbound_roundtrip_hours ?? 0,
      outboundRoundtripHours: r.outbound_roundtrip_hours ?? 0,
      timeSharedMinBand: r.time_shared_min_band ?? 0,
      timeSharedDuration: r.time_shared_duration ?? 24,
      chartColor: r.chart_color ?? null
    };
  });
}

export function getCustomerById(id: string): Customer | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as {
    id: string;
    name: string;
    declared_inbound_throughput: number;
    current_inventory: number;
    pipeline_flow_per_hour: number;
    storage_share: number;
    inbound_meps?: number;
    inbound_mode?: string;
    outbound_meps?: number;
    outbound_mode?: string;
    inbound_roundtrip_hours?: number;
    outbound_roundtrip_hours?: number;
    inbound_transports_json?: string | null;
    outbound_transports_json?: string | null;
    time_shared_min_band?: number;
    time_shared_duration?: number;
    chart_color?: string | null;
  } | undefined;
  if (!row) return null;
  const inboundTransports = parseTransportJson(row.inbound_transports_json);
  const outboundTransports = parseTransportJson(row.outbound_transports_json);
  return {
    id: row.id,
    name: row.name,
    declaredInboundThroughput: row.declared_inbound_throughput,
    currentInventory: row.current_inventory,
    pipelineFlowPerHour: row.pipeline_flow_per_hour ?? 0,
    storageShare: row.storage_share,
    inboundTransports,
    outboundTransports,
    inboundMEPS: row.inbound_meps ?? 0,
    inboundMode: (row.inbound_mode ?? "ship") as Customer["inboundMode"],
    outboundMEPS: row.outbound_meps ?? 0,
    outboundMode: (row.outbound_mode ?? "ship") as Customer["outboundMode"],
    inboundRoundtripHours: row.inbound_roundtrip_hours ?? 0,
    outboundRoundtripHours: row.outbound_roundtrip_hours ?? 0,
    timeSharedMinBand: row.time_shared_min_band ?? 0,
    timeSharedDuration: row.time_shared_duration ?? 24,
    chartColor: row.chart_color ?? null
  };
}

export function updateCustomer(customer: Customer): Customer {
  const db = getDatabase();
  const inRows = customerDirectionTransports(customer, "inbound");
  const outRows = customerDirectionTransports(customer, "outbound");
  const legacyIn = legacyDirectionTransport(customer, "inbound");
  const legacyOut = legacyDirectionTransport(customer, "outbound");
  const stmt = db.prepare(`
    UPDATE customers SET
      name = ?,
      declared_inbound_throughput = ?,
      current_inventory = ?,
      pipeline_flow_per_hour = ?,
      storage_share = ?,
      inbound_meps = ?,
      inbound_mode = ?,
      outbound_meps = ?,
      outbound_mode = ?,
      inbound_roundtrip_hours = ?,
      outbound_roundtrip_hours = ?,
      inbound_transports_json = ?,
      outbound_transports_json = ?,
      time_shared_min_band = ?,
      time_shared_duration = ?,
      chart_color = ?
    WHERE id = ?
  `);
  stmt.run(
    customer.name,
    customer.declaredInboundThroughput,
    customer.currentInventory,
    customer.pipelineFlowPerHour,
    customer.storageShare,
    legacyIn.meps,
    legacyIn.mode,
    legacyOut.meps,
    legacyOut.mode,
    legacyIn.roundtripHours,
    legacyOut.roundtripHours,
    JSON.stringify(inRows),
    JSON.stringify(outRows),
    customer.timeSharedMinBand ?? 0,
    customer.timeSharedDuration ?? 24,
    customer.chartColor ?? null,
    customer.id
  );
  return customer;
}

export function deleteCustomer(id: string): void {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare("DELETE FROM scheduled_slots WHERE customer_id = ?").run(id);
    db.prepare("DELETE FROM inventory_snapshots WHERE customer_id = ?").run(id);
    db.prepare("DELETE FROM customers WHERE id = ?").run(id);
  })();
}
