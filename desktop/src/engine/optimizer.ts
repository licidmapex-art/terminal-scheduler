/**
 * Relative days-of-cover optimizer: yield a slot attempt when a leg's DoC exceeds
 * x × the cross-customer average (same hour), so other customers can use the berth.
 */

import type { Customer, ScheduledSlot, SimulationConfig } from "../types";
import type { SchedulingLeg } from "./feasibility";
import { customerRepresentativeDaysOfCover } from "./customerLegTargets";
import { getCustomerMaxCapacity } from "./inventory";
import { resolveCustomerPipelineRates } from "./pipelineFlows";

const SORT_METRIC_EPS = 1e-6;
const HOUR_MS = 60 * 60 * 1000;

export function customerLegFulfillmentRatio(leg: SchedulingLeg, slotsScheduled: number): number {
  if (leg.targetSlots <= 0) return Number.POSITIVE_INFINITY;
  return slotsScheduled / leg.targetSlots;
}

export function countLegSlotsThroughHour(
  leg: SchedulingLeg,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  throughHour: number
): number {
  const laneKey = leg.laneKey ?? "lane0";
  return assignedSlots.filter((s) => {
    if (s.customerId !== leg.customer.id || s.direction !== leg.direction || s.mode !== leg.mode) {
      return false;
    }
    if ((s.legKey ?? "lane0") !== laneKey) return false;
    const startHour = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
    return startHour <= throughHour;
  }).length;
}

/** Latest slot start hour for this leg among slots already started through `throughHour`. */
export function lastLegSlotStartHour(
  leg: SchedulingLeg,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  throughHour: number
): number | null {
  const laneKey = leg.laneKey ?? "lane0";
  let best: number | null = null;
  for (const s of assignedSlots) {
    if (s.customerId !== leg.customer.id || s.direction !== leg.direction || s.mode !== leg.mode) {
      continue;
    }
    if ((s.legKey ?? "lane0") !== laneKey) continue;
    const startHour = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
    if (startHour <= throughHour && (best === null || startHour > best)) {
      best = startHour;
    }
  }
  return best;
}

/** Hours since this leg's last slot start (or since sim start if none yet). */
export function hoursSinceLastLegSlot(
  leg: SchedulingLeg,
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  h: number
): number {
  const last = lastLegSlotStartHour(leg, assignedSlots, simStartMs, h - 1);
  return last === null ? h : h - last;
}

/**
 * Sort legs for scheduling. In shared shipping (all legs) and shared inventory (inbound only),
 * legs in the same direction/mode pool rotate by fulfillment ratio so one customer cannot
 * monopolize early slots — unless either leg has negative sort metric (borrowed stock), in
 * which case DoC urgency overrides fulfilment fairness.
 */
export function compareSchedulingLegs(
  a: SchedulingLeg,
  b: SchedulingLeg,
  metricA: number,
  metricB: number,
  sharedShipping: boolean,
  slotsA: number,
  slotsB: number,
  sharedInventoryInboundPool = false,
  waitA = 0,
  waitB = 0
): number {
  const sharedPool =
    a.direction === b.direction &&
    a.mode === b.mode &&
    (sharedShipping || (sharedInventoryInboundPool && a.direction === "inbound"));

  const compareDoc = (): number | null => {
    if (Number.isFinite(metricA) && Number.isFinite(metricB)) {
      if (Math.abs(metricA - metricB) > SORT_METRIC_EPS) return metricA - metricB;
      return null;
    }
    if (Number.isFinite(metricA) && !Number.isFinite(metricB)) return -1;
    if (!Number.isFinite(metricA) && Number.isFinite(metricB)) return 1;
    return null;
  };

  const compareFulfillment = (): number | null => {
    const ratioA = customerLegFulfillmentRatio(a, slotsA);
    const ratioB = customerLegFulfillmentRatio(b, slotsB);
    if (Math.abs(ratioA - ratioB) > SORT_METRIC_EPS) return ratioA - ratioB;
    return null;
  };

  if (sharedPool) {
    const inventoryDistress = metricA < 0 || metricB < 0;
    if (inventoryDistress) {
      const docCmp = compareDoc();
      if (docCmp !== null) return docCmp;
      const fulCmp = compareFulfillment();
      if (fulCmp !== null) return fulCmp;
    } else {
      const fulCmp = compareFulfillment();
      if (fulCmp !== null) return fulCmp;
      const docCmp = compareDoc();
      if (docCmp !== null) return docCmp;
    }
  } else {
    const docCmp = compareDoc();
    if (docCmp !== null) return docCmp;
  }

  if (Math.abs(waitA - waitB) > SORT_METRIC_EPS) return waitB - waitA;

  return a.customer.id.localeCompare(b.customer.id);
}

