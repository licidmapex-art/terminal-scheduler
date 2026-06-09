/**
 * Hour-by-hour scheduler – single forward pass, no transport requests.
 */

const randomUUID = () => globalThis.crypto.randomUUID();
import type {
  Blackout,
  Customer,
  Resource,
  ScheduledSlot,
  SimulationConfig
} from "../types";
import type { SimulationLogRow, TransportModeStatus } from "./simulationLog";
import {
  getCustomerMaxCapacity,
  normalizeSharedInventoryToCap,
  applySharedInventoryPipelineHour,
  type InventoryTimeline
} from "./inventory";
import { runFeasibilityChecks, type SchedulingLeg } from "./feasibility";
import { runPostRunFeasibilityChecks } from "./postRunFeasibility";
import {
  laytimeFromConfig,
  getCargoWindowMs,
  hourOverlapsIntervalMs,
  firstHourOverlappingCargo
} from "./slotLaytime";
import {
  customerPipelineLogFlowPerHour,
  customerPipelineNetDeltaPerHour,
  totalInboundPipelineTph,
  totalOutboundPipelineTph
} from "./pipelineFlows";
import {
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane
} from "./customerLegTargets";
import { paceAllowanceSlots } from "./pacing";
import {
  averageCustomerDaysOfCoverAtHour,
  averagePoolFulfillmentRatioAtHour,
  combinedTerminalDaysOfCoverAtHour,
  compareSchedulingLegs,
  countLegSlotsThroughHour,
  customerLegFulfillmentRatio,
  legSortMetric,
  legUsesFulfillmentPool,
  normalizedOptimizerRelativeDocMultiplier,
  normalizedOptimizerRelativeFulfillmentMultiplier,
  optimizerMetric,
  relativeFulfillmentOptimizerShouldYield,
  relativeOptimizerShouldYield
} from "./optimizer";
import { getCompatibleResources, pickBerthCandidate } from "./resourceAllocation";

const HOUR_MS = 60 * 60 * 1000;

function normalizedPacerDecile(config: SimulationConfig): number {
  const raw = Math.round(config.pacerRoundAtDecile ?? 1);
  return Number.isFinite(raw) ? Math.min(9, Math.max(1, raw)) : 1;
}

export interface ScheduleResult {
  scheduledSlots: ScheduledSlot[];
  simulationLog: SimulationLogRow[];
  inventoryTimeline: InventoryTimeline;
  feasibilityWarnings: string[];
}

interface TransportLeg {
  customer: Customer;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  meps: number;
  targetSlots: number;
  roundtripHours: number;
}

function legKey(
  customerId: string,
  direction: string,
  mode: string,
  laneKey: string | undefined
): string {
  return `${customerId}:${direction}:${mode}:${laneKey ?? "lane0"}`;
}

function getBlackoutsForResource(resource: Resource): Blackout[] {
  return resource.blackouts;
}

