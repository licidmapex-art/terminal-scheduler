/**
 * Fixed-slot replay — recompute inventory, simulation log, and post-run feasibility
 * from an edited slot list without re-booking berths.
 */

import type {
  Customer,
  Resource,
  ScheduledSlot,
  SimulationConfig,
  SimulationOverrides,
  StochasticConfig,
  StochasticEvent,
  TransportPool
} from "../types";
import { runScheduler, type ScheduleResult } from "./scheduler";
import { applySlotTimeAdjustments, sampleSimulationOverrides } from "./stochastic";

export interface ReplaySimulationOptions {
  stochasticConfig?: StochasticConfig;
  seed?: number;
  /** Pre-resolved overrides (skip sampling). */
  simulationOverrides?: SimulationOverrides;
  stochasticEvents?: StochasticEvent[];
  stochasticSeed?: number;
}

export function replaySimulation(
  customers: Customer[],
  resources: Resource[],
  config: SimulationConfig,
  assignedSlots: ScheduledSlot[],
  transportPools: TransportPool[] = [],
  options: ReplaySimulationOptions = {}
): ScheduleResult {
  const baselineSlots = assignedSlots.map((s) => ({
    ...s,
    start: new Date(s.start),
    end: new Date(s.end),
    reservationStart: s.reservationStart ? new Date(s.reservationStart) : null,
    reservationEnd: s.reservationEnd ? new Date(s.reservationEnd) : null
  }));

  let simulationOverrides = options.simulationOverrides;
  let stochasticEvents = options.stochasticEvents;
  let stochasticSeed = options.stochasticSeed;

  const stochCfg = options.stochasticConfig ?? config.stochasticConfig;
  if (!simulationOverrides && stochCfg?.enabled) {
    const sampled = sampleSimulationOverrides(
      baselineSlots,
      customers,
      config,
      stochCfg,
      options.seed
    );
    simulationOverrides = sampled.overrides;
    stochasticEvents = sampled.events;
    stochasticSeed = sampled.seed;
  }

  const effectiveSlots =
    simulationOverrides && simulationOverrides.slotAdjustments.length > 0
      ? applySlotTimeAdjustments(baselineSlots, simulationOverrides.slotAdjustments)
      : baselineSlots;

  return runScheduler(customers, resources, config, transportPools, {
    fixedSlots: effectiveSlots,
    baselineSlots,
    simulationOverrides,
    stochasticEvents,
    stochasticSeed
  });
}
