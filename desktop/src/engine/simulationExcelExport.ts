/**
 * Build Excel workbooks for simulation log + hourly pipeline/berth flows.
 */

import * as XLSX from "xlsx";
import type { Customer, ScheduledSlot, SimulationConfig } from "../types";
import type { SimulationLogRow } from "./simulationLog";
import { laytimeFromConfig, getCargoWindowMs, hourOverlapsIntervalMs } from "./slotLaytime";
import { totalInboundPipelineTph, totalOutboundPipelineTph } from "./pipelineFlows";

const MODES = ["ship", "barge", "train"] as const;

function berthBucketKey(customerId: string, direction: "inbound" | "outbound", mode: string): string {
  return `${customerId}|${direction}|${mode}`;
}

/** Tonnes moved by berths per clock hour, keyed by {@link berthBucketKey}. */
export function computeHourlyBerthTonnesByBucket(
  slots: ScheduledSlot[],
  config: SimulationConfig,
  maxHourInclusive: number
): Map<number, Record<string, number>> {
  const { preOps, postOps } = laytimeFromConfig(config);
  const simStartMs = new Date(config.startDate).getTime();
  const out = new Map<number, Record<string, number>>();
  for (let h = 0; h <= maxHourInclusive; h++) {
    out.set(h, {});
  }
  for (const slot of slots) {
    const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
    if (loadingHours <= 0) continue;
    const flowPerHour = slot.volume / loadingHours;
    const key = berthBucketKey(slot.customerId, slot.direction, slot.mode);
    for (let h = 0; h <= maxHourInclusive; h++) {
      if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
      const rec = out.get(h)!;
      rec[key] = (rec[key] ?? 0) + flowPerHour;
    }
  }
  return out;
}

/** Sum of hourly berth tonnes per customer (inbound / outbound), matching simulation Excel totals. */
export function tallyBerthTonnesByCustomerFromSlots(
  slots: ScheduledSlot[],
  config: SimulationConfig,
  maxHourInclusive: number
): Map<string, { inbound: number; outbound: number }> {
  const byHour = computeHourlyBerthTonnesByBucket(slots, config, maxHourInclusive);
  const m = new Map<string, { inbound: number; outbound: number }>();
  for (let h = 0; h <= maxHourInclusive; h++) {
    const rec = byHour.get(h);
    if (!rec) continue;
    for (const [key, tonnes] of Object.entries(rec)) {
      const parts = key.split("|");
      if (parts.length < 2) continue;
      const customerId = parts[0]!;
      const direction = parts[1];
      const cur = m.get(customerId) ?? { inbound: 0, outbound: 0 };
      if (direction === "inbound") cur.inbound += tonnes;
      else if (direction === "outbound") cur.outbound += tonnes;
      m.set(customerId, cur);
    }
  }
  return m;
}

function splitPipelineTonnes(signedRate: number): { inT: number; outT: number } {
  if (signedRate >= 0) return { inT: signedRate, outT: 0 };
  return { inT: 0, outT: -signedRate };
}

function transportSummary(row: SimulationLogRow): string {
  return (row.transportStatus ?? [])
    .map((s) => {
      const extra = s.blockingConstraint ? ` [${s.blockingConstraint}]` : "";
      return `${s.customerName} ${s.mode} ${s.direction}: ${s.action}${extra}`;
    })
    .join(" | ");
}

