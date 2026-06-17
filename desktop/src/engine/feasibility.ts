/**
 * Feasibility checks – run before scheduling. Returns warnings, not hard errors.
 */

import type { Customer, Resource, SimulationConfig } from "../types";
import { laytimeFromConfig } from "./slotLaytime";
import { customerDirectionTransports } from "./customerTransports";
import {
  inboundThroughputTonnes,
  outboundRoundtripCapacityTonnes,
  outboundThroughputTonnes
} from "./customerLegTargets";
import { resolveCustomerPipelineRates } from "./pipelineFlows";
import { getCompatibleResources } from "./resourceAllocation";
import { reservationMode } from "./berthReservation";

/** Derived transport leg for feasibility + scheduler (no persisted requests). */
export interface SchedulingLeg {
  customer: Customer;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  laneIndex?: number;
  laneKey?: string;
  laneLabel?: string;
  meps: number;
  targetSlots: number;
  roundtripHours: number;
  reservationWindowHours?: number;
  /** Shared transport pool — roundtrip enforced across pool members only for attributed (single-asset) pools. */
  poolId?: string | null;
  inventoryAllocation?: "attributed" | "proportional";
}

export type FeasibilitySeverity = "amber" | "red";

export interface FeasibilityWarning {
  key: string;
  severity: FeasibilitySeverity;
  message: string;
  meta?: Record<string, number | string | boolean | null | undefined>;
}

function warningCfg(
  config: SimulationConfig,
  key: string
): { enabled: boolean; severity: FeasibilitySeverity; threshold?: number } {
  const row = config.feasibilityWarnings?.[key];
  return {
    enabled: row?.enabled !== false,
    severity: row?.severity === "red" ? "red" : "amber",
    threshold: typeof row?.threshold === "number" && Number.isFinite(row.threshold) ? row.threshold : undefined
  };
}

function getCompatibleLegs(
  resource: Resource,
  legs: SchedulingLeg[],
  config: SimulationConfig
): SchedulingLeg[] {
  return legs.filter((leg) => getCompatibleResources(leg.mode, [resource], config).length > 0);
}

function totalBlackoutHours(resource: Resource, config: SimulationConfig): number {
  const startMs = config.startDate.getTime();
  const endMs = config.endDate.getTime();
  let total = 0;
  for (const b of resource.blackouts) {
    const overlapStart = Math.max(b.start.getTime(), startMs);
    const overlapEnd = Math.min(b.end.getTime(), endMs);
    if (overlapEnd > overlapStart) {
      total += (overlapEnd - overlapStart) / (60 * 60 * 1000);
    }
  }
  return total;
}

const OUTBOUND_INBOUND_CAPACITY_RATIO = 1.1;

