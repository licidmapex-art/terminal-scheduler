/**
 * Relative days-of-cover optimizer: yield a slot attempt when a leg's DoC exceeds
 * x × the cross-customer average (same hour), so other customers can use the berth.
 */

import type { Customer, SimulationConfig } from "../types";
import type { SchedulingLeg } from "./feasibility";
import { customerRepresentativeDaysOfCover } from "./customerLegTargets";
import { getCustomerMaxCapacity } from "./inventory";
import { resolveCustomerPipelineRates } from "./pipelineFlows";

const SORT_METRIC_EPS = 1e-6;

export function normalizedOptimizerRelativeDocMultiplier(config: SimulationConfig): number {
  const raw = Number(config.optimizerRelativeDocMultiplier ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
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