function findConflict(
  candidateStart: Date,
  candidateEnd: Date,
  assignedSlots: ScheduledSlot[],
  blackouts: Blackout[],
  resourceId: string,
  minIntervalHours: number
): { type: "slot" | "blackout"; end: Date } | null {
  const startMs = candidateStart.getTime();
  const endMs = candidateEnd.getTime();
  const minIntervalMs = minIntervalHours * 60 * 60 * 1000;
  for (const slot of assignedSlots) {
    if (slot.resourceId !== resourceId) continue;
    const slotStartMs = new Date(slot.start).getTime();
    const slotEndMs = new Date(slot.end).getTime() + minIntervalMs;
    if (slotStartMs < endMs && slotEndMs > startMs) {
      return { type: "slot", end: slot.end instanceof Date ? slot.end : new Date(slot.end) };
    }
  }
  for (const b of blackouts) {
    const bStartMs = new Date(b.start).getTime();
    const bEndMs = new Date(b.end).getTime();
    if (bStartMs < endMs && bEndMs > startMs) {
      return { type: "blackout", end: b.end instanceof Date ? b.end : new Date(b.end) };
    }
  }
  return null;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

function deriveLegs(
  customers: Customer[],
  config: SimulationConfig,
  periodHours: number
): SchedulingLeg[] {
  const legs: SchedulingLeg[] = [];
  for (const customer of customers) {
    const inTargets = inboundTargetSlotsByLane(customer, periodHours);
    for (const t of inTargets) {
      if (t.targetSlots <= 0) continue;
      legs.push({
        customer,
        direction: "inbound",
        mode: t.mode,
        laneIndex: t.laneIndex,
        laneKey: `inbound-${t.mode}-${t.laneIndex + 1}`,
        laneLabel: `${t.mode} ${t.laneIndex + 1}`,
        meps: t.meps,
        targetSlots: t.targetSlots,
        roundtripHours: t.roundtripHours ?? 0
      });
    }
    const outTargets = outboundTargetSlotsByLane(customer, config, periodHours);
    for (const t of outTargets) {
      if (t.targetSlots <= 0) continue;
      legs.push({
        customer,
        direction: "outbound",
        mode: t.mode,
        laneIndex: t.laneIndex,
        laneKey: `outbound-${t.mode}-${t.laneIndex + 1}`,
        laneLabel: `${t.mode} ${t.laneIndex + 1}`,
        meps: t.meps,
        targetSlots: t.targetSlots,
        roundtripHours: t.roundtripHours ?? 0
      });
    }
  }
  return legs;
}

function slotHourIndices(
  slot: ScheduledSlot,
  simStartMs: number
): { start: number; end: number } {
  const start = Math.round((new Date(slot.start).getTime() - simStartMs) / HOUR_MS);
  const end = Math.round((new Date(slot.end).getTime() - simStartMs) / HOUR_MS);
  return { start, end };
}

function overlapsHour(slot: ScheduledSlot, h: number, simStartMs: number): boolean {
  const { start, end } = slotHourIndices(slot, simStartMs);
  if (end <= start) return false;
  return h >= start && h < end;
}

function shareFrac(customer: Customer, allCustomers: Customer[]): number {
  const totalStorageShare = allCustomers.reduce((s, c) => s + c.storageShare, 0) || 100;
  return totalStorageShare > 0 ? customer.storageShare / totalStorageShare : 1 / allCustomers.length;
}

function custInvCommingled(terminal: number, customer: Customer, allCustomers: Customer[]): number {
  return terminal * shareFrac(customer, allCustomers);
}

function sumCustomerInventory(invById: Record<string, number>, customers: Customer[]): number {
  return customers.reduce((s, c) => s + (invById[c.id] ?? 0), 0);
}

function applyPipelineFixedBand(
  h: number,
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>
): Record<string, number> | undefined {
  if (h <= 0) return undefined;
  if (config.storageMode === "shared_inventory") {
    return applySharedInventoryPipelineHour(invById, customers, config);
  }
  for (const c of customers) {
    invById[c.id] = (invById[c.id] ?? 0) + customerPipelineNetDeltaPerHour(c, config);
  }
  return undefined;
}

function applySlotFlowsFixedBand(
  h: number,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>
): void {
  const { preOps, postOps } = laytimeFromConfig(config);
  for (const slot of assignedSlots) {
    const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
    if (loadingHours <= 0) continue;
    if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
    const flowPerHour = slot.volume / loadingHours;
    const sign = slot.direction === "inbound" ? 1 : -1;
    invById[slot.customerId] = (invById[slot.customerId] ?? 0) + sign * flowPerHour;
  }
  const totalCap = config.totalStorageCapacity ?? 100000;
  if (config.storageMode === "shared_inventory") {
    normalizeSharedInventoryToCap(invById, customers, totalCap);
    return;
  }
  for (const c of customers) {
    const mx = getCustomerMaxCapacity(c, config);
    invById[c.id] = Math.max(0, Math.min(mx, invById[c.id] ?? 0));
  }
}

function applyPipelineCommingled(
  h: number,
  customers: Customer[],
  config: SimulationConfig,
  terminalRef: { t: number }
): void {
  if (h <= 0) return;
  const cap = config.totalStorageCapacity ?? 100000;
  const inboundTotal = totalInboundPipelineTph(customers, config);
  const outboundTotal = totalOutboundPipelineTph(customers, config);
  terminalRef.t += inboundTotal - outboundTotal;
  terminalRef.t = Math.max(0, Math.min(cap, terminalRef.t));
}

function applySlotFlowsCommingled(
  h: number,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  config: SimulationConfig,
  terminalRef: { t: number }
): void {
  const cap = config.totalStorageCapacity ?? 100000;
  const { preOps, postOps } = laytimeFromConfig(config);
  for (const slot of assignedSlots) {
    const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
    if (loadingHours <= 0) continue;
    if (!hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)) continue;
    const flowPerHour = slot.volume / loadingHours;
    const sign = slot.direction === "inbound" ? 1 : -1;
    terminalRef.t += sign * flowPerHour;
  }
  terminalRef.t = Math.max(0, Math.min(cap, terminalRef.t));
}

function pipelineFlowRecord(customers: Customer[], config: SimulationConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of customers) {
    out[c.id] = customerPipelineLogFlowPerHour(c, config);
  }
  return out;
}

function loadsStartedByHour(
  h: number,
  key: string,
  assignedSlots: ScheduledSlot[],
  simStartMs: number
): number {
  if (h < 0) return 0;
  const [customerId, direction, mode, lane] = key.split(":");
  return assignedSlots.filter((s) => {
    if (s.customerId !== customerId || s.direction !== direction || s.mode !== mode) return false;
    if ((s.legKey ?? "lane0") !== (lane ?? "lane0")) return false;
    const { start } = slotHourIndices(s, simStartMs);
    return start <= h;
        }).length;
}

