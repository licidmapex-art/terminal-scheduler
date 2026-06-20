import type {
  Customer,
  Resource,
  ScheduledSlot,
  SimulationConfig,
  StochasticConfig,
  StochasticEventKind,
  TransportPool
} from "../../types";
import type { MonteCarloSnapshot } from "../../lib/simulationRunState";
import type { ScheduleResult } from "../scheduler";
import { replaySimulation } from "../replaySimulation";
import { buildStochasticRunSnapshot } from "../../lib/simulationRunState";
import { randomSeed } from "./prng";
import { pipelineFlowMultiplierSeries } from "../pipelineFlowMultiplier";
import {
  aggregateMonteCarloMetrics,
  type MonteCarloIterationMetrics
} from "./aggregateMonteCarlo";

export const MONTE_CARLO_FULL_RUNS_MAX = 50;

export interface RunMonteCarloOptions {
  iterations: number;
  baseSeed?: number;
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
}

function deriveRunSeed(baseSeed: number, index: number): number {
  return (baseSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0;
}

function terminalSeriesFromResult(result: ScheduleResult, customerIds: string[]): number[] {
  const log = result.simulationLog;
  return log.map((row) => {
    if (row.terminalTotal != null && Number.isFinite(row.terminalTotal)) return row.terminalTotal;
    return customerIds.reduce((s, id) => s + (row.customerInventories[id] ?? 0), 0);
  });
}

function customerSeriesFromResult(result: ScheduleResult, customerIds: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const id of customerIds) {
    out[id] = result.simulationLog.map((row) => row.customerInventories[id] ?? 0);
  }
  return out;
}

function metricsFromResult(
  result: ScheduleResult,
  seed: number,
  customerIds: string[],
  totalStorageCapacity: number
): MonteCarloIterationMetrics {
  const eventKinds: StochasticEventKind[] = [];
  for (const ev of result.stochasticEvents ?? []) {
    eventKinds.push(ev.kind);
  }
  const log = result.simulationLog;
  return {
    seed,
    terminalByHour: terminalSeriesFromResult(result, customerIds),
    customerByHour: customerSeriesFromResult(result, customerIds),
    pipelineInboundByHour: pipelineFlowMultiplierSeries("inbound", log, totalStorageCapacity, true),
    pipelineOutboundByHour: pipelineFlowMultiplierSeries("outbound", log, totalStorageCapacity, true),
    warningKeys: result.feasibilityWarnings.map((w) => w.key),
    eventKinds
  };
}

export interface RunMonteCarloInput {
  workingSlots: ScheduledSlot[];
  customers: Customer[];
  resources: Resource[];
  config: SimulationConfig;
  stochasticConfig: StochasticConfig;
  transportPools?: TransportPool[];
  mergeValidation?: (result: ScheduleResult) => ScheduleResult;
}

export function runSingleStochasticReplay(
  input: RunMonteCarloInput,
  seed: number
): ScheduleResult {
  const { workingSlots, customers, resources, config, stochasticConfig, transportPools = [], mergeValidation } =
    input;
  let result = replaySimulation(customers, resources, config, workingSlots, transportPools, {
    stochasticConfig,
    seed
  });
  if (mergeValidation) result = mergeValidation(result);
  return result;
}

export function runMonteCarlo(
  input: RunMonteCarloInput,
  options: RunMonteCarloOptions
): MonteCarloSnapshot {
  const iterations = Math.max(1, Math.min(200, Math.floor(options.iterations)));
  const baseSeed =
    typeof options.baseSeed === "number" && Number.isFinite(options.baseSeed)
      ? (options.baseSeed >>> 0)
      : randomSeed();
  const customerIds = input.customers.map((c) => c.id);
  const storageCap = input.config.totalStorageCapacity ?? 100_000;
  const runSeeds = Array.from({ length: iterations }, (_, i) => deriveRunSeed(baseSeed, i));
  const iterationMetrics: MonteCarloIterationMetrics[] = [];
  const storeFullRuns = iterations <= MONTE_CARLO_FULL_RUNS_MAX;
  const runs: MonteCarloSnapshot["runs"] = storeFullRuns ? [] : undefined;

  for (let i = 0; i < iterations; i++) {
    if (options.shouldCancel?.()) break;
    const seed = runSeeds[i]!;
    const result = runSingleStochasticReplay(input, seed);
    iterationMetrics.push(metricsFromResult(result, seed, customerIds, storageCap));
    if (storeFullRuns && runs) {
      runs.push(buildStochasticRunSnapshot(input.workingSlots, result));
    }
    options.onProgress?.(i + 1, iterations);
  }

  const effectiveN = iterationMetrics.length;
  const { aggregates, customerSummaries } = aggregateMonteCarloMetrics(iterationMetrics, customerIds);

  return {
    iterations: effectiveN,
    selectedIndex: 0,
    baseSeed,
    runSeeds: runSeeds.slice(0, effectiveN),
    aggregates,
    customerSummaries,
    ...(runs ? { runs } : {})
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Async variant — yields every 5 iterations for UI responsiveness. */
export async function runMonteCarloAsync(
  input: RunMonteCarloInput,
  options: RunMonteCarloOptions
): Promise<MonteCarloSnapshot> {
  const iterations = Math.max(1, Math.min(200, Math.floor(options.iterations)));
  const baseSeed =
    typeof options.baseSeed === "number" && Number.isFinite(options.baseSeed)
      ? (options.baseSeed >>> 0)
      : randomSeed();
  const customerIds = input.customers.map((c) => c.id);
  const storageCap = input.config.totalStorageCapacity ?? 100_000;
  const runSeeds = Array.from({ length: iterations }, (_, i) => deriveRunSeed(baseSeed, i));
  const iterationMetrics: MonteCarloIterationMetrics[] = [];
  const storeFullRuns = iterations <= MONTE_CARLO_FULL_RUNS_MAX;
  const runs: MonteCarloSnapshot["runs"] = storeFullRuns ? [] : undefined;

  for (let i = 0; i < iterations; i++) {
    if (options.shouldCancel?.()) break;
    const seed = runSeeds[i]!;
    const result = runSingleStochasticReplay(input, seed);
    iterationMetrics.push(metricsFromResult(result, seed, customerIds, storageCap));
    if (storeFullRuns && runs) {
      runs.push(buildStochasticRunSnapshot(input.workingSlots, result));
    }
    options.onProgress?.(i + 1, iterations);
    if ((i + 1) % 5 === 0) await yieldToEventLoop();
  }

  const effectiveN = iterationMetrics.length;
  const { aggregates, customerSummaries } = aggregateMonteCarloMetrics(iterationMetrics, customerIds);

  return {
    iterations: effectiveN,
    selectedIndex: 0,
    baseSeed,
    runSeeds: runSeeds.slice(0, effectiveN),
    aggregates,
    customerSummaries,
    ...(runs ? { runs } : {})
  };
}
