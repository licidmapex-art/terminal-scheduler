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
}

function getCompatibleLegs(resource: Resource, legs: SchedulingLeg[]): SchedulingLeg[] {
  return legs.filter((leg) => {
    if (resource.type === "berth_large") return leg.mode === "ship" || leg.mode === "barge";
    if (resource.type === "berth_small") return leg.mode === "barge";
    if (resource.type === "rail_siding") return leg.mode === "train";
    return false;
  });
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
): string[] {
  const warnings: string[] = [];

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
      warnings.push(
        `Customer ${customer.name}: inbound MEPS (${inboundMaxMeps.toLocaleString()}t) ` +
          `exceeds storage capacity (${customerMax.toLocaleString()}t). ` +
          `Ships can only be scheduled when tank is near empty. ` +
          `Consider increasing storage capacity or reducing MEPS.`
      );
    }
  }

  const { preOps, postOps } = laytimeFromConfig(config);
  const layPerVisit = preOps + postOps;

  for (const r of resources) {
    const compatible = getCompatibleLegs(r, legs);
    const totalVolumeForResource = compatible.reduce((s, leg) => s + leg.targetSlots * leg.meps, 0);
    const loadingHours = r.flowRate > 0 ? totalVolumeForResource / r.flowRate : 0;
    const minHoursNeeded =
      loadingHours +
      compatible.reduce((s, leg) => s + leg.targetSlots * layPerVisit, 0);
    const blackoutHours = totalBlackoutHours(r, config);
    const availableHours = simulationPeriodHours - blackoutHours;

    if (minHoursNeeded > availableHours) {
      warnings.push(
        `Resource ${r.name} is oversubscribed: needs ${minHoursNeeded.toFixed(1)}h, only ${availableHours.toFixed(1)}h available`
      );
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
      warnings.push(
        `Customer ${c.name}: inbound (${totalInbound.toFixed(0)}t) and outbound (${totalOutbound.toFixed(0)}t) throughput differ by more than 20%`
      );
    }
  }

  const totalStorageShare = customers.reduce((s, c) => s + c.storageShare, 0);
  if (Math.abs(totalStorageShare - 100) > 0.01) {
    warnings.push(`Storage shares sum to ${totalStorageShare.toFixed(1)}%, expected 100%`);
  }

  for (const customer of customers) {
    if (customer.inboundRoundtripHours > 0 && customer.inboundMEPS > 0) {
      const maxSlots = Math.floor(periodHours / customer.inboundRoundtripHours);
      const targetSlots = Math.ceil(customer.declaredInboundThroughput / customer.inboundMEPS);

      if (maxSlots < targetSlots) {
        const achievableVolume = maxSlots * customer.inboundMEPS;
        warnings.push(
          `Customer ${customer.name}: inbound roundtrip of ${customer.inboundRoundtripHours}h ` +
            `limits to ${maxSlots} slots (${achievableVolume.toLocaleString()}t) — ` +
            `throughput target of ${customer.declaredInboundThroughput.toLocaleString()}t not achievable. ` +
            `Reduce roundtrip time or MEPS to close the gap.`
        );
      }
    }

    if (customer.outboundRoundtripHours > 0 && customer.outboundMEPS > 0) {
      const outboundThroughput = outboundThroughputTonnes(customer, config, periodHours);

      if (outboundThroughput > 0) {
        const maxSlots = Math.floor(periodHours / customer.outboundRoundtripHours);
        const targetSlots = Math.ceil(outboundThroughput / customer.outboundMEPS);

        if (maxSlots < targetSlots) {
          const achievableVolume = maxSlots * customer.outboundMEPS;
          warnings.push(
            `Customer ${customer.name}: outbound roundtrip of ${customer.outboundRoundtripHours}h ` +
              `limits to ${maxSlots} slots (${achievableVolume.toLocaleString()}t).`
          );
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
      warnings.push(
        `Customer ${c.name}: outbound loading/unloading capacity (${outboundCap.toLocaleString()}t from period ÷ roundtrip × MEPS) ` +
          `is less than 110% of inbound throughput (${inbound.toLocaleString()}t, ${ratioPct}%). ` +
          `Increase outbound MEPS, shorten roundtrip, or reduce inbound.`
      );
    }
  }

  return warnings;
}