function loadsStartedByHourAgg(
  h: number,
  direction: string,
  mode: string,
  assignedSlots: ScheduledSlot[],
  simStartMs: number
): number {
  if (h < 0) return 0;
  return assignedSlots.filter((s) => {
    if (s.direction !== direction || s.mode !== mode) return false;
    const { start } = slotHourIndices(s, simStartMs);
    return start <= h;
  }).length;
}

/** Pooled pace across customers: all legs in shared_shipping; inbound only in shared_inventory. */
function legUsesAggregatedPace(
  leg: Pick<SchedulingLeg, "direction">,
  sharedShipping: boolean,
  sharedInventory: boolean
): boolean {
  if (sharedShipping) return true;
  return sharedInventory && leg.direction === "inbound";
}

function buildDirectionModeAggTargetMap(
  legs: SchedulingLeg[],
  sharedShipping: boolean,
  sharedInventory: boolean
): Map<string, number> {
  const map = new Map<string, number>();
  for (const leg of legs) {
    if (!legUsesAggregatedPace(leg, sharedShipping, sharedInventory)) continue;
    const dk = `${leg.direction}:${leg.mode}`;
    map.set(dk, (map.get(dk) ?? 0) + leg.targetSlots);
  }
  return map;
}

function usesPerCustomerPoolCap(
  leg: SchedulingLeg,
  sharedShipping: boolean,
  sharedInventory: boolean
): boolean {
  return sharedShipping || (sharedInventory && leg.direction === "inbound");
}

function lastCompletedEndHour(
  key: string,
  h: number,
  assignedSlots: ScheduledSlot[],
  simStartMs: number
): number | null {
  const [customerId, direction, mode, lane] = key.split(":");
  let bestEndMs: number | null = null;
  for (const s of assignedSlots) {
    if (s.customerId !== customerId || s.direction !== direction || s.mode !== mode) continue;
    if ((s.legKey ?? "lane0") !== (lane ?? "lane0")) continue;
    const endMs = new Date(s.end).getTime();
    if (endMs <= simStartMs + h * HOUR_MS) {
      if (bestEndMs === null || endMs > bestEndMs) bestEndMs = endMs;
    }
  }
  if (bestEndMs === null) return null;
  return Math.round((bestEndMs - simStartMs) / HOUR_MS);
}

