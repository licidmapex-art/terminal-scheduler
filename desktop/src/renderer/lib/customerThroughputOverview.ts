import type { Customer, SimulationConfig } from "../../types";
import {
  inboundTargetSlotsByLane,
  outboundTargetSlotsByLane,
  outboundThroughputTonnes
} from "../../engine/customerLegTargets";
import { resolveCustomerPipelineRates } from "../../engine/pipelineFlows";
import {
  customerDirectionTransports,
  splitTonnesByShares
} from "../../engine/customerTransports";

export interface ModeThroughputLine {
  laneIndex: number;
  mode: "ship" | "barge" | "train";
  sharePct: number;
  meps: number;
  tonnes: number;
  /** Expected berth slots over the simulation window (scheduler target). */
  targetSlots: number;
}
export interface CustomerThroughputOverview {
  periodHours: number;
  storageShare: number;
  inboundTransportTonnes: number;
  inboundPipelineTonnes: number;
  inboundPipelineRatePerHour: number;
  /** Magnitude removed by outbound pipeline (shown as negative in formula). */
  outboundPipelineTonnes: number;
  outboundPipelineRatePerHour: number;
  /** Inbound transport + inbound pipeline − outbound pipeline (scheduler formula). */
  calculatedOutboundTonnes: number;
  inboundModes: ModeThroughputLine[];
  /** Berth allocation split of calculated outbound (includes pipeline in the total). */
  outboundModes: ModeThroughputLine[];
}

function simulationPeriodHours(config: SimulationConfig): number {
  const ms = new Date(config.endDate).getTime() - new Date(config.startDate).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}

function modeLines(
  rows: ReturnType<typeof customerDirectionTransports>,
  totalTonnes: number,
  targetSlotsByLane: number[]
): ModeThroughputLine[] {
  if (totalTonnes <= 0 || rows.length === 0) return [];
  const tonnesByLane = splitTonnesByShares(totalTonnes, rows);
  return rows.map((r, i) => ({
    laneIndex: i,
    mode: r.mode,
    sharePct: r.sharePct,
    meps: r.meps,
    tonnes: Math.max(0, tonnesByLane[i] ?? 0),
    targetSlots: targetSlotsByLane[i] ?? 0
  }));
}
export function buildCustomerThroughputOverview(
  customer: Customer,
  config: SimulationConfig
): CustomerThroughputOverview {
  const periodHours = simulationPeriodHours(config);
  const { inboundTph, outboundTph } = resolveCustomerPipelineRates(customer, config);
  const pipelineInbound = inboundTph * periodHours;
  const pipelineOutbound = outboundTph * periodHours;

  const inboundRows = customerDirectionTransports(customer, "inbound");
  const outboundRows = customerDirectionTransports(customer, "outbound");
  const declaredInbound = Math.max(0, customer.declaredInboundThroughput ?? 0);
  const calculatedOutbound = outboundThroughputTonnes(customer, config, periodHours);
  const inboundSlots = inboundTargetSlotsByLane(customer, periodHours).map((l) => l.targetSlots);
  const outboundSlots = outboundTargetSlotsByLane(customer, config, periodHours).map((l) => l.targetSlots);

  return {
    periodHours,
    storageShare: customer.storageShare ?? 0,
    inboundTransportTonnes: declaredInbound,
    inboundPipelineTonnes: pipelineInbound,
    inboundPipelineRatePerHour: inboundTph,
    outboundPipelineTonnes: pipelineOutbound,
    outboundPipelineRatePerHour: outboundTph,
    calculatedOutboundTonnes: calculatedOutbound,
    inboundModes: modeLines(inboundRows, declaredInbound, inboundSlots),
    outboundModes: modeLines(outboundRows, Math.max(0, calculatedOutbound), outboundSlots)
  };
}