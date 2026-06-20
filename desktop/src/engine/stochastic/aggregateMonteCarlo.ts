import type {
  MonteCarloAggregates,
  MonteCarloCustomerSummary,
  StochasticEventKind
} from "../../types";
import { percentileSeries } from "./percentile";

export interface MonteCarloIterationMetrics {
  seed: number;
  terminalByHour: number[];
  customerByHour: Record<string, number[]>;
  pipelineInboundByHour: number[];
  pipelineOutboundByHour: number[];
  warningKeys: string[];
  eventKinds: StochasticEventKind[];
}

const EVENT_KINDS: StochasticEventKind[] = [
  "arrival_delay",
  "pipeline_reduction",
  "pipeline_stop",
  "immobilisation"
];

function emptyEventHistogram(): Record<StochasticEventKind, number> {
  return {
    arrival_delay: 0,
    pipeline_reduction: 0,
    pipeline_stop: 0,
    immobilisation: 0
  };
}

export function aggregateMonteCarloMetrics(
  iterations: MonteCarloIterationMetrics[],
  customerIds: string[]
): { aggregates: MonteCarloAggregates; customerSummaries: MonteCarloCustomerSummary[] } {
  const terminalRows = iterations.map((it) => it.terminalByHour);
  const terminalInventory = percentileSeries(terminalRows);

  const customerInventory: MonteCarloAggregates["customerInventory"] = {};
  for (const cid of customerIds) {
    const rows = iterations.map((it) => it.customerByHour[cid] ?? []);
    customerInventory[cid] = percentileSeries(rows);
  }

  const pipelineInbound = percentileSeries(iterations.map((it) => it.pipelineInboundByHour));
  const pipelineOutbound = percentileSeries(iterations.map((it) => it.pipelineOutboundByHour));

  const warningCounts: Record<string, number> = {};
  const eventHistograms = emptyEventHistogram();
  for (const it of iterations) {
    for (const key of it.warningKeys) {
      warningCounts[key] = (warningCounts[key] ?? 0) + 1;
    }
    for (const kind of it.eventKinds) {
      eventHistograms[kind] = (eventHistograms[kind] ?? 0) + 1;
    }
  }

  const n = Math.max(1, iterations.length);
  const customerSummaries: MonteCarloCustomerSummary[] = customerIds.map((customerId) => {
    const allValues: number[] = [];
    let hoursBelowZero = 0;
    let totalHours = 0;
    let iterationsWithWarning = 0;

    for (const it of iterations) {
      const series = it.customerByHour[customerId] ?? [];
      let hadWarning = false;
      for (const w of it.warningKeys) {
        if (w.includes(customerId)) hadWarning = true;
      }
      if (hadWarning) iterationsWithWarning++;

      for (const v of series) {
        allValues.push(v);
        totalHours++;
        if (v < 0) hoursBelowZero++;
      }
    }

    const sorted = [...allValues].sort((a, b) => a - b);
    const sum = allValues.reduce((s, v) => s + v, 0);
    return {
      customerId,
      minInventory: sorted[0] ?? 0,
      meanInventory: allValues.length > 0 ? sum / allValues.length : 0,
      maxInventory: sorted[sorted.length - 1] ?? 0,
      pctHoursBelowZero: totalHours > 0 ? (hoursBelowZero / totalHours) * 100 : 0,
      warningRate: iterationsWithWarning / n
    };
  });

  return {
    aggregates: {
      terminalInventory,
      customerInventory,
      pipelineInbound,
      pipelineOutbound,
      warningCounts,
      eventHistograms
    },
    customerSummaries
  };
}

export { EVENT_KINDS };