function buildTransportStatuses(
  h: number,
  legs: SchedulingLeg[],
  assignedSlots: ScheduledSlot[],
  resources: Resource[],
  config: SimulationConfig,
  customers: Customer[],
  invById: Record<string, number>,
  terminalRef: { t: number },
  periodHours: number,
  simStartMs: number,
  simEndMs: number,
  minInterval: number,
  /** State after pipeline + overlapping-slot flows for this hour, before any new slot is assigned — must match runScheduler's inventory checks for this hour. */
  invBeforeNewSlotsThisHour: Record<string, number>,
  terminalBeforeNewSlotsThisHour: number
): TransportModeStatus[] {
  const candidateStart = new Date(simStartMs + h * HOUR_MS);
  const { preOps, postOps } = laytimeFromConfig(config);
  const periodHoursSafe = Math.max(periodHours, 1);
  const mode = config.storageMode;
  const sharedShipping = mode === "shared_shipping";
  const sharedInventory = mode === "shared_inventory";
  const out: TransportModeStatus[] = [];
  const aggTargetMap = buildDirectionModeAggTargetMap(legs, sharedShipping, sharedInventory);

  const optimizerMultiplier = normalizedOptimizerRelativeDocMultiplier(config);
  const fulfillmentOptimizerMultiplier = normalizedOptimizerRelativeFulfillmentMultiplier(config);
  const averageDoc = averageCustomerDaysOfCoverAtHour(
    customers,
    legs,
    config,
    periodHoursSafe,
    invBeforeNewSlotsThisHour,
    terminalBeforeNewSlotsThisHour,
    sharedShipping
  );
  const avgFulfillmentByPool = new Map<string, number | null>();

  for (const leg of legs) {
    const c = leg.customer;
    const key = legKey(c.id, leg.direction, leg.mode, leg.laneKey);
    const customerMax = getCustomerMaxCapacity(c, config);

    const invForDoc = sharedShipping
      ? terminalBeforeNewSlotsThisHour
      : (invBeforeNewSlotsThisHour[c.id] ?? 0);
    const rawMetric = legSortMetric(
      leg,
      invForDoc,
      customerMax,
      config,
      periodHoursSafe,
      sharedShipping,
      c,
      customers,
      legs
    );
    const daysOfCoverSnapshot = Number.isFinite(rawMetric) ? Math.round(rawMetric * 1000) / 1000 : null;
    const optimizerTerminalInventory = sharedInventory
      ? sumCustomerInventory(invBeforeNewSlotsThisHour, customers)
      : terminalBeforeNewSlotsThisHour;
    const optimizerRawMetric = optimizerMetric(
      leg,
      c,
      config,
      periodHoursSafe,
      legs,
      invBeforeNewSlotsThisHour[c.id] ?? 0,
      optimizerTerminalInventory,
      customers
    );
    const optimizerMetricSnapshot = Number.isFinite(optimizerRawMetric)
      ? Math.round(optimizerRawMetric * 1000) / 1000
      : null;
    const activeSlot = assignedSlots.find((s) => {
      if (
        s.customerId !== c.id ||
        s.direction !== leg.direction ||
        s.mode !== leg.mode ||
        (s.legKey ?? "lane0") !== (leg.laneKey ?? "lane0")
      )
        return false;
      return overlapsHour(s, h, simStartMs);
    });

    if (activeSlot) {
      const resource = resources.find((r) => r.id === activeSlot.resourceId);
      const occStartMs = new Date(activeSlot.start).getTime();
      const occEndMs = new Date(activeSlot.end).getTime();
      const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(activeSlot, preOps, postOps);
      const hourPre =
        cargoStartMs > occStartMs && hourOverlapsIntervalMs(h, simStartMs, occStartMs, cargoStartMs);
      const hourPost =
        cargoEndMs < occEndMs && hourOverlapsIntervalMs(h, simStartMs, cargoEndMs, occEndMs);
      const hourCargo =
        loadingHours > 0 && hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs);

      let action: TransportModeStatus["action"];
      let detail: string | null = null;
      if (hourPre) {
        action = "pre_ops";
        detail = "Pre-ops";
      } else if (hourPost) {
        action = "post_ops";
        detail = "Post-ops";
      } else if (hourCargo) {
        const firstCH = firstHourOverlappingCargo(simStartMs, cargoStartMs, cargoEndMs, periodHours);
        action = firstCH !== null && h === firstCH ? "loaded" : "loading_in_progress";
      } else {
        action = "loading_in_progress";
      }

      out.push({
        customerName: c.name,
        customerId: c.id,
        direction: leg.direction,
        mode: leg.mode,
        legKey: leg.laneKey,
        legLabel: leg.laneLabel,
        action,
        blockingConstraint: null,
        constraintDetail: detail,
        daysOfCover: daysOfCoverSnapshot,
        optimizerDaysOfCover: optimizerMetricSnapshot,
        slotId: activeSlot.id,
        volume: activeSlot.volume,
        resourceName: resource?.name
      });
      continue;
    }

    let blockingConstraint: TransportModeStatus["blockingConstraint"] = null;
    let constraintDetail: string | null = null;

    const nCustomerLeg = loadsStartedByHour(h, key, assignedSlots, simStartMs);
    if (
      usesPerCustomerPoolCap(leg, sharedShipping, sharedInventory) &&
      nCustomerLeg >= leg.targetSlots
    ) {
      blockingConstraint = "annual_target_met";
      constraintDetail = `annual target reached — ${nCustomerLeg}/${leg.targetSlots} slots (${(leg.targetSlots * leg.meps).toLocaleString()}t)`;
    }

    if (!blockingConstraint) {
      const dk = `${leg.direction}:${leg.mode}`;
      const poolPace = legUsesAggregatedPace(leg, sharedShipping, sharedInventory);
      const effTarget = poolPace ? (aggTargetMap.get(dk) ?? leg.targetSlots) : leg.targetSlots;
      const nBefore = poolPace
        ? loadsStartedByHourAgg(h - 1, leg.direction, leg.mode, assignedSlots, simStartMs)
        : loadsStartedByHour(h - 1, key, assignedSlots, simStartMs);
      const paceTargetContinuous = (h / periodHoursSafe) * effTarget + 1;
      const paceAllowance = paceAllowanceSlots(paceTargetContinuous, config);
      if (nBefore >= effTarget || nBefore >= paceAllowance) {
        blockingConstraint = "pace_ahead";
        const paceMode = config.pacerRoundingDirection === "down" ? "down" : "up";
        const paceDecile = normalizedPacerDecile(config);
        constraintDetail = poolPace
          ? `scheduled ${nBefore}/${effTarget} (combined), pace ${paceTargetContinuous.toFixed(2)} → allow ${paceAllowance} (${paceMode}@0.${paceDecile})`
          : `scheduled ${nBefore}/${effTarget}, pace ${paceTargetContinuous.toFixed(2)} → allow ${paceAllowance} (${paceMode}@0.${paceDecile})`;
      }
    }

    if (
      !blockingConstraint &&
      fulfillmentOptimizerMultiplier > 0 &&
      legUsesFulfillmentPool(leg, sharedShipping, sharedInventory)
    ) {
      const poolKey = `${leg.direction}:${leg.mode}`;
      let avgFulfillment = avgFulfillmentByPool.get(poolKey);
      if (avgFulfillment === undefined) {
        avgFulfillment = averagePoolFulfillmentRatioAtHour(
          leg,
          legs,
          assignedSlots,
          simStartMs,
          h,
          sharedShipping,
          sharedInventory
        );
        avgFulfillmentByPool.set(poolKey, avgFulfillment);
      }
      const slotsThrough = countLegSlotsThroughHour(leg, assignedSlots, simStartMs, h - 1);
      const legFulfillment = customerLegFulfillmentRatio(leg, slotsThrough);
      if (relativeFulfillmentOptimizerShouldYield(legFulfillment, avgFulfillment, fulfillmentOptimizerMultiplier)) {
        blockingConstraint = "optimizer_fulfillment";
        const avgPct = avgFulfillment != null ? (avgFulfillment * 100).toFixed(1) : "—";
        constraintDetail = `fulfilment ${(legFulfillment * 100).toFixed(1)}% > ${fulfillmentOptimizerMultiplier}× pool avg ${avgPct}% — yields slot to other customers`;
      }
    }

    if (
      !blockingConstraint &&
      optimizerMetricSnapshot !== null &&
      relativeOptimizerShouldYield(optimizerMetricSnapshot, averageDoc, optimizerMultiplier)
    ) {
      blockingConstraint = "optimizer_days_of_cover";
      const avgLabel = averageDoc != null ? averageDoc.toFixed(2) : "—";
      constraintDetail = `optimizer DoC ${optimizerMetricSnapshot.toFixed(2)} > ${optimizerMultiplier}× avg ${avgLabel} — yields slot to other customers`;
    }

    const lastEnd = lastCompletedEndHour(key, h, assignedSlots, simStartMs);
    if (!blockingConstraint && lastEnd !== null && leg.roundtripHours > 0) {
      if (h < lastEnd + leg.roundtripHours) {
        blockingConstraint = "roundtrip";
        const availableAt = new Date(simStartMs + (lastEnd + leg.roundtripHours) * HOUR_MS);
        constraintDetail = `vessel available at ${availableAt.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        })}`;
      }
    }

    if (!blockingConstraint) {
      const invSched = sharedShipping
        ? custInvCommingled(terminalBeforeNewSlotsThisHour, c, customers)
        : (invBeforeNewSlotsThisHour[c.id] ?? 0);
      const terminalForPoolSched = sharedInventory
        ? sumCustomerInventory(invBeforeNewSlotsThisHour, customers)
        : terminalBeforeNewSlotsThisHour;

      if (leg.direction === "outbound") {
        if (sharedShipping || sharedInventory) {
          if (terminalForPoolSched < leg.meps) {
            blockingConstraint = "insufficient_inventory";
            constraintDetail = `need ${leg.meps.toLocaleString()}t, have ${terminalForPoolSched.toFixed(0)}t (${c.name}: ${sharedInventory ? "pooled sum of attributed stock" : "terminal total"} for outbound check)`;
          } else if (
            sharedInventory &&
            (config.sharedInventoryCustomerDeficitLimitTonnes ?? 0) > 0 &&
            invSched - leg.meps < -(config.sharedInventoryCustomerDeficitLimitTonnes ?? 0)
          ) {
            const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
            blockingConstraint = "customer_inventory_floor";
            const after = invSched - leg.meps;
            constraintDetail = `floor −${x.toLocaleString()}t — booking balance would be ${after.toFixed(0)}t`;
          }
        } else if (invSched < leg.meps) {
          blockingConstraint = "insufficient_inventory";
          constraintDetail = `need ${leg.meps.toLocaleString()}t, have ${invSched.toFixed(0)}t (${c.name} attributed — fixed band, not terminal total)`;
        }
      } else {
        if (sharedShipping || sharedInventory) {
          const cap = config.totalStorageCapacity ?? 100000;
          if (terminalForPoolSched + leg.meps > cap) {
            blockingConstraint = "tank_full";
            constraintDetail = `need ${leg.meps.toLocaleString()}t space, have ${(cap - terminalForPoolSched).toFixed(0)}t`;
          }
        } else if (invSched + leg.meps > customerMax) {
          blockingConstraint = "tank_full";
          constraintDetail = `need ${leg.meps.toLocaleString()}t space, have ${(customerMax - invSched).toFixed(0)}t`;
        }
      }
    }

    if (!blockingConstraint) {
      const compatible = getCompatibleResources(leg.mode, resources, config);
      if (compatible.length === 0) {
        blockingConstraint = "resource_occupied";
        constraintDetail = `No ${leg.mode} resource configured (${leg.direction}) — add a compatible berth or rail siding (Resources)`;
      } else {
        let hasFeasible = false;
        for (const res of compatible) {
          if (res.flowRate <= 0) continue;
          const loadingHours = leg.meps / res.flowRate;
          const end = addHours(candidateStart, preOps + loadingHours + postOps);
          if (end.getTime() > simEndMs) continue;
          const blackouts = getBlackoutsForResource(res);
          const conflict = findConflict(
            candidateStart,
            end,
            assignedSlots,
            blackouts,
            res.id,
            minInterval
          );
          if (!conflict) {
            hasFeasible = true;
            break;
          }
        }
        if (!hasFeasible) {
          blockingConstraint = "resource_occupied";
          constraintDetail = `all ${compatible.length} compatible berths busy or blocked`;
        }
      }
    }

    if (!blockingConstraint) {
      const invNow = sharedShipping ? custInvCommingled(terminalRef.t, c, customers) : (invById[c.id] ?? 0);
      constraintDetail = `inv=${invNow.toFixed(0)}t, need=${leg.meps.toLocaleString()}t, pace=ok, resource=free`;
    }

    out.push({
      customerName: c.name,
      customerId: c.id,
      direction: leg.direction,
      mode: leg.mode,
      legKey: leg.laneKey,
      legLabel: leg.laneLabel,
      action: "idle",
      blockingConstraint,
      constraintDetail,
      daysOfCover: daysOfCoverSnapshot,
      optimizerDaysOfCover: optimizerMetricSnapshot
    });
  }

  return out;
}

