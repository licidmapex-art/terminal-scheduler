/**
 * Inventory timeline – hourly projected inventory from pipeline, storage rules, and assigned slots.
 */

import type { Customer, SimulationConfig, ScheduledSlot } from "../types";
import {
  laytimeFromConfig,
  getCargoWindowMs,
  hourOverlapsIntervalMs
} from "./slotLaytime";
import type { SimulationLogRow } from "./simulationLog";
import {
  resolveCustomerPipelineRates,
  totalInboundPipelineTph,
  totalOutboundPipelineTph,
  customerPipelineNetDeltaPerHour
} from "./pipelineFlows";

export type InventoryTimeline = Map<string, number[]>;

/** Simulation length in whole hours — must match `buildTimeline` / `runScheduler` (floored). */
export function simulationPeriodHoursFloored(config: SimulationConfig): number {
  const simStart = new Date(config.startDate);
  const simEnd = new Date(config.endDate);
  return Math.floor((simEnd.getTime() - simStart.getTime()) / (1000 * 60 * 60));
}

/**
 * Tonnes of pipeline recorded in the scheduler log, per customer.
 * Only hours &gt; 0 are summed — hour 0 is logged before pipeline is applied in the engine.
 * Signed flow: positive = inventory increase from pipeline, negative = decrease.
 */
export function tallyPipelineTonnesFromSimulationLog(
  rows: Array<{ hour: number; pipelineFlow: Record<string, number> }>
): Map<string, { inbound: number; outbound: number }> {
  const m = new Map<string, { inbound: number; outbound: number }>();
  for (const row of rows) {
    if (row.hour <= 0) continue;
    for (const [cid, flow] of Object.entries(row.pipelineFlow)) {
      const cur = m.get(cid) ?? { inbound: 0, outbound: 0 };
      if (flow >= 0) cur.inbound += flow;
      else cur.outbound += -flow;
      m.set(cid, cur);
    }
  }
  return m;
}

export interface TankExtremeRefusalTonnes {
  refusedAtTopTonnes: number;
  refusedAtBottomTonnes: number;
}

const EXTREME_EPS = 1;

/** Count terminal pipeline-interruption hours (same rules as the Gantt pipeline row). */
export function countPipelineInterruptionHours(
  customers: Customer[],
  config: SimulationConfig,
  log: SimulationLogRow[]
): { tankTopHours: number; tankBottomHours: number } {
  if (log.length === 0) return { tankTopHours: 0, tankBottomHours: 0 };
  const cap = config.totalStorageCapacity ?? 100_000;
  const hasInboundPipe = totalInboundPipelineTph(customers, config) > 0;
  const hasOutboundPipe = totalOutboundPipelineTph(customers, config) > 0;
  let tankTopHours = 0;
  let tankBottomHours = 0;
  for (const row of log) {
    const total = row.terminalTotal ?? 0;
    if (hasInboundPipe && total >= cap - EXTREME_EPS) tankTopHours++;
    if (hasOutboundPipe && total <= EXTREME_EPS) tankBottomHours++;
  }
  return { tankTopHours, tankBottomHours };
}

/**
 * Pipeline product refused during terminal pipeline interruption: customer flow (t/h) × interrupted hours.
 * Tank top blocks inbound pipeline; tank bottom blocks outbound pipeline (Gantt pipeline row).
 */
export function tallyRefusedTonnesAtTankExtremes(
  customers: Customer[],
  config: SimulationConfig,
  log: SimulationLogRow[]
): Map<string, TankExtremeRefusalTonnes> {
  const out = new Map<string, TankExtremeRefusalTonnes>();
  for (const c of customers) {
    out.set(c.id, { refusedAtTopTonnes: 0, refusedAtBottomTonnes: 0 });
  }

  const hasPipeline =
    totalInboundPipelineTph(customers, config) > 0 ||
    totalOutboundPipelineTph(customers, config) > 0;
  if (!hasPipeline || log.length === 0) return out;

  const { tankTopHours, tankBottomHours } = countPipelineInterruptionHours(customers, config, log);

  for (const c of customers) {
    const { inboundTph, outboundTph } = resolveCustomerPipelineRates(c, config);
    out.set(c.id, {
      refusedAtTopTonnes:
        inboundTph > 0 ? Math.round(inboundTph * tankTopHours * 10) / 10 : 0,
      refusedAtBottomTonnes:
        outboundTph > 0 ? Math.round(outboundTph * tankBottomHours * 10) / 10 : 0
    });
  }
  return out;
}

export function getCustomerMaxCapacity(customer: Customer, config: SimulationConfig): number {
  return (config.totalStorageCapacity * customer.storageShare) / 100;
}

/**
 * For shared_inventory: when attributed tonnes exceed the terminal cap (sum > cap), scale all
 * attributions down proportionally. Individual customers may be negative (deficit vs share while
 * loading out); do not clamp rows to zero here — that would hide real attributed shortfalls.
 */
