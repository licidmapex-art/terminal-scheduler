import type { Customer, SimulationConfig } from "../types";

export interface CustomerPipelineRates {
  inboundTph: number;
  outboundTph: number;
  /** Net inventory change per hour: inbound − outbound. */
  netTph: number;
}

function hasExplicitPipelineColumns(customer: Customer): boolean {
  return (
    (customer.pipelineInboundPerHour ?? 0) > 0 ||
    (customer.pipelineOutboundPerHour ?? 0) > 0
  );
}

/**
 * Resolve per-customer inbound/outbound pipeline (t/h).
 * Prefer explicit DB columns; fall back to signed net + terminal direction for legacy data.
 */
export function resolveCustomerPipelineRates(
  customer: Customer,
  config: SimulationConfig
): CustomerPipelineRates {
  if (hasExplicitPipelineColumns(customer)) {
    const inboundTph = Math.max(0, customer.pipelineInboundPerHour ?? 0);
    const outboundTph = Math.max(0, customer.pipelineOutboundPerHour ?? 0);
    return { inboundTph, outboundTph, netTph: inboundTph - outboundTph };
  }

  const net = customer.pipelineFlowPerHour ?? 0;
  if (net < 0) {
    return { inboundTph: 0, outboundTph: -net, netTph: net };
  }
  if (config.pipelineDirection === "outbound") {
    return { inboundTph: 0, outboundTph: net, netTph: -net };
  }
  return { inboundTph: net, outboundTph: 0, netTph: net };
}

export function totalInboundPipelineTph(
  customers: Customer[],
  config: SimulationConfig
): number {
  return customers.reduce(
    (s, c) => s + resolveCustomerPipelineRates(c, config).inboundTph,
    0
  );
}

export function totalOutboundPipelineTph(
  customers: Customer[],
  config: SimulationConfig
): number {
  return customers.reduce(
    (s, c) => s + resolveCustomerPipelineRates(c, config).outboundTph,
    0
  );
}

export function customerPipelineNetDeltaPerHour(
  customer: Customer,
  config: SimulationConfig
): number {
  return resolveCustomerPipelineRates(customer, config).netTph;
}

/** Signed effective flow for simulation log (t/h added to customer inventory). */
export function customerPipelineLogFlowPerHour(
  customer: Customer,
  config: SimulationConfig
): number {
  return customerPipelineNetDeltaPerHour(customer, config);
}