export function normalizedOptimizerRelativeDocMultiplier(config: SimulationConfig): number {
  const raw = Number(config.optimizerRelativeDocMultiplier ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
}

export function normalizedOptimizerRelativeFulfillmentMultiplier(config: SimulationConfig): number {
  const raw = Number(config.optimizerRelativeFulfillmentMultiplier ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
}

/** Same pool scope as fulfilment-ratio merit order in compareSchedulingLegs. */
export function legUsesFulfillmentPool(
  leg: Pick<SchedulingLeg, "direction">,
  sharedShipping: boolean,
  sharedInventory: boolean
): boolean {
  if (sharedShipping) return true;
  return sharedInventory && leg.direction === "inbound";
}

export function averagePoolFulfillmentRatioAtHour(
  leg: SchedulingLeg,
  legs: SchedulingLeg[],
  assignedSlots: ScheduledSlot[],
  simStartMs: number,
  h: number,
  sharedShipping: boolean,
  sharedInventory: boolean
): number | null {
  if (!legUsesFulfillmentPool(leg, sharedShipping, sharedInventory)) return null;
  const poolLegs = legs.filter((l) => l.direction === leg.direction && l.mode === leg.mode);
  if (poolLegs.length === 0) return null;
  const ratios = poolLegs
    .map((l) => {
      const slots = countLegSlotsThroughHour(l, assignedSlots, simStartMs, h - 1);
      return customerLegFulfillmentRatio(l, slots);
    })
    .filter((r): r is number => Number.isFinite(r));
  if (ratios.length === 0) return null;
  return ratios.reduce((s, r) => s + r, 0) / ratios.length;
}

function pipelineInboundPerDayCustomer(customer: Customer, config: SimulationConfig): number {
  return resolveCustomerPipelineRates(customer, config).inboundTph * 24;
}

function pipelineOutboundPerDayCustomer(customer: Customer, config: SimulationConfig): number {
  return resolveCustomerPipelineRates(customer, config).outboundTph * 24;
}

function customerOutboundPressurePerDay(
  customer: Customer,
  legs: SchedulingLeg[],
  periodHours: number,
  config: SimulationConfig
): number {
  const periodDays = Math.max(periodHours / 24, 1e-9);
  const outLeg = legs.find((l) => l.customer.id === customer.id && l.direction === "outbound");
  const transportOut = outLeg ? (outLeg.targetSlots * outLeg.meps) / periodDays : 0;
  return pipelineOutboundPerDayCustomer(customer, config) + transportOut;
}

function customerInboundPressurePerDay(
  customer: Customer,
  legs: SchedulingLeg[],
  periodHours: number,
  config: SimulationConfig
): number {
  const periodDays = Math.max(periodHours / 24, 1e-9);
  const inLeg = legs.find((l) => l.customer.id === customer.id && l.direction === "inbound");
  const transportIn = inLeg ? (inLeg.targetSlots * inLeg.meps) / periodDays : 0;
  return pipelineInboundPerDayCustomer(customer, config) + transportIn;
}

/** Same leg sort metric as scheduler (for min across a customer's legs). */
export function legSortMetric(
  leg: SchedulingLeg,
  invOrTerminal: number,
  customerMax: number,
  config: SimulationConfig,
  periodHours: number,
  poolProportional: boolean,
  customer: Customer,
  allCustomers: Customer[],
  allLegs: SchedulingLeg[]
): number {
  const totalStorageShare = allCustomers.reduce((s, c) => s + c.storageShare, 0) || 100;
  const shareFrac = totalStorageShare > 0 ? customer.storageShare / totalStorageShare : 1 / allCustomers.length;
  const inv = poolProportional ? invOrTerminal * shareFrac : invOrTerminal;
  const headroom = Math.max(0, customerMax - inv);

  const outPressure = customerOutboundPressurePerDay(customer, allLegs, periodHours, config);
  const inPressure = customerInboundPressurePerDay(customer, allLegs, periodHours, config);

  if (leg.direction === "inbound") {
    if (outPressure <= SORT_METRIC_EPS) return Number.POSITIVE_INFINITY;
    return inv / outPressure;
  }
  if (inPressure <= SORT_METRIC_EPS) return headroom;
  return headroom / inPressure;
}

export function optimizerMetric(
  leg: SchedulingLeg,
  customer: Customer,
  config: SimulationConfig,
  periodHours: number,
  allLegs: SchedulingLeg[],
  customerInventory: number,
  terminalInventory: number,
  allCustomers: Customer[]
): number {
  const usesSharedShipping = config.storageMode === "shared_shipping";
  const invForOptimizer = usesSharedShipping ? terminalInventory : customerInventory;
  const maxForOptimizer = usesSharedShipping
    ? (config.totalStorageCapacity ?? 100000)
    : getCustomerMaxCapacity(customer, config);
  return legSortMetric(
    leg,
    invForOptimizer,
    maxForOptimizer,
    config,
    periodHours,
    usesSharedShipping,
    customer,
    allCustomers,
    allLegs
  );
}

function customerMinLegDaysOfCover(
  customer: Customer,
  legs: SchedulingLeg[],
  config: SimulationConfig,
  periodHours: number,
  invById: Record<string, number>,
  terminalInventory: number,
  customers: Customer[],
  sharedShipping: boolean
): number | null {
  const custLegs = legs.filter((l) => l.customer.id === customer.id);
  const customerMax = getCustomerMaxCapacity(customer, config);
  const invForDoc = sharedShipping ? terminalInventory : (invById[customer.id] ?? 0);
  const metrics = custLegs
    .map((leg) =>
      legSortMetric(leg, invForDoc, customerMax, config, periodHours, sharedShipping, customer, customers, legs)
    )
    .filter((m): m is number => Number.isFinite(m));
  if (metrics.length > 0) return Math.min(...metrics);
  return customerRepresentativeDaysOfCover(invById[customer.id] ?? 0, customer, config, periodHours);
}

function terminalInventoryForDaysOfCover(
  config: SimulationConfig,
  invById: Record<string, number>,
  terminalInventory: number,
  customers: Customer[]
): number {
  const mode = config.storageMode ?? "fixed_band";
  if (mode === "shared_shipping") return terminalInventory;
  return customers.reduce((s, c) => s + (invById[c.id] ?? 0), 0);
}

function terminalCapacityForDaysOfCover(customers: Customer[], config: SimulationConfig): number {
  const mode = config.storageMode ?? "fixed_band";
  if (mode === "shared_shipping" || mode === "shared_inventory") {
    return config.totalStorageCapacity ?? 100000;
  }
  return customers.reduce((s, c) => s + getCustomerMaxCapacity(c, config), 0);
}

function totalTerminalOutboundPressurePerDay(
  customers: Customer[],
  legs: SchedulingLeg[],
  periodHours: number,
  config: SimulationConfig
): number {
  return customers.reduce(
    (s, c) => s + customerOutboundPressurePerDay(c, legs, periodHours, config),
    0
  );
}

function totalTerminalInboundPressurePerDay(
  customers: Customer[],
  legs: SchedulingLeg[],
  periodHours: number,
  config: SimulationConfig
): number {
  return customers.reduce(
    (s, c) => s + customerInboundPressurePerDay(c, legs, periodHours, config),
    0
  );
}

/**
 * Terminal-wide DoC: total inventory ÷ summed outbound pressure, headroom ÷ summed inbound pressure,
 * then the minimum when both apply (same ingredients as per-customer DoC, aggregated).
 */
export function combinedTerminalDaysOfCoverAtHour(
  customers: Customer[],
  legs: SchedulingLeg[],
  config: SimulationConfig,
  periodHours: number,
  invById: Record<string, number>,
  terminalInventory: number,
  _sharedShipping: boolean
): number | null {
  const inv = terminalInventoryForDaysOfCover(config, invById, terminalInventory, customers);
  const capacity = terminalCapacityForDaysOfCover(customers, config);
  const headroom = Math.max(0, capacity - inv);
  const outPressure = totalTerminalOutboundPressurePerDay(customers, legs, periodHours, config);
  const inPressure = totalTerminalInboundPressurePerDay(customers, legs, periodHours, config);

  const cands: number[] = [];
  if (outPressure > SORT_METRIC_EPS) cands.push(inv / outPressure);
  if (inPressure > SORT_METRIC_EPS) cands.push(headroom / inPressure);
  if (cands.length === 0) {
    const daily = Math.max(inPressure, outPressure);
    if (daily <= 0) return null;
    return inv / daily;
  }
  return Math.min(...cands);
}

/**
 * Mean of each customer's tightest leg DoC at this hour (aligns with Analytics average DoC).
 */
export function averageCustomerDaysOfCoverAtHour(
  customers: Customer[],
  legs: SchedulingLeg[],
  config: SimulationConfig,
  periodHours: number,
  invById: Record<string, number>,
  terminalInventory: number,
  sharedShipping: boolean
): number | null {
  const vals: number[] = [];
  for (const c of customers) {
    const doc = customerMinLegDaysOfCover(
      c,
      legs,
      config,
      periodHours,
      invById,
      terminalInventory,
      customers,
      sharedShipping
    );
    if (doc != null && Number.isFinite(doc)) vals.push(doc);
  }
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

/** True when this leg should skip scheduling this hour (others may still book). */
export function relativeOptimizerShouldYield(
  legMetric: number,
  averageDoc: number | null,
  multiplier: number
): boolean {
  if (multiplier <= 0) return false;
  if (!Number.isFinite(legMetric) || averageDoc == null || !Number.isFinite(averageDoc)) return false;
  if (averageDoc <= SORT_METRIC_EPS) return false;
  return legMetric > multiplier * averageDoc;
}

/** True when this leg is too far ahead on annual fulfilment vs the direction+mode pool average. */
export function relativeFulfillmentOptimizerShouldYield(
  legRatio: number,
  averageRatio: number | null,
  multiplier: number
): boolean {
  if (multiplier <= 0) return false;
  if (!Number.isFinite(legRatio) || averageRatio == null || !Number.isFinite(averageRatio)) return false;
  if (averageRatio <= SORT_METRIC_EPS) return false;
  return legRatio > multiplier * averageRatio;
}
