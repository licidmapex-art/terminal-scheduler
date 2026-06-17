/**
 * Hour-by-hour scheduler – single forward pass, no transport requests.
 */

const randomUUID = () => globalThis.crypto.randomUUID();
import type {
  Blackout,
  Customer,
  Resource,
  ScheduledSlot,
  SimulationConfig,
  SimulationOverrides,
  StochasticEvent,
  TransportPool
} from "../types";
import type { SimulationLogRow, TransportModeStatus } from "./simulationLog";
import {
  getCustomerMaxCapacity,
  normalizeSharedInventoryToCap,
  applySharedInventoryPipelineHour,
  applyBerthCargoToInventory,
  type InventoryTimeline
} from "./inventory";
import { hasActiveTransportPoolLegs } from "./transportPools";
import { runFeasibilityChecks, type FeasibilityWarning, type SchedulingLeg } from "./feasibility";
import { runPostRunFeasibilityChecks } from "./postRunFeasibility";
import {
  laytimeFromConfig,
  getCargoWindowMs,
  hourOverlapsIntervalMs,
  cargoTonnesInSimulationHour,
  firstHourOverlappingCargo
} from "./slotLaytime";
import {
  customerPipelineLogFlowPerHour,
  customerPipelineNetDeltaPerHour,
  resolveCustomerPipelineRates
} from "./pipelineFlows";
import {
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane
} from "./customerLegTargets";
import {
  buildSlotWithReservation,
  earliestFreeOnResourceBefore,
  findResourceBlockConflict,
  legReservationWindowHours,
  slotResourceBlockInterval
} from "./berthReservation";
import {
  applyGradeAttributedFlow,
  initGradeInventoryLedger,
  initGradeLedgerTimeline,
  pushGradeLedgerHour,
  scaleCustomerGradeLedger,
  sharedInventoryFloorBlocks,
  snapshotGradeLedger,
  type GradeInventoryLedger,
  type GradeLedgerTimeline
} from "./gradeInventoryLedger";
import { paceAllowanceForDirection, pacerAppliesAtBookingTime } from "./pacing";
import {
  averageCustomerDaysOfCoverAtHour,
  averagePoolFulfillmentRatioAtHour,
  combinedTerminalDaysOfCoverAtHour,
  compareSchedulingLegs,
  hoursSinceLastLegSlot,
  lastLegSlotStartHourForRoundtrip,
  countLegMassThroughHour,
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
import {
  applySlotTimeAdjustments,
  eventsActiveAtHour,
  immobilisationWarnings,
  pipelineMultiplierForHour
} from "./stochastic";

const HOUR_MS = 60 * 60 * 1000;

export interface SchedulerRunOptions {
  /** When set, replay physics/log from this slot list — no new berth bookings. */
  fixedSlots?: ScheduledSlot[];
  /** Baseline slots before stochastic time shifts (for warnings). */
  baselineSlots?: ScheduledSlot[];
  /** Resolved stochastic overrides applied during replay. */
  simulationOverrides?: SimulationOverrides;
  /** Full event list for simulation log annotation. */
  stochasticEvents?: StochasticEvent[];
  /** Seed used when overrides were sampled (for reproducibility). */
  stochasticSeed?: number;
}

export interface ScheduleResult {
  scheduledSlots: ScheduledSlot[];
  simulationLog: SimulationLogRow[];
  inventoryTimeline: InventoryTimeline;
  gradeLedgerTimeline: GradeLedgerTimeline | null;
  feasibilityWarnings: FeasibilityWarning[];
  /** Present when replay used stochastic sampling. */
  simulationOverrides?: SimulationOverrides;
  stochasticEvents?: StochasticEvent[];
  baselineSlots?: ScheduledSlot[];
  stochasticSeed?: number;
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
  candidate: ScheduledSlot,
  assignedSlots: ScheduledSlot[],
  blackouts: Blackout[],
  minIntervalHours: number,
  config: SimulationConfig
): { type: "slot" | "blackout"; end: Date } | null {
  return findResourceBlockConflict(
    candidate,
    assignedSlots,
    blackouts,
    minIntervalHours,
    config
  );
}

function tryBuildBookableSlot(
  leg: SchedulingLeg,
  resource: Resource,
  start: Date,
  end: Date,
  assignedSlots: ScheduledSlot[],
  blackouts: Blackout[],
  config: SimulationConfig,
  simStartMs: number,
  simEndMs: number,
  minInterval: number
): ScheduledSlot | null {
  const c = leg.customer;
  const draft: ScheduledSlot = {
    id: randomUUID(),
    customerId: c.id,
    resourceId: resource.id,
    direction: leg.direction,
    mode: leg.mode,
    legKey: leg.laneKey ?? null,
    volume: leg.meps,
    start,
    end,
    reservationStart: null,
    reservationEnd: null,
    status: "scheduled",
    conflictReason: null
  };

  const windowHours = leg.reservationWindowHours ?? 0;
  const earliestFree = earliestFreeOnResourceBefore(
    resource.id,
    start.getTime(),
    assignedSlots,
    blackouts,
    minInterval,
    config,
    simStartMs
  );

  const slot = buildSlotWithReservation(draft, config, windowHours, earliestFree, simStartMs);
  if (!slot) return null;

  const { blockEndMs } = slotResourceBlockInterval(slot, config, minInterval);
  if (blockEndMs > simEndMs) return null;

  const conflict = findConflict(slot, assignedSlots, blackouts, minInterval, config);
  if (conflict) return null;

  return slot;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

function deriveLegs(
  customers: Customer[],
  config: SimulationConfig,
  periodHours: number,
  transportPools: TransportPool[] = []
): SchedulingLeg[] {
  const legs: SchedulingLeg[] = [];
  for (const customer of customers) {
    const inTargets = inboundTargetSlotsByLane(customer, periodHours, transportPools);
    for (const t of inTargets) {
      if (t.targetSlots <= 0) continue;
      legs.push({
        customer,
        direction: "inbound",
        mode: t.mode,
        laneIndex: t.laneIndex,
        laneKey: `inbound-${t.mode}-${t.laneIndex + 1}`,
        laneLabel: t.legLabel,
        meps: t.meps,
        targetSlots: t.targetSlots,
        roundtripHours: t.roundtripHours ?? 0,
        reservationWindowHours: legReservationWindowHours(customer, "inbound", t.laneIndex),
        poolId: t.poolId ?? null,
        inventoryAllocation: t.inventoryAllocation ?? "attributed"
      });
    }
    const outTargets = outboundTargetSlotsByLane(customer, config, periodHours, transportPools);
    for (const t of outTargets) {
      if (t.targetSlots <= 0) continue;
      legs.push({
        customer,
        direction: "outbound",
        mode: t.mode,
        laneIndex: t.laneIndex,
        laneKey: `outbound-${t.mode}-${t.laneIndex + 1}`,
        laneLabel: t.legLabel,
        meps: t.meps,
        targetSlots: t.targetSlots,
        roundtripHours: t.roundtripHours ?? 0,
        reservationWindowHours: legReservationWindowHours(customer, "outbound", t.laneIndex),
        poolId: t.poolId ?? null,
        inventoryAllocation: t.inventoryAllocation ?? "attributed"
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

function pipelineMultiplierByCustomerForHour(
  overrides: SimulationOverrides | undefined,
  hour: number,
  customers: Customer[]
): Record<string, number> | undefined {
  if (!overrides?.pipelineMultiplierByHour[hour]) return undefined;
  const out: Record<string, number> = {};
  for (const c of customers) {
    out[c.id] = pipelineMultiplierForHour(overrides, hour, c.id);
  }
  return out;
}

function applyPipelineFixedBand(
  h: number,
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>,
  gradeLedger: GradeInventoryLedger | null,
  pipelineMultiplierByCustomer?: Record<string, number>
): Record<string, number> | undefined {
  if (h <= 0) return undefined;
  if (config.storageMode === "shared_inventory") {
    return applySharedInventoryPipelineHour(
      invById,
      customers,
      config,
      gradeLedger,
      pipelineMultiplierByCustomer
    );
  }
  const effective: Record<string, number> = {};
  for (const c of customers) {
    const mult = pipelineMultiplierByCustomer?.[c.id] ?? 1;
    const delta = customerPipelineNetDeltaPerHour(c, config) * mult;
    invById[c.id] = (invById[c.id] ?? 0) + delta;
    effective[c.id] = delta;
    if (gradeLedger && delta !== 0) {
      applyGradeAttributedFlow(gradeLedger, c, Math.abs(delta), delta > 0 ? "inbound" : "outbound");
    }
  }
  return pipelineMultiplierByCustomer ? effective : undefined;
}

function applyPipelineCommingled(
  h: number,
  customers: Customer[],
  config: SimulationConfig,
  terminalRef: { t: number },
  pipelineMultiplierByCustomer?: Record<string, number>
): void {
  if (h <= 0) return;
  const cap = config.totalStorageCapacity ?? 100000;
  const mult = (id: string) => pipelineMultiplierByCustomer?.[id] ?? 1;
  let inboundTotal = 0;
  let outboundTotal = 0;
  for (const c of customers) {
    const { inboundTph, outboundTph } = resolveCustomerPipelineRates(c, config);
    inboundTotal += inboundTph * mult(c.id);
    outboundTotal += outboundTph * mult(c.id);
  }
  terminalRef.t += inboundTotal - outboundTotal;
  terminalRef.t = Math.max(0, Math.min(cap, terminalRef.t));
}

function applySlotTonnesFixedBand(
  slot: ScheduledSlot,
  tonnes: number,
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>,
  transportPools: TransportPool[],
  gradeLedger: GradeInventoryLedger | null
): void {
  applyBerthCargoToInventory(
    slot,
    tonnes,
    customers,
    config,
    transportPools,
    invById,
    gradeLedger
  );
}

function clampFixedBandInventories(
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>,
  gradeLedger: GradeInventoryLedger | null
): void {
  const totalCap = config.totalStorageCapacity ?? 100000;
  if (config.storageMode === "shared_inventory") {
    const beforeNorm = Object.fromEntries(customers.map((c) => [c.id, invById[c.id] ?? 0]));
    normalizeSharedInventoryToCap(invById, customers, totalCap);
    if (gradeLedger) {
      for (const c of customers) {
        scaleCustomerGradeLedger(gradeLedger, c, invById[c.id] ?? 0, beforeNorm[c.id] ?? 0);
      }
    }
    return;
  }
  for (const c of customers) {
    const mx = getCustomerMaxCapacity(c, config);
    invById[c.id] = Math.max(0, Math.min(mx, invById[c.id] ?? 0));
  }
}

function applySlotFlowsFixedBand(
  h: number,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  customers: Customer[],
  config: SimulationConfig,
  invById: Record<string, number>,
  transportPools: TransportPool[],
  gradeLedger: GradeInventoryLedger | null
): void {
  const { preOps, postOps } = laytimeFromConfig(config);
  for (const slot of assignedSlots) {
    const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
    if (loadingHours <= 0) continue;
    const tonnes = cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, slot.volume);
    applySlotTonnesFixedBand(
      slot,
      tonnes,
      customers,
      config,
      invById,
      transportPools,
      gradeLedger
    );
  }
  clampFixedBandInventories(customers, config, invById, gradeLedger);
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
    const tonnes = cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, slot.volume);
    if (tonnes <= 0) continue;
    const sign = slot.direction === "inbound" ? 1 : -1;
    terminalRef.t += sign * tonnes;
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

function tieBreakerSnapshots(
  leg: SchedulingLeg,
  legs: SchedulingLeg[],
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  h: number,
  sharedShipping: boolean,
  sharedInventory: boolean,
  customers: Customer[],
  transportPools: TransportPool[]
): Pick<TransportModeStatus, "fulfillmentRatio" | "hoursSinceLastSlot" | "poolFulfillmentAvg"> {
  const massThrough = countLegMassThroughHour(leg, assignedSlots, simStartMs, h - 1);
  const ratio = customerLegFulfillmentRatio(leg, massThrough);
  const fulfillmentRatio = Number.isFinite(ratio) ? Math.round(ratio * 1000) / 1000 : null;
  const wait = hoursSinceLastLegSlot(leg, assignedSlots, simStartMs, h, customers, transportPools);
  let poolFulfillmentAvg: number | null = null;
  if (legUsesFulfillmentPool(leg, sharedShipping, sharedInventory)) {
    const avg = averagePoolFulfillmentRatioAtHour(
      leg,
      legs,
      assignedSlots,
      simStartMs,
      h,
      sharedShipping,
      sharedInventory
    );
    poolFulfillmentAvg = avg != null && Number.isFinite(avg) ? Math.round(avg * 1000) / 1000 : null;
  }
  return { fulfillmentRatio, hoursSinceLastSlot: wait, poolFulfillmentAvg };
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
  terminalBeforeNewSlotsThisHour: number,
  invAtHourStart: Record<string, number>,
  terminalAtHourStart: number,
  transportPools: TransportPool[],
  gradeLedger: GradeInventoryLedger | null,
  commingledBerthInventory: boolean
): TransportModeStatus[] {
  const pacerSnapshots = [
    { terminalRefTotal: terminalAtHourStart, invById: invAtHourStart },
    { terminalRefTotal: terminalBeforeNewSlotsThisHour, invById: invBeforeNewSlotsThisHour }
  ];
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
        ...tieBreakerSnapshots(leg, legs, assignedSlots, simStartMs, h, sharedShipping, sharedInventory, customers, transportPools),
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
      const pacerApplies = pacerAppliesAtBookingTime(
        leg.direction,
        config,
        c,
        customers,
        pacerSnapshots
      );
      const { continuous: paceTargetContinuous, allowance: paceAllowance, settings: paceSettings } =
        paceAllowanceForDirection(h, periodHoursSafe, effTarget, leg.direction, config);
      if (pacerApplies && (nBefore >= effTarget || nBefore >= paceAllowance)) {
        blockingConstraint = "pace_ahead";
        constraintDetail = poolPace
          ? `scheduled ${nBefore}/${effTarget} (combined), pace ${paceTargetContinuous.toFixed(2)} → allow ${paceAllowance} (${leg.direction} decile ${paceSettings.roundAtDecile}, allowance ${paceSettings.allowance})`
          : `scheduled ${nBefore}/${effTarget}, pace ${paceTargetContinuous.toFixed(2)} → allow ${paceAllowance} (${leg.direction} decile ${paceSettings.roundAtDecile}, allowance ${paceSettings.allowance})`;
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
      const massThrough = countLegMassThroughHour(leg, assignedSlots, simStartMs, h - 1);
      const legFulfillment = customerLegFulfillmentRatio(leg, massThrough);
      if (relativeFulfillmentOptimizerShouldYield(legFulfillment, avgFulfillment, fulfillmentOptimizerMultiplier)) {
        blockingConstraint = "optimizer_fulfillment";
        const avgPct = avgFulfillment != null ? (avgFulfillment * 100).toFixed(1) : "—";
        constraintDetail = `mass fulfilment ${(legFulfillment * 100).toFixed(1)}% > ${fulfillmentOptimizerMultiplier}× pool avg ${avgPct}% — yields slot to other customers`;
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

    const lastStart = lastLegSlotStartHourForRoundtrip(
      leg,
      assignedSlots,
      simStartMs,
      h,
      customers,
      transportPools
    );
    if (!blockingConstraint && lastStart !== null && leg.roundtripHours > 0) {
      if (h < lastStart + leg.roundtripHours) {
        blockingConstraint = "roundtrip";
        const availableAt = new Date(simStartMs + (lastStart + leg.roundtripHours) * HOUR_MS);
        constraintDetail = `vessel available at ${availableAt.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        })}`;
      }
    }

    if (!blockingConstraint) {
      const invSched = commingledBerthInventory
        ? custInvCommingled(terminalBeforeNewSlotsThisHour, c, customers)
        : (invBeforeNewSlotsThisHour[c.id] ?? 0);
      const terminalForPoolSched = sharedInventory
        ? sumCustomerInventory(invBeforeNewSlotsThisHour, customers)
        : terminalBeforeNewSlotsThisHour;

      if (leg.direction === "outbound") {
        if (sharedInventory) {
          if (terminalForPoolSched < leg.meps) {
            blockingConstraint = "insufficient_inventory";
            constraintDetail = `need ${leg.meps.toLocaleString()}t, have ${terminalForPoolSched.toFixed(0)}t (${c.name}: pooled sum of attributed stock for outbound check)`;
          } else {
            const floor = sharedInventoryFloorBlocks(
              c,
              leg.meps,
              invSched,
              gradeLedger,
              config,
              customers
            );
            if (floor.blocked) {
              blockingConstraint = "customer_inventory_floor";
              constraintDetail = floor.detail;
            }
          }
        } else if (commingledBerthInventory) {
          if (terminalForPoolSched < leg.meps) {
            blockingConstraint = "insufficient_inventory";
            constraintDetail = `need ${leg.meps.toLocaleString()}t, have ${terminalForPoolSched.toFixed(0)}t (${c.name}: terminal total for outbound check)`;
          }
        } else if (invSched < leg.meps) {
          blockingConstraint = "insufficient_inventory";
          constraintDetail = `need ${leg.meps.toLocaleString()}t, have ${invSched.toFixed(0)}t (${c.name} attributed — fixed band, not terminal total)`;
        }
      } else {
        if (sharedInventory) {
          const cap = config.totalStorageCapacity ?? 100000;
          if (terminalForPoolSched + leg.meps > cap) {
            blockingConstraint = "tank_full";
            constraintDetail = `need ${leg.meps.toLocaleString()}t space, have ${(cap - terminalForPoolSched).toFixed(0)}t`;
          }
        } else if (commingledBerthInventory) {
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
          const slot = tryBuildBookableSlot(
            leg,
            res,
            candidateStart,
            end,
            assignedSlots,
            blackouts,
            config,
            simStartMs,
            simEndMs,
            minInterval
          );
          if (slot) {
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
      const invNow = commingledBerthInventory
        ? custInvCommingled(terminalRef.t, c, customers)
        : (invById[c.id] ?? 0);
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
      optimizerDaysOfCover: optimizerMetricSnapshot,
      ...tieBreakerSnapshots(leg, legs, assignedSlots, simStartMs, h, sharedShipping, sharedInventory, customers, transportPools)
    });
  }

  return out;
}

export function runScheduler(
  customers: Customer[],
  resources: Resource[],
  config: SimulationConfig,
  transportPools: TransportPool[] = [],
  options: SchedulerRunOptions = {}
): ScheduleResult {
  const replayOnly = options.fixedSlots != null;
  const simulationOverrides = options.simulationOverrides;
  const stochasticEvents = options.stochasticEvents;
  const baselineSlotsForWarnings = options.baselineSlots;
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
  const activeTransportPools = hasActiveTransportPoolLegs(customers, transportPools);
  const commingledBerthInventory = sharedShipping && !activeTransportPools;
  const poolProportional = commingledBerthInventory;

  const legs = deriveLegs(customers, config, periodHoursSafe, transportPools);
  const aggTargetMap = buildDirectionModeAggTargetMap(legs, sharedShipping, sharedInventory);
  const feasibilityWarnings = replayOnly
    ? []
    : runFeasibilityChecks(customers, resources, legs, config);

  const assignedSlots: ScheduledSlot[] = replayOnly
    ? options.fixedSlots!.map((s) => ({
        ...s,
        start: new Date(s.start),
        end: new Date(s.end),
        reservationStart: s.reservationStart ? new Date(s.reservationStart) : null,
        reservationEnd: s.reservationEnd ? new Date(s.reservationEnd) : null
      }))
    : [];
  const invById: Record<string, number> = {};
  for (const c of customers) {
    invById[c.id] = c.currentInventory;
  }
  const gradeLedger: GradeInventoryLedger | null = sharedInventory
    ? initGradeInventoryLedger(customers)
    : null;
  const terminalRef = {
    t: customers.reduce((s, c) => s + c.currentInventory, 0)
  };

  const simulationLog: SimulationLogRow[] = [];
  const pipelineFlow = pipelineFlowRecord(customers, config);
  const invTimeline: Record<string, number[]> = {};
  for (const c of customers) invTimeline[c.id] = [];
  const gradeLedgerTimeline: GradeLedgerTimeline | null = gradeLedger
    ? initGradeLedgerTimeline(customers)
    : null;

  for (let h = 0; h <= periodHours; h++) {
    const invAtHourStart: Record<string, number> = { ...invById };
    const terminalAtHourStart = sharedInventory
      ? sumCustomerInventory(invById, customers)
      : terminalRef.t;

    let hourPipelineForLog: Record<string, number> = pipelineFlow;
    const pipeMult = pipelineMultiplierByCustomerForHour(simulationOverrides, h, customers);
    if (sharedShipping) {
      applyPipelineCommingled(h, customers, config, terminalRef, pipeMult);
      if (activeTransportPools) {
        applySlotFlowsFixedBand(
          h,
          assignedSlots,
          simStartMs,
          customers,
          config,
          invById,
          transportPools,
          gradeLedger
        );
      } else {
        applySlotFlowsCommingled(h, assignedSlots, simStartMs, config, terminalRef);
      }
    } else {
      const eff = applyPipelineFixedBand(h, customers, config, invById, gradeLedger, pipeMult);
      if (eff) hourPipelineForLog = eff;
      applySlotFlowsFixedBand(h, assignedSlots, simStartMs, customers, config, invById, transportPools, gradeLedger);
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
      const massA = countLegMassThroughHour(a, assignedSlots, simStartMs, h);
      const massB = countLegMassThroughHour(b, assignedSlots, simStartMs, h);
      const waitA = hoursSinceLastLegSlot(a, assignedSlots, simStartMs, h, customers, transportPools);
      const waitB = hoursSinceLastLegSlot(b, assignedSlots, simStartMs, h, customers, transportPools);
      return compareSchedulingLegs(
        a,
        b,
        mA,
        mB,
        sharedShipping,
        massA,
        massB,
        sharedInventory,
        waitA,
        waitB
      );
    });

    const candidateStartBase = new Date(simStartMs + h * HOUR_MS);

    const invBeforeNewSlotsThisHour: Record<string, number> = { ...invById };
    const terminalBeforeNewSlotsThisHour = sharedInventory
      ? sumCustomerInventory(invById, customers)
      : terminalRef.t;
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

    if (!replayOnly) {
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
      const pacerSnapshots = [
        { terminalRefTotal: terminalAtHourStart, invById: invAtHourStart },
        { terminalRefTotal: terminalBeforeNewSlotsThisHour, invById: invBeforeNewSlotsThisHour }
      ];
      const pacerApplies = pacerAppliesAtBookingTime(
        leg.direction,
        config,
        leg.customer,
        customers,
        pacerSnapshots
      );
      const { allowance: paceAllowance } = paceAllowanceForDirection(
        h,
        periodHoursSafe,
        effTarget,
        leg.direction,
        config
      );
      if (pacerApplies && nBeforeThisHour >= paceAllowance) continue;

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
        const massThrough = countLegMassThroughHour(leg, assignedSlots, simStartMs, h - 1);
        const legFulfillment = customerLegFulfillmentRatio(leg, massThrough);
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

      const lastStart = lastLegSlotStartHourForRoundtrip(
        leg,
        assignedSlots,
        simStartMs,
        h,
        customers,
        transportPools
      );
      if (lastStart !== null && leg.roundtripHours > 0 && h < lastStart + leg.roundtripHours) {
        continue;
      }

      const terminalSumInv = sumCustomerInventory(invById, customers);
      if (leg.direction === "outbound") {
        if (mode === "shared_inventory") {
          if (terminalSumInv < leg.meps) continue;
          const invC = invById[c.id] ?? 0;
          const floor = sharedInventoryFloorBlocks(
            c,
            leg.meps,
            invC,
            gradeLedger,
            config,
            customers
          );
          if (floor.blocked) continue;
        } else if (commingledBerthInventory) {
          if (terminalRef.t < leg.meps) continue;
        } else if (inv < leg.meps) continue;
      } else {
        if (mode === "shared_inventory") {
          const cap = config.totalStorageCapacity ?? 100000;
          if (terminalSumInv + leg.meps > cap) continue;
        } else if (commingledBerthInventory) {
          const cap = config.totalStorageCapacity ?? 100000;
          if (terminalRef.t + leg.meps > cap) continue;
        } else if (inv + leg.meps > customerMax) continue;
      }

      const compatible = getCompatibleResources(leg.mode, resources, config);
      const bookable: ScheduledSlot[] = [];

      for (const resource of compatible) {
        if (resource.flowRate <= 0) continue;
        const loadingHours = leg.meps / resource.flowRate;
        const start = candidateStartBase;
        const end = addHours(start, preOps + loadingHours + postOps);
        if (end.getTime() > simEnd.getTime()) continue;
        const blackouts = getBlackoutsForResource(resource);
        const slot = tryBuildBookableSlot(
          leg,
          resource,
          start,
          end,
          assignedSlots,
          blackouts,
          config,
          simStartMs,
          simEnd.getTime(),
          minInterval
        );
        if (slot) bookable.push(slot);
      }

      if (bookable.length === 0) continue;

      const best = pickBerthCandidate(
        bookable.map((s) => ({
          resource: compatible.find((r) => r.id === s.resourceId)!,
          start: s.start,
          end: s.end
        })),
        assignedSlots,
        config,
        leg.mode
      );
      const slot = bookable.find(
        (s) => s.resourceId === best.resource.id && s.start.getTime() === best.start.getTime()
      );
      if (!slot) continue;

      assignedSlots.push(slot);

      if (commingledBerthInventory) {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        const tonnes =
          loadingHours > 0
            ? cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, slot.volume)
            : 0;
        if (tonnes > 0) {
          const sign = slot.direction === "inbound" ? 1 : -1;
          terminalRef.t += sign * tonnes;
          const cap = config.totalStorageCapacity ?? 100000;
          terminalRef.t = Math.max(0, Math.min(cap, terminalRef.t));
        }
      } else {
        const { cargoStartMs, cargoEndMs, loadingHours } = getCargoWindowMs(slot, preOps, postOps);
        const tonnes =
          loadingHours > 0
            ? cargoTonnesInSimulationHour(h, simStartMs, cargoStartMs, cargoEndMs, slot.volume)
            : 0;
        if (tonnes > 0) {
          applySlotTonnesFixedBand(
            slot,
            tonnes,
            customers,
            config,
            invById,
            transportPools,
            gradeLedger
          );
          clampFixedBandInventories(customers, config, invById, gradeLedger);
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
    if (gradeLedger && gradeLedgerTimeline) {
      pushGradeLedgerHour(gradeLedgerTimeline, gradeLedger, customers);
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
      terminalBeforeNewSlotsThisHour,
      invAtHourStart,
      terminalAtHourStart,
      transportPools,
      gradeLedger,
      commingledBerthInventory
    );

    simulationLog.push({
      hour: h,
      datetime: new Date(simStartMs + h * HOUR_MS).toISOString(),
      customerInventories,
      customerGradeInventories: gradeLedger ? snapshotGradeLedger(gradeLedger, customers) : undefined,
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
      transportStatus,
      stochasticEvents: stochasticEvents?.length
        ? eventsActiveAtHour(stochasticEvents, h)
        : undefined
    });
  }

  const inventoryTimeline: InventoryTimeline = new Map(Object.entries(invTimeline));

  const postRunWarnings = runPostRunFeasibilityChecks(
    customers,
    config,
    simulationLog,
    assignedSlots
  );

  const immWarnings =
    replayOnly && simulationOverrides && baselineSlotsForWarnings
      ? immobilisationWarnings(
          baselineSlotsForWarnings.map((s) => ({
            ...s,
            start: new Date(s.start),
            end: new Date(s.end),
            reservationStart: s.reservationStart ? new Date(s.reservationStart) : null,
            reservationEnd: s.reservationEnd ? new Date(s.reservationEnd) : null
          })),
          simulationOverrides.immobilisationWindows
        )
      : [];

  return {
    scheduledSlots: assignedSlots,
    simulationLog,
    inventoryTimeline,
    gradeLedgerTimeline,
    feasibilityWarnings: [...feasibilityWarnings, ...postRunWarnings, ...immWarnings],
    ...(simulationOverrides ? { simulationOverrides } : {}),
    ...(stochasticEvents?.length ? { stochasticEvents } : {}),
    ...(baselineSlotsForWarnings ? { baselineSlots: baselineSlotsForWarnings } : {}),
    ...(options.stochasticSeed != null ? { stochasticSeed: options.stochasticSeed } : {})
  };
}
