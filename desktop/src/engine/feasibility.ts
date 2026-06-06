/**
 * Feasibility checks – run before scheduling. Returns warnings, not hard errors.
 */

import type { Customer, Resource, SimulationConfig } from "../types";
import { laytimeFromConfig } from "./slotLaytime";
import { customerDirectionTransports } from "./customerTransports";

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
    const rate = c.pipelineFlowPerHour ?? 0;
    const pipelineInbound =
      config.pipelineDirection === "inbound" ? rate * periodHours : 0;
    const pipelineOutbound =
      config.pipelineDirection === "outbound" ? rate * periodHours : 0;

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

  // Check if outbound slots are physically achievable within the period
  for (const c of customers) {
    const pipelineRatePerHour = c.pipelineFlowPerHour ?? 0;
    const pipelineInbound =
      config.pipelineDirection === "inbound" ? pipelineRatePerHour * periodHours : 0;
    const pipelineOutbound =
      config.pipelineDirection === "outbound" ? pipelineRatePerHour * periodHours : 0;

    const outboundThroughput =
      pipelineInbound + c.declaredInboundThroughput - pipelineOutbound;
    const outboundRows = customerDirectionTransports(c, "outbound");
    const outboundMeps = outboundRows.reduce((mx, row) => Math.max(mx, row.meps), 0);

    if (outboundThroughput > 0 && outboundMeps > 0 && pipelineRatePerHour > 0) {
      const numSlots = Math.ceil(outboundThroughput / outboundMeps);
      const hoursToFillOneMEPS = outboundMeps / pipelineRatePerHour;
      const totalHoursNeeded = numSlots * hoursToFillOneMEPS;

      if (totalHoursNeeded > periodHours) {
        const achievableSlots = Math.floor(periodHours / hoursToFillOneMEPS);
        warnings.push(
          `Customer ${c.name}: ${numSlots} outbound slots calculated but only ` +
            `${achievableSlots} can physically fit in the simulation period. ` +
            `Consider increasing MEPS to ${Math.ceil(
              outboundThroughput / Math.max(achievableSlots, 1)
            ).toLocaleString()}t ` +
            `or extending the simulation period.`
        );
      }
    }
  }

  // Days-of-cover: pipeline rate as throughput
  for (const c of customers) {
    const dailyPipelineRate = (c.pipelineFlowPerHour ?? 0) * 24;

    if (config.pipelineDirection === "inbound" && dailyPipelineRate > 0) {
      const customerMax = (config.totalStorageCapacity * c.storageShare) / 100;
      const daysUntilFull = (customerMax - c.currentInventory) / dailyPipelineRate;
      if (daysUntilFull < 2) {
        warnings.push(
          `Customer ${c.name} starts near full capacity: ${daysUntilFull.toFixed(1)} days until full`
        );
      }
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
      const r = customer.pipelineFlowPerHour ?? 0;
      const pipelineInbound =
        config.pipelineDirection === "inbound" ? r * periodHours : 0;
      const pipelineOutbound =
        config.pipelineDirection === "outbound" ? r * periodHours : 0;
      const outboundThroughput =
        customer.declaredInboundThroughput + pipelineInbound - pipelineOutbound;

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

  return warnings;
}
