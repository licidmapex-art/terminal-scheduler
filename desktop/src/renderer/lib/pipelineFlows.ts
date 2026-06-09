import type { Customer, SimulationConfig } from "../../types";
import {
  resolveCustomerPipelineRates,
  totalInboundPipelineTph as engineTotalInbound,
  totalOutboundPipelineTph as engineTotalOutbound
} from "../../engine/pipelineFlows";

export {
  resolveCustomerPipelineRates,
  customerPipelineNetDeltaPerHour,
  customerPipelineLogFlowPerHour,
  type CustomerPipelineRates
} from "../../engine/pipelineFlows";

export function totalInboundPipelineTph(
  customers: Customer[],
  configPipelineDirection: "inbound" | "outbound"
): number {
  return engineTotalInbound(customers, { pipelineDirection: configPipelineDirection } as SimulationConfig);
}

export function totalOutboundPipelineTph(
  customers: Customer[],
  configPipelineDirection: "inbound" | "outbound"
): number {
  return engineTotalOutbound(customers, { pipelineDirection: configPipelineDirection } as SimulationConfig);
}

/** Split customer pipeline into inbound/outbound rates (t/h). */
export function computePipelineFlows(
  customer: Pick<Customer, "pipelineFlowPerHour" | "pipelineInboundPerHour" | "pipelineOutboundPerHour">,
  configPipelineDirection: "inbound" | "outbound"
): { inbound: number; outbound: number } {
  const rates = resolveCustomerPipelineRates(
    customer as Customer,
    { pipelineDirection: configPipelineDirection } as SimulationConfig
  );
  return { inbound: rates.inboundTph, outbound: rates.outboundTph };
}
