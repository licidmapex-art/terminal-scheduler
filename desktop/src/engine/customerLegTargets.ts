/**
 * Target slot counts per customer leg — same rules as deriveLegs in scheduler.ts.
 */

import type { BerthTransportMode, Customer, CustomerTransportConfig, SimulationConfig } from "../types";
import { getCustomerMaxCapacity } from "./inventory";
import { resolveCustomerPipelineRates } from "./pipelineFlows";
import {
  customerDirectionTransports,
  customerSchedulableTransports,
  splitTonnesByShares
} from "./customerTransports";
import { roundtripSharingForBerthMode, resolvedCustomerSchedulableTransports } from "./transportPools";
import type { TransportPool } from "../types";
import { legLabelsForTransports } from "./transportLegLabels";

export function inboundTargetSlots(customer: Customer, periodHours: number): number {
  return inboundTargetSlotsByLane(customer, periodHours).reduce((s, r) => s + r.targetSlots, 0);
}

export function outboundThroughputTonnes(
  customer: Customer,
  config: SimulationConfig,
  periodHours: number
): number {
  const { inboundTph, outboundTph } = resolveCustomerPipelineRates(customer, config);
  return (
    customer.declaredInboundThroughput +
    inboundTph * periodHours -
    outboundTph * periodHours
  );
}

/** Inbound tonnes for the period (declared transport + inbound pipeline). */
export function inboundThroughputTonnes(
  customer: Customer,
  config: SimulationConfig,
  periodHours: number
): number {
  const { inboundTph } = resolveCustomerPipelineRates(customer, config);
  return Math.max(0, customer.declaredInboundThroughput + inboundTph * periodHours);
}

/** Max outbound volume when roundtrip is the binding limit: Σ floor(period ÷ roundtrip) × MEPS per lane. */
export function outboundRoundtripCapacityTonnes(customer: Customer, periodHours: number): number {
  const rows = customerSchedulableTransports(customer, "outbound");
  let total = 0;
  for (const r of rows) {
    const rt = r.roundtripHours ?? 0;
    if (r.meps <= 0 || rt <= 0) continue;
    total += Math.floor(periodHours / rt) * r.meps;
  }
  return total;
}

export function outboundTargetSlots(customer: Customer, config: SimulationConfig, periodHours: number): number {
  return outboundTargetSlotsByLane(customer, config, periodHours).reduce((s, r) => s + r.targetSlots, 0);
}

export interface LaneTarget {
  laneIndex: number;
  legLabel: string;
  mode: "ship" | "barge" | "train";
  meps: number;
  roundtripHours: number;
  sharePct: number;
  targetSlots: number;
  poolId?: string | null;
  inventoryAllocation?: "attributed" | "proportional";
}

function lanePoolMeta(
  row: { poolId?: string | null; mode: CustomerTransportConfig["mode"] },
  _pools: TransportPool[]
): Pick<LaneTarget, "poolId" | "inventoryAllocation"> {
  if (!row.poolId || row.mode === "pool") {
    return { poolId: row.poolId ?? null };
  }
  return {
    poolId: row.poolId,
    inventoryAllocation: roundtripSharingForBerthMode(row.mode as "ship" | "barge" | "train")
  };
}

export function inboundTargetSlotsByLane(
  customer: Customer,
  periodHours: number,
  pools: TransportPool[] = []
): LaneTarget[] {
  const rows = resolvedCustomerSchedulableTransports(customer, "inbound", pools);
  if (rows.length === 0 || customer.declaredInboundThroughput <= 0) return [];
  const labels = legLabelsForTransports(rows);
  const tonnesByLane = splitTonnesByShares(customer.declaredInboundThroughput, rows);
  return rows.map((r, laneIndex) => {
    const laneTonnes = Math.max(0, tonnesByLane[laneIndex] ?? 0);
    if (r.meps <= 0 || laneTonnes <= 0) {
      return {
        laneIndex,
        legLabel: labels[laneIndex] ?? `${r.mode} ${laneIndex + 1}`,
        mode: r.mode as BerthTransportMode,
        meps: r.meps,
        roundtripHours: r.roundtripHours,
        sharePct: r.sharePct,
        targetSlots: 0,
        ...lanePoolMeta(r, pools)
      };
    }
    const byThroughput = Math.ceil(laneTonnes / r.meps);
    const rt = r.roundtripHours ?? 0;
    const target = rt > 0 ? Math.min(byThroughput, Math.floor(periodHours / rt)) : byThroughput;
    return {
      laneIndex,
      legLabel: labels[laneIndex] ?? `${r.mode} ${laneIndex + 1}`,
      mode: r.mode as BerthTransportMode,
      meps: r.meps,
      roundtripHours: r.roundtripHours,
      sharePct: r.sharePct,
      targetSlots: target > 0 ? target : 0,
      ...lanePoolMeta(r, pools)
    };
  });
}

export function outboundTargetSlotsByLane(
  customer: Customer,
  config: SimulationConfig,
  periodHours: number,
  pools: TransportPool[] = []
): LaneTarget[] {
  const rows = resolvedCustomerSchedulableTransports(customer, "outbound", pools);
  const totalOutbound = Math.max(0, outboundThroughputTonnes(customer, config, periodHours));
  if (rows.length === 0 || totalOutbound <= 0) return [];
  const labels = legLabelsForTransports(rows);
  const tonnesByLane = splitTonnesByShares(totalOutbound, rows);
  return rows.map((r, laneIndex) => {
    const laneTonnes = Math.max(0, tonnesByLane[laneIndex] ?? 0);
    if (r.meps <= 0 || laneTonnes <= 0) {
      return {
        laneIndex,
        legLabel: labels[laneIndex] ?? `${r.mode} ${laneIndex + 1}`,
        mode: r.mode as BerthTransportMode,
        meps: r.meps,
        roundtripHours: r.roundtripHours,
        sharePct: r.sharePct,
        targetSlots: 0,
        ...lanePoolMeta(r, pools)
      };
    }
    const byThroughput = Math.ceil(laneTonnes / r.meps);
    const rt = r.roundtripHours ?? 0;
    const target = rt > 0 ? Math.min(byThroughput, Math.floor(periodHours / rt)) : byThroughput;
    return {
      laneIndex,
      legLabel: labels[laneIndex] ?? `${r.mode} ${laneIndex + 1}`,
      mode: r.mode as BerthTransportMode,
      meps: r.meps,
      roundtripHours: r.roundtripHours,
      sharePct: r.sharePct,
      targetSlots: target > 0 ? target : 0,
      ...lanePoolMeta(r, pools)
    };
  });
}

const SORT_METRIC_EPS = 1e-6;

/**
 * One number for Analytics / charts: same ingredients as the scheduler leg sort — **inbound**-style need
 * `inv ÷ total outbound pressure`, **outbound**-style need `headroom ÷ total inbound pressure`. When both
 * pressures exist, returns the **minimum** (tightest operational bottleneck). Pipeline-only flows included.
 * Returns `null` only when no usable denominator remains.
 */
export function customerRepresentativeDaysOfCover(
  inv: number,
  customer: Customer,
  config: SimulationConfig,
  periodHours: number
): number | null {
  const periodDays = Math.max(periodHours / 24, 1e-9);
  const customerMax = getCustomerMaxCapacity(customer, config);
  const headroom = Math.max(0, customerMax - inv);
  const { inboundTph, outboundTph } = resolveCustomerPipelineRates(customer, config);
  const pipelineInboundPerDay = inboundTph * 24;
  const pipelineOutboundPerDay = outboundTph * 24;

  const inSlots = inboundTargetSlots(customer, periodHours);
  const outSlots = outboundTargetSlots(customer, config, periodHours);
  const transportInPerDay = inSlots > 0 ? (inSlots * customer.inboundMEPS) / periodDays : 0;
  const transportOutPerDay = outSlots > 0 ? (outSlots * customer.outboundMEPS) / periodDays : 0;

  const inPressure = pipelineInboundPerDay + transportInPerDay;
  const outPressure = pipelineOutboundPerDay + transportOutPerDay;

  const cands: number[] = [];
  if (outPressure > SORT_METRIC_EPS) cands.push(inv / outPressure);
  if (inPressure > SORT_METRIC_EPS) cands.push(headroom / inPressure);

  if (cands.length === 0) {
    const daily = Math.max(pipelineInboundPerDay, pipelineOutboundPerDay);
    if (daily <= 0) return null;
    return inv / daily;
  }

  return Math.min(...cands);
}

/**
 * Terminal-wide DoC from configured targets (no scheduler legs): same formula as
 * {@link customerRepresentativeDaysOfCover} but uses total terminal inventory and summed pressures.
 */
export function terminalRepresentativeDaysOfCover(
  terminalInventory: number,
  customers: Customer[],
  config: SimulationConfig,
  periodHours: number
): number | null {
  const mode = config.storageMode ?? "fixed_band";
  const sharedPool = mode === "shared_shipping" || mode === "shared_inventory";
  const capacity = sharedPool
    ? (config.totalStorageCapacity ?? 100000)
    : customers.reduce((s, c) => s + getCustomerMaxCapacity(c, config), 0);
  const headroom = Math.max(0, capacity - terminalInventory);
  const periodDays = Math.max(periodHours / 24, 1e-9);

  let inPressure = 0;
  let outPressure = 0;
  for (const c of customers) {
    const { inboundTph, outboundTph } = resolveCustomerPipelineRates(c, config);
    inPressure += inboundTph * 24;
    outPressure += outboundTph * 24;
    const inSlots = inboundTargetSlots(c, periodHours);
    const outSlots = outboundTargetSlots(c, config, periodHours);
    inPressure += inSlots > 0 ? (inSlots * c.inboundMEPS) / periodDays : 0;
    outPressure += outSlots > 0 ? (outSlots * c.outboundMEPS) / periodDays : 0;
  }

  const cands: number[] = [];
  if (outPressure > SORT_METRIC_EPS) cands.push(terminalInventory / outPressure);
  if (inPressure > SORT_METRIC_EPS) cands.push(headroom / inPressure);
  if (cands.length === 0) {
    const daily = Math.max(inPressure, outPressure);
    if (daily <= 0) return null;
    return terminalInventory / daily;
  }
  return Math.min(...cands);
}