export function runScheduler(
  customers: Customer[],
  resources: Resource[],
  config: SimulationConfig
): ScheduleResult {
  const simStart = new Date(config.startDate);
  const simEnd = new Date(config.endDate);
  const simStartMs = simStart.getTime();
  const periodHours = Math.floor((simEnd.getTime() - simStartMs) / HOUR_MS);
  const periodHoursSafe = Math.max(periodHours, 1);
  const minInterval = config.minSlotIntervalHours ?? 0;
  const optimizerMultiplier = normalizedOptimizerRelativeDocMultiplier(config);
  const fulfillmentOptimizerMultiplier = normalizedOptimizerRelativeFulfillmentMultiplier(config);
  const { preOps, postOps } = laytimeFromConfig(config);
  const mode = config.storageMode;
  const sharedShipping = mode === "shared_shipping";
  const sharedInventory = mode === "shared_inventory";
  const poolProportional = sharedShipping;

  const legs = deriveLegs(customers, config, periodHoursSafe);
  const aggTargetMap = buildDirectionModeAggTargetMap(legs, sharedShipping, sharedInventory);
  const feasibilityWarnings = runFeasibilityChecks(customers, resources, legs, config);

  const assignedSlots: ScheduledSlot[] = [];
  const invById: Record<string, number> = {};
  for (const c of customers) {
    invById[c.id] = c.currentInventory;
  }
  const terminalRef = {
    t: customers.reduce((s, c) => s + c.currentInventory, 0)
  };

  const simulationLog: SimulationLogRow[] = [];
  const pipelineFlow = pipelineFlowRecord(customers, config);
  const invTimeline: Record<string, number[]> = {};
  for (const c of customers) invTimeline[c.id] = [];

  for (let h = 0; h <= periodHours; h++) {
    let hourPipelineForLog: Record<string, number> = pipelineFlow;
    if (sharedShipping) {
      applyPipelineCommingled(h, customers, config, terminalRef);
      applySlotFlowsCommingled(h, assignedSlots, simStartMs, config, terminalRef);
    } else {
      const eff = applyPipelineFixedBand(h, customers, config, invById);
      if (eff) hourPipelineForLog = eff;
      applySlotFlowsFixedBand(h, assignedSlots, simStartMs, customers, config, invById);
    }

    const ordered = [...legs].sort((a, b) => {
      const invA = poolProportional
        ? custInvCommingled(terminalRef.t, a.customer, customers)
        : (invById[a.customer.id] ?? 0);
      const invB = poolProportional
        ? custInvCommingled(terminalRef.t, b.customer, customers)
        : (invById[b.customer.id] ?? 0);
      const maxA = getCustomerMaxCapacity(a.customer, config);
      const maxB = getCustomerMaxCapacity(b.customer, config);
      const mA = legSortMetric(
        a,
        poolProportional ? terminalRef.t : invA,
        maxA,
        config,
        periodHoursSafe,
        poolProportional,
        a.customer,
        customers,
        legs
      );
      const mB = legSortMetric(
        b,
        poolProportional ? terminalRef.t : invB,
        maxB,
        config,
        periodHoursSafe,
        poolProportional,
        b.customer,
        customers,
        legs
      );
      const slotsA = countLegSlotsThroughHour(a, assignedSlots, simStartMs, h);
      const slotsB = countLegSlotsThroughHour(b, assignedSlots, simStartMs, h);
      return compareSchedulingLegs(a, b, mA, mB, sharedShipping, slotsA, slotsB, sharedInventory);
    });

    const candidateStartBase = new Date(simStartMs + h * HOUR_MS);

    const invBeforeNewSlotsThisHour: Record<string, number> = { ...invById };
    const terminalBeforeNewSlotsThisHour = terminalRef.t;
    const averageDoc = averageCustomerDaysOfCoverAtHour(
      customers,
      legs,
      config,
      periodHoursSafe,
      invBeforeNewSlotsThisHour,
      terminalBeforeNewSlotsThisHour,
      sharedShipping
    );
    const combinedDoc = combinedTerminalDaysOfCoverAtHour(
      customers,
      legs,
      config,
      periodHoursSafe,
      invBeforeNewSlotsThisHour,
      terminalBeforeNewSlotsThisHour,
      sharedShipping
    );
    const avgFulfillmentByPoolHour = new Map<string, number | null>();

    for (const leg of ordered) {
      const key = legKey(leg.customer.id, leg.direction, leg.mode, leg.laneKey);
      if (
        loadsStartedByHour(h, key, assignedSlots, simStartMs) >
        loadsStartedByHour(h - 1, key, assignedSlots, simStartMs)
      ) {
        continue;
      }

      const dk = `${leg.direction}:${leg.mode}`;
      const poolPace = legUsesAggregatedPace(leg, sharedShipping, sharedInventory);
      const effTarget = poolPace ? (aggTargetMap.get(dk) ?? leg.targetSlots) : leg.targetSlots;
      const nCustomerLeg = loadsStartedByHour(h, key, assignedSlots, simStartMs);
      if (usesPerCustomerPoolCap(leg, sharedShipping, sharedInventory) && nCustomerLeg >= leg.targetSlots) {
        continue;
      }
      const nBeforeThisHour = poolPace
        ? loadsStartedByHourAgg(h - 1, leg.direction, leg.mode, assignedSlots, simStartMs)
        : loadsStartedByHour(h - 1, key, assignedSlots, simStartMs);
      // Hard cap: never schedule more slots than the computed target (per leg, or combined for shared_shipping).
      if (nBeforeThisHour >= effTarget) continue;
      const paceTargetContinuous = (h / periodHoursSafe) * effTarget + 1;
      const paceAllowance = paceAllowanceSlots(paceTargetContinuous, config);
      if (nBeforeThisHour >= paceAllowance) continue;

      const c = leg.customer;
      const inv = poolProportional ? custInvCommingled(terminalRef.t, c, customers) : (invById[c.id] ?? 0);
      const customerMax = getCustomerMaxCapacity(c, config);
      const terminalInventoryForOptimizer =
        mode === "shared_inventory" ? sumCustomerInventory(invById, customers) : terminalRef.t;
      if (
        fulfillmentOptimizerMultiplier > 0 &&
        legUsesFulfillmentPool(leg, sharedShipping, sharedInventory)
      ) {
        let avgFulfillment = avgFulfillmentByPoolHour.get(dk);
        if (avgFulfillment === undefined) {
          avgFulfillment = averagePoolFulfillmentRatioAtHour(
            leg,
            legs,
            assignedSlots,
            simStartMs,
            h,
            sharedShipping,
            sharedInventory
          );
          avgFulfillmentByPoolHour.set(dk, avgFulfillment);
        }
        const slotsThrough = countLegSlotsThroughHour(leg, assignedSlots, simStartMs, h - 1);
        const legFulfillment = customerLegFulfillmentRatio(leg, slotsThrough);
        if (
          relativeFulfillmentOptimizerShouldYield(
            legFulfillment,
            avgFulfillment,
            fulfillmentOptimizerMultiplier
          )
        ) {
          continue;
        }
      }
      if (optimizerMultiplier > 0) {
        const metric = optimizerMetric(
          leg,
          c,
          config,
          periodHoursSafe,
          legs,
          invById[c.id] ?? 0,
          terminalInventoryForOptimizer,
          customers
        );
        if (relativeOptimizerShouldYield(metric, averageDoc, optimizerMultiplier)) continue;
      }

      const lastEnd = lastCompletedEndHour(key, h, assignedSlots, simStartMs);
      if (lastEnd !== null && leg.roundtripHours > 0 && h < lastEnd + leg.roundtripHours) {
        continue;
      }

      const terminalSumInv = sumCustomerInventory(invById, customers);
      if (leg.direction === "outbound") {
        if (sharedShipping || mode === "shared_inventory") {
          const t = mode === "shared_inventory" ? terminalSumInv : terminalRef.t;
          if (t < leg.meps) continue;
          const invC = invById[c.id] ?? 0;
          const x = config.sharedInventoryCustomerDeficitLimitTonnes ?? 0;
          if (mode === "shared_inventory" && x > 0 && invC - leg.meps < -x) continue;
        } else if (inv < leg.meps) continue;
      } else {
        if (sharedShipping || mode === "shared_inventory") {
          const cap = config.totalStorageCapacity ?? 100000;
          const t = mode === "shared_inventory" ? terminalSumInv : terminalRef.t;
          if (t + leg.meps > cap) continue;
        } else if (inv + leg.meps > customerMax) continue;
      }

      const compatible = getCompatibleResources(leg.mode, resources, config);
      const feasible: { resource: Resource; start: Date; end: Date }[] = [];

      for (const resource of compatible) {
        if (resource.flowRate <= 0) continue;
        const loadingHours = leg.meps / resource.flowRate;
        const start = candidateStartBase;
        const end = addHours(start, preOps + loadingHours + postOps);
        if (end.getTime() > simEnd.getTime()) continue;
        const blackouts = getBlackoutsForResource(resource);
        const conflict = findConflict(start, end, assignedSlots, blackouts, resource.id, minInterval);
        if (conflict) continue;
        feasible.push({ resource, start, end });
      }

      if (feasible.length === 0) continue;

      const best = pickBerthCandidate(feasible, assignedSlots, config, leg.mode);

      const slot: ScheduledSlot = {
        id: randomUUID(),
        customerId: c.id,
        resourceId: best.resource.id,
        direction: leg.direction,
        mode: leg.mode,
        legKey: leg.laneKey ?? null,
        volume: leg.meps,
        start: best.start,
        end: best.end,
        status: "scheduled",
        conflictReason: null
      };
      assignedSlots.push(slot);

      if (sharedShipping) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (
          loadingHours > 0 &&
          hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)
        ) {
          const flowPerHour = slot.volume / loadingHours;
          const sign = slot.direction === "inbound" ? 1 : -1;
          terminalRef.t += sign * flowPerHour;
          const cap = config.totalStorageCapacity ?? 100000;
          terminalRef.t = Math.max(0, Math.min(cap, terminalRef.t));
        }
      } else {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        if (
          loadingHours > 0 &&
          hourOverlapsIntervalMs(h, simStartMs, cargoStartMs, cargoEndMs)
        ) {
          const flowPerHour = slot.volume / loadingHours;
          const sign = slot.direction === "inbound" ? 1 : -1;
          invById[slot.customerId] = (invById[slot.customerId] ?? 0) + sign * flowPerHour;
          if (sharedInventory) {
            normalizeSharedInventoryToCap(invById, customers, config.totalStorageCapacity ?? 100000);
          } else {
            const slotInvCap = getCustomerMaxCapacity(c, config);
            invById[slot.customerId] = Math.max(0, Math.min(slotInvCap, invById[slot.customerId]!));
          }
        }
      }
    }

    const customerInventories: Record<string, number> = {};
    let terminalTotal = 0;
    for (const c of customers) {
      const v = poolProportional ? custInvCommingled(terminalRef.t, c, customers) : (invById[c.id] ?? 0);
      const tonnes = Math.round(v);
      customerInventories[c.id] = tonnes;
      terminalTotal += tonnes;
    }

    for (const c of customers) {
      invTimeline[c.id].push(customerInventories[c.id]);
    }

    const transportStatus = buildTransportStatuses(
      h,
      legs,
      assignedSlots,
      resources,
      config,
      customers,
      invById,
      terminalRef,
      periodHours,
      simStartMs,
      simEnd.getTime(),
      minInterval,
      invBeforeNewSlotsThisHour,
      terminalBeforeNewSlotsThisHour
    );

    simulationLog.push({
      hour: h,
      datetime: new Date(simStartMs + h * HOUR_MS).toISOString(),
      customerInventories,
      terminalTotal,
      pipelineFlow: { ...hourPipelineForLog },
      averageCustomerDaysOfCover:
        averageDoc != null && Number.isFinite(averageDoc)
          ? Math.round(averageDoc * 1000) / 1000
          : null,
      combinedTerminalDaysOfCover:
        combinedDoc != null && Number.isFinite(combinedDoc)
          ? Math.round(combinedDoc * 1000) / 1000
          : null,
      transportStatus
    });
  }

  const inventoryTimeline: InventoryTimeline = new Map(Object.entries(invTimeline));

  const postRunWarnings = runPostRunFeasibilityChecks(customers, config, simulationLog);

  return {
    scheduledSlots: assignedSlots,
    simulationLog,
    inventoryTimeline,
    feasibilityWarnings: [...feasibilityWarnings, ...postRunWarnings]
  };
}