export function runFeasibilityChecks(
  customers: Customer[],
  resources: Resource[],
  legs: SchedulingLeg[],
  config: SimulationConfig
): FeasibilityWarning[] {
  const warnings: FeasibilityWarning[] = [];

  const periodMs = config.endDate.getTime() - config.startDate.getTime();
  const simulationPeriodHours = periodMs / (60 * 60 * 1000);

  for (const customer of customers) {
    const customerMax =
      ((config.totalStorageCapacity ?? 100000) * customer.storageShare) / 100;
    const inboundMaxMeps = customerDirectionTransports(customer, "inbound").reduce(
      (mx, row) => Math.max(mx, row.meps),
      0
    );
    if (inboundMaxMeps > customerMax) {
      const w = warningCfg(config, "inbound_meps_exceeds_capacity");
      if (w.enabled) {
        warnings.push({
          key: "inbound_meps_exceeds_capacity",
          severity: w.severity,
          message:
            `Customer ${customer.name}: inbound MEPS (${inboundMaxMeps.toLocaleString()}t) ` +
            `exceeds storage capacity (${customerMax.toLocaleString()}t). ` +
            `Ships can only be scheduled when tank is near empty. ` +
            `Consider increasing storage capacity or reducing MEPS.`
        });
      }
    }
  }

  const { preOps, postOps } = laytimeFromConfig(config);
  const layPerVisit = preOps + postOps;

  for (const r of resources) {
    const compatible = getCompatibleLegs(r, legs, config);
    const totalVolumeForResource = compatible.reduce((s, leg) => s + leg.targetSlots * leg.meps, 0);
    const loadingHours = r.flowRate > 0 ? totalVolumeForResource / r.flowRate : 0;
    const minHoursNeeded =
      loadingHours +
      compatible.reduce((s, leg) => s + leg.targetSlots * layPerVisit, 0);
    const blackoutHours = totalBlackoutHours(r, config);
    const availableHours = simulationPeriodHours - blackoutHours;

    if (minHoursNeeded > availableHours) {
      const w = warningCfg(config, "resource_oversubscribed");
      if (w.enabled) {
        warnings.push({
          key: "resource_oversubscribed",
          severity: w.severity,
          message: `Resource ${r.name} is oversubscribed: needs ${minHoursNeeded.toFixed(1)}h, only ${availableHours.toFixed(1)}h available`
        });
      }
    }
  }

  // Mass balance feasibility check per customer
  const periodHours = simulationPeriodHours;
  for (const c of customers) {
    const { inboundTph, outboundTph } = resolveCustomerPipelineRates(c, config);
    const pipelineInbound = inboundTph * periodHours;
    const pipelineOutbound = outboundTph * periodHours;

    const outboundRows = customerDirectionTransports(c, "outbound");
    const outboundMeps = outboundRows.reduce((mx, row) => Math.max(mx, row.meps), 0);
    const totalInbound = pipelineInbound + c.declaredInboundThroughput;
    const totalOutbound =
      pipelineOutbound +
      (outboundMeps > 0
        ? Math.ceil(
            (pipelineInbound + c.declaredInboundThroughput - pipelineOutbound) / outboundMeps
          ) * outboundMeps
        : 0);

    if (
      totalInbound > 0 &&
      Math.abs(totalInbound - totalOutbound) / Math.max(totalInbound, 1) > 0.2
    ) {
      const w = warningCfg(config, "mass_balance_throughput_mismatch");
      if (w.enabled) {
        warnings.push({
          key: "mass_balance_throughput_mismatch",
          severity: w.severity,
          message: `Customer ${c.name}: inbound (${totalInbound.toFixed(0)}t) and outbound (${totalOutbound.toFixed(0)}t) throughput differ by more than 20%`
        });
      }
    }
  }

  const totalStorageShare = customers.reduce((s, c) => s + c.storageShare, 0);
  const storageMode = config.storageMode ?? "fixed_band";
  const isIndividualMode = storageMode === "fixed_band" || storageMode === "time_shared_storage";
  const storageShareThreshold = warningCfg(config, "storage_shares_sum").threshold ?? 0.2;
  if (isIndividualMode && Math.abs(totalStorageShare - 100) > storageShareThreshold) {
    const w = warningCfg(config, "storage_shares_sum");
    if (w.enabled) {
      warnings.push({
        key: "storage_shares_sum",
        severity: w.severity,
        message: `Storage shares sum to ${totalStorageShare.toFixed(1)}%, expected 100%`
      });
    }
  }

  for (const customer of customers) {
    if (customer.inboundRoundtripHours > 0 && customer.inboundMEPS > 0) {
      const maxSlots = Math.floor(periodHours / customer.inboundRoundtripHours);
      const targetSlots = Math.ceil(customer.declaredInboundThroughput / customer.inboundMEPS);

      if (maxSlots < targetSlots) {
        const achievableVolume = maxSlots * customer.inboundMEPS;
        const w = warningCfg(config, "inbound_roundtrip_limits_throughput");
        if (w.enabled) {
          warnings.push({
            key: "inbound_roundtrip_limits_throughput",
            severity: w.severity,
            message:
              `Customer ${customer.name}: inbound roundtrip of ${customer.inboundRoundtripHours}h ` +
              `limits to ${maxSlots} slots (${achievableVolume.toLocaleString()}t) — ` +
              `throughput target of ${customer.declaredInboundThroughput.toLocaleString()}t not achievable. ` +
              `Reduce roundtrip time or MEPS to close the gap.`
          });
        }
      }
    }

    if (customer.outboundRoundtripHours > 0 && customer.outboundMEPS > 0) {
      const outboundThroughput = outboundThroughputTonnes(customer, config, periodHours);

      if (outboundThroughput > 0) {
        const maxSlots = Math.floor(periodHours / customer.outboundRoundtripHours);
        const targetSlots = Math.ceil(outboundThroughput / customer.outboundMEPS);

        if (maxSlots < targetSlots) {
          const achievableVolume = maxSlots * customer.outboundMEPS;
          const w = warningCfg(config, "outbound_roundtrip_limits_throughput");
          if (w.enabled) {
            warnings.push({
              key: "outbound_roundtrip_limits_throughput",
              severity: w.severity,
              message:
                `Customer ${customer.name}: outbound roundtrip of ${customer.outboundRoundtripHours}h ` +
                `limits to ${maxSlots} slots (${achievableVolume.toLocaleString()}t).`
            });
          }
        }
      }
    }
  }

  for (const c of customers) {
    const inbound = inboundThroughputTonnes(c, config, periodHours);
    if (inbound <= 0) continue;

    const outboundRows = customerDirectionTransports(c, "outbound");
    const hasRoundtripOutbound = outboundRows.some(
      (r) => r.meps > 0 && (r.roundtripHours ?? 0) > 0
    );
    if (!hasRoundtripOutbound) continue;

    const outboundCap = outboundRoundtripCapacityTonnes(c, periodHours);
    if (outboundCap < OUTBOUND_INBOUND_CAPACITY_RATIO * inbound) {
      const ratioPct = ((outboundCap / inbound) * 100).toFixed(0);
      const w = warningCfg(config, "outbound_capacity_below_inbound");
      if (w.enabled) {
        warnings.push({
          key: "outbound_capacity_below_inbound",
          severity: w.severity,
          message:
            `Customer ${c.name}: outbound loading/unloading capacity (${outboundCap.toLocaleString()}t from period ÷ roundtrip × MEPS) ` +
            `is less than 110% of inbound throughput (${inbound.toLocaleString()}t, ${ratioPct}%). ` +
            `Increase outbound MEPS, shorten roundtrip, or reduce inbound.`
        });
      }
    }
  }

  const berthMode = reservationMode(config);
  if (berthMode !== "none") {
    const modeLabel = berthMode === "laycan" ? "Laycan" : "Window of arrival";
    for (const leg of legs) {
      const w = leg.reservationWindowHours ?? 0;
      const label = leg.laneLabel ?? `${leg.mode} ${(leg.laneIndex ?? 0) + 1}`;
      if (w <= 0) {
        const ww = warningCfg(config, "reservation_window_missing");
        if (ww.enabled) {
          warnings.push({
            key: "reservation_window_missing",
            severity: ww.severity,
            message: `${leg.customer.name} ${leg.direction} ${label}: ${modeLabel} enabled but window (h) is not set on this leg.`
          });
        }
        continue;
      }
      if (berthMode === "laycan") {
        const compatible = getCompatibleResources(leg.mode, resources, config);
        const maxFlow = compatible.reduce((mx, r) => Math.max(mx, r.flowRate), 0);
        const minOpHours =
          maxFlow > 0 ? layPerVisit + leg.meps / maxFlow : layPerVisit;
        if (w + 0.01 < minOpHours) {
          const ww = warningCfg(config, "laycan_window_shorter_than_operation");
          if (ww.enabled) {
            warnings.push({
              key: "laycan_window_shorter_than_operation",
              severity: ww.severity,
              message: `${leg.customer.name} ${leg.direction} ${label}: laycan window (${w}h) is shorter than minimum operation (${minOpHours.toFixed(1)}h).`
            });
          }
        }
      }
    }
  }

  return warnings;
}
