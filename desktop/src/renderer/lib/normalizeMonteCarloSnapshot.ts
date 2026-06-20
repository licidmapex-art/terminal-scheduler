import type { InventoryPercentileSeries, MonteCarloAggregates, StochasticEventKind } from "../../types";
import type { SerializedMonteCarloSnapshot } from "../components/MonteCarloResultsPanel";

function emptyPercentileSeries(): InventoryPercentileSeries {
  return { p10: [], p50: [], p90: [] };
}

function emptyEventHistogram(): Record<StochasticEventKind, number> {
  return {
    arrival_delay: 0,
    pipeline_reduction: 0,
    pipeline_stop: 0,
    immobilisation: 0
  };
}

export function normalizeMonteCarloAggregates(
  aggregates: Partial<MonteCarloAggregates> | null | undefined
): MonteCarloAggregates {
  const empty = emptyPercentileSeries();
  if (!aggregates) {
    return {
      terminalInventory: empty,
      customerInventory: {},
      pipelineInbound: empty,
      pipelineOutbound: empty,
      warningCounts: {},
      eventHistograms: emptyEventHistogram()
    };
  }
  return {
    terminalInventory: aggregates.terminalInventory ?? empty,
    customerInventory: aggregates.customerInventory ?? {},
    pipelineInbound: aggregates.pipelineInbound ?? empty,
    pipelineOutbound: aggregates.pipelineOutbound ?? empty,
    warningCounts: aggregates.warningCounts ?? {},
    eventHistograms: { ...emptyEventHistogram(), ...aggregates.eventHistograms }
  };
}

/** Fill in optional aggregate fields from older Monte Carlo runs. */
export function normalizeMonteCarloSnapshot(
  snapshot: SerializedMonteCarloSnapshot
): SerializedMonteCarloSnapshot {
  return {
    ...snapshot,
    aggregates: normalizeMonteCarloAggregates(snapshot.aggregates)
  };
}