function sortedCustomers(customers: Customer[]): Customer[] {
  return [...customers].sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSimulationWorkbook(
  log: SimulationLogRow[],
  slots: ScheduledSlot[],
  config: SimulationConfig,
  customers: Customer[]
): XLSX.WorkBook {
  const cust = sortedCustomers(customers);
  const sharedShipping = config.storageMode === "shared_shipping";
  const inboundPipelineTotal = totalInboundPipelineTph(cust, config);
  const outboundPipelineTotal = totalOutboundPipelineTph(cust, config);
  const maxHour = log.length ? Math.max(...log.map((r) => r.hour)) : 0;
  const berthByHour = computeHourlyBerthTonnesByBucket(slots, config, maxHour);

  type ColDef = { key: string; kind: "meta" | "sum"; get: (row: SimulationLogRow) => string | number };

  const colDefs: ColDef[] = [
    { key: "Hour", kind: "meta", get: (r) => r.hour },
    { key: "DateTime", kind: "meta", get: (r) => r.datetime },
    { key: "TerminalTotal_t", kind: "sum", get: (r) => r.terminalTotal ?? 0 }
  ];
  for (const c of cust) {
    colDefs.push({
      key: `${c.name}_inventory_t`,
      kind: "sum",
      get: (r) => r.customerInventories?.[c.id] ?? 0
    });
  }

  if (sharedShipping) {
    colDefs.push(
      {
        key: "Terminal_pipeline_in_t_h",
        kind: "sum",
        get: (r) => (r.hour <= 0 ? 0 : inboundPipelineTotal)
      },
      {
        key: "Terminal_pipeline_out_t_h",
        kind: "sum",
        get: (r) => (r.hour <= 0 ? 0 : outboundPipelineTotal)
      }
    );
  }

  for (const c of cust) {
    colDefs.push(
      {
        key: `${c.name}_pipeline_in_t_h`,
        kind: "sum",
        get: (r) => {
          if (r.hour <= 0) return 0;
          const f = r.pipelineFlow?.[c.id] ?? 0;
          return splitPipelineTonnes(f).inT;
        }
      },
      {
        key: `${c.name}_pipeline_out_t_h`,
        kind: "sum",
        get: (r) => {
          if (r.hour <= 0) return 0;
          const f = r.pipelineFlow?.[c.id] ?? 0;
          return splitPipelineTonnes(f).outT;
        }
      }
    );
  }

  for (const c of cust) {
    for (const mode of MODES) {
      for (const dir of ["inbound", "outbound"] as const) {
        const k = berthBucketKey(c.id, dir, mode);
        colDefs.push({
          key: `${c.name}_berth_${mode}_${dir === "inbound" ? "in" : "out"}_t_h`,
          kind: "sum",
          get: (r) => berthByHour.get(r.hour)?.[k] ?? 0
        });
      }
    }
  }

  colDefs.push({
    key: "Transport_summary",
    kind: "meta",
    get: (r) => transportSummary(r)
  });

  const hourlyHeader = colDefs.map((c) => c.key);
  const hourlyDataRows: (string | number)[][] = [];
  const sums: number[] = colDefs.map((def) => (def.kind === "sum" ? 0 : NaN));

  for (const row of log) {
    const line: (string | number)[] = [];
    for (let i = 0; i < colDefs.length; i++) {
      const def = colDefs[i]!;
      const v = def.get(row);
      line.push(v);
      if (def.kind === "sum" && typeof v === "number" && !Number.isNaN(sums[i]!)) {
        sums[i]! += v;
      }
    }
    hourlyDataRows.push(line);
  }

  const summaryAoA: (string | number)[][] = [
    ["Simulation export — terminal scheduler"],
    [
      "Start",
      new Date(config.startDate).toISOString(),
      "End",
      new Date(config.endDate).toISOString(),
      "Storage_mode",
      config.storageMode ?? "fixed_band"
    ],
    [
      "Note",
      sharedShipping
        ? "shared_shipping: Terminal_pipeline_* columns show nominal tonnes/h (sum of customer pipeline rates). Per-customer pipeline columns mirror the log (nominal attribution). Terminal pool may clamp in the model."
        : "Hour 0 pipeline applied = 0 (matches engine). Berth tonnes/h use the same cargo-window overlap as the scheduler."
    ],
    [],
    ["Column", "Total_sum_over_hours"]
  ];

  for (let i = 0; i < colDefs.length; i++) {
    const def = colDefs[i]!;
    if (def.kind === "sum" && !Number.isNaN(sums[i]!)) {
      summaryAoA.push([def.key, sums[i]!]);
    }
  }

  const logSheetHeader = ["Hour", "DateTime", "TerminalTotal_t"];
  for (const c of cust) {
    logSheetHeader.push(`${c.name}_inventory_t`);
  }
  for (const c of cust) {
    logSheetHeader.push(`${c.name}_pipeline_signed_t_h`);
  }
  logSheetHeader.push("Transport_summary");

  const logSheetRows: (string | number)[][] = [logSheetHeader];
  for (const row of log) {
    const line: (string | number)[] = [
      row.hour,
      row.datetime,
      row.terminalTotal ?? 0
    ];
    for (const c of cust) {
      line.push(row.customerInventories?.[c.id] ?? 0);
    }
    for (const c of cust) {
      line.push(row.pipelineFlow?.[c.id] ?? 0);
    }
    line.push(transportSummary(row));
    logSheetRows.push(line);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryAoA), "Summary");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([hourlyHeader, ...hourlyDataRows]),
    "Hourly flows"
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(logSheetRows), "Simulation log");
  return wb;
}

/** Serialize workbook to Node Buffer (main process). */
export function writeSimulationWorkbookToBuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