export function normalizeSharedInventoryToCap(
  invById: Record<string, number>,
  customers: Customer[],
  cap: number
): void {
  const sum = customers.reduce((s, c) => s + (invById[c.id] ?? 0), 0);
  if (sum <= cap || sum <= 0) return;
  const scale = cap / sum;
  for (const c of customers) {
    invById[c.id] = (invById[c.id] ?? 0) * scale;
  }
}

/**
 * One hour of pipeline for shared_inventory: terminal-wide pool (inbound curtailed at cap),
 * attribution unchanged except aggregate scaling on outbound (mirrors commingled terminal clamp).
 * Returns effective tonnes/hour added per customer (same sign convention as pipelineFlowRecord).
 */
export function applySharedInventoryPipelineHour(
  invById: Record<string, number>,
  customers: Customer[],
  config: SimulationConfig
): Record<string, number> {
  const cap = config.totalStorageCapacity ?? 100000;
  let S = customers.reduce((s, c) => s + (invById[c.id] ?? 0), 0);
  const inboundTotal = totalInboundPipelineTph(customers, config);
  const outboundTotal = totalOutboundPipelineTph(customers, config);
  const effective: Record<string, number> = Object.fromEntries(customers.map((c) => [c.id, 0]));

  if (inboundTotal > 0) {
    const headroom = Math.max(0, cap - S);
    const deltaTotal = Math.min(headroom, inboundTotal);
    for (const c of customers) {
      const { inboundTph } = resolveCustomerPipelineRates(c, config);
      const add = inboundTotal > 0 ? (deltaTotal * inboundTph) / inboundTotal : 0;
      invById[c.id] = (invById[c.id] ?? 0) + add;
      effective[c.id] += add;
      S += add;
    }
  }

  if (outboundTotal > 0) {
    const newT = Math.max(0, Math.min(cap, S - outboundTotal));
    const delta = S - newT;
    const positiveTotal = customers.reduce((sum, c) => sum + Math.max(0, invById[c.id] ?? 0), 0);
    if (positiveTotal > 0 && delta > 0) {
      for (const c of customers) {
        const { outboundTph } = resolveCustomerPipelineRates(c, config);
        if (outboundTph <= 0) continue;
        const before = invById[c.id] ?? 0;
        if (before <= 0) continue;
        const take = (delta * before) / positiveTotal;
        const after = before - take;
        invById[c.id] = after;
        effective[c.id] += after - before;
      }
    }
  }

  return effective;
}

/**
 * Builds per-customer hourly inventory from initial stocks, pipeline, and gradual berth flows.
 */
export function buildTimeline(
  customers: Customer[],
  config: SimulationConfig,
  assignedSlots: ScheduledSlot[]
): InventoryTimeline {
  const simStart = new Date(config.startDate);
  const simEnd = new Date(config.endDate);
  const periodHours = Math.floor(
    (simEnd.getTime() - simStart.getTime()) / (1000 * 60 * 60)
  );
  const capacity = config.totalStorageCapacity ?? 100000;

  if (config.storageMode === "shared_shipping") {
    const totalStorageShare =
      customers.reduce((s, c) => s + c.storageShare, 0) || 100;
    const shareFrac = (c: Customer) =>
      totalStorageShare > 0 ? c.storageShare / totalStorageShare : 1 / customers.length;

    const timeline = new Map<string, number[]>();
    for (const customer of customers) {
      timeline.set(customer.id, new Array(periodHours + 1).fill(0));
    }

    let terminal = customers.reduce((s, c) => s + c.currentInventory, 0);
    const inboundTotal = totalInboundPipelineTph(customers, config);
    const outboundTotal = totalOutboundPipelineTph(customers, config);
    const simStartMs = simStart.getTime();
    const { preOps, postOps } = laytimeFromConfig(config);

    for (let h = 0; h <= periodHours; h++) {
      if (h > 0) {
        terminal += inboundTotal - outboundTotal;
        terminal = Math.max(0, Math.min(capacity, terminal));
      }

      for (const slot of assignedSlots) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (loadingHours <= 0) continue;
        if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
        const flowPerHour = slot.volume / loadingHours;
        const sign = slot.direction === "inbound" ? 1 : -1;
        terminal += sign * flowPerHour;
      }

      terminal = Math.max(0, Math.min(capacity, terminal));

      for (const customer of customers) {
        const arr = timeline.get(customer.id)!;
        arr[h] = terminal * shareFrac(customer);
      }
    }

    return timeline;
  }

  if (config.storageMode === "shared_inventory") {
    const invById: Record<string, number> = {};
    for (const c of customers) invById[c.id] = c.currentInventory;
    const timeline = new Map<string, number[]>();
    for (const c of customers) timeline.set(c.id, []);
    const simStartMs = simStart.getTime();
    const { preOps, postOps } = laytimeFromConfig(config);

    for (let h = 0; h <= periodHours; h++) {
      if (h > 0) {
        applySharedInventoryPipelineHour(invById, customers, config);
      }
      for (const slot of assignedSlots) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (loadingHours <= 0) continue;
        if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
        const flowPerHour = slot.volume / loadingHours;
        const sign = slot.direction === "inbound" ? 1 : -1;
        invById[slot.customerId] = (invById[slot.customerId] ?? 0) + sign * flowPerHour;
      }
      normalizeSharedInventoryToCap(invById, customers, capacity);
      for (const c of customers) {
        timeline.get(c.id)!.push(invById[c.id] ?? 0);
      }
    }
    return timeline;
  }

  const timeline = new Map<string, number[]>();
  const simStartMs = simStart.getTime();
  const { preOps, postOps } = laytimeFromConfig(config);

  for (const customer of customers) {
    const customerMax = getCustomerMaxCapacity(customer, config);
    const pipelineDelta = customerPipelineNetDeltaPerHour(customer, config);

    const customerSlots = assignedSlots.filter((s) => s.customerId === customer.id);
    const arr: number[] = [];
    let runningInventory = customer.currentInventory;

    for (let h = 0; h <= periodHours; h++) {
      if (h > 0) {
        runningInventory += pipelineDelta;
      }

      for (const slot of customerSlots) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (loadingHours <= 0) continue;
        if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
        const flowPerHour = slot.volume / loadingHours;
        const sign = slot.direction === "inbound" ? 1 : -1;
        runningInventory += sign * flowPerHour;
      }

      runningInventory = Math.max(0, Math.min(customerMax, runningInventory));

      arr.push(runningInventory);
    }

    timeline.set(customer.id, arr);
  }

  return timeline;
}

/**
 * Net stock motion from pipeline + berth flows **without** tank / pool shaping that only changes
 * how inventory is attributed, not total pipeline + slot tonnes:
 * - **fixed_band**: no per-customer min/max clamp
 * - **shared_inventory**: no `normalizeSharedInventoryToCap` after slot hours (pool scale-down)
 *
 * Each value is **final uncapped model inventory minus `customer.currentInventory`** (full simulated
 * horizon, including hour 0), so it matches pipeline log + slot volumes aggregated the same way.
 */
export function theoreticalInventoryDeltaWithoutTankClamp(
  customers: Customer[],
  config: SimulationConfig,
  assignedSlots: ScheduledSlot[]
): Map<string, number> | null {
  const simStart = new Date(config.startDate);
  const simEnd = new Date(config.endDate);
  const periodHours = Math.floor((simEnd.getTime() - simStart.getTime()) / (1000 * 60 * 60));
  const simStartMs = simStart.getTime();
  const { preOps, postOps } = laytimeFromConfig(config);

  if (config.storageMode === "shared_inventory") {
    const invById: Record<string, number> = {};
    for (const c of customers) invById[c.id] = c.currentInventory;

    for (let h = 0; h <= periodHours; h++) {
      if (h > 0) {
        applySharedInventoryPipelineHour(invById, customers, config);
      }
      for (const slot of assignedSlots) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (loadingHours <= 0) continue;
        if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
        const flowPerHour = slot.volume / loadingHours;
        const sign = slot.direction === "inbound" ? 1 : -1;
        invById[slot.customerId] = (invById[slot.customerId] ?? 0) + sign * flowPerHour;
      }
    }

    const out = new Map<string, number>();
    for (const c of customers) {
      out.set(c.id, (invById[c.id] ?? 0) - c.currentInventory);
    }
    return out;
  }

  if (config.storageMode !== "fixed_band") {
    return null;
  }

  const out = new Map<string, number>();
  for (const customer of customers) {
    const pipelineDelta = customerPipelineNetDeltaPerHour(customer, config);

    const customerSlots = assignedSlots.filter((s) => s.customerId === customer.id);
    let runningInventory = customer.currentInventory;

    for (let h = 0; h <= periodHours; h++) {
      if (h > 0) {
        runningInventory += pipelineDelta;
      }

      for (const slot of customerSlots) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (loadingHours <= 0) continue;
        if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
        const flowPerHour = slot.volume / loadingHours;
        const sign = slot.direction === "inbound" ? 1 : -1;
        runningInventory += sign * flowPerHour;
      }

      // no Math.max(0, Math.min(customerMax, ...)) — uncapped motion
    }

    /* Full horizon vs configured opening stock (matches pipeline + slot tonnes). */
    out.set(customer.id, runningInventory - customer.currentInventory);
  }

  return out;
}

export function getProjectedInventory(
  customerId: string,
  datetime: Date | string,
  timeline: InventoryTimeline,
  config: SimulationConfig,
  _customers: Customer[]
): number {
  const arr = timeline.get(customerId);
  if (!arr || arr.length === 0) return 0;

  const simStart = new Date(config.startDate);
  const dt = datetime instanceof Date ? datetime : new Date(datetime);
  const hoursFromStart = (dt.getTime() - simStart.getTime()) / (1000 * 60 * 60);
  const h = Math.floor(hoursFromStart);
  const clampedH = Math.max(0, Math.min(h, arr.length - 1));
  return arr[clampedH] ?? 0;
}
