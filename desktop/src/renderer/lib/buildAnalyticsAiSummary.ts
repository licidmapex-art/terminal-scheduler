import type { SimulationLogRow } from "../../engine/simulationLog";
import { SCHEDULING_CONSTRAINTS } from "./schedulingConstraints";

export interface AiSummaryCustomer {
  name: string;
  startingInventoryT: number;
  finalInventoryT: number;
  minInventoryT: number;
  maxInventoryT: number;
  daysOfCoverFinalD: number | null;
  inboundTonnes: number;
  outboundTonnes: number;
  inventoryDeltaT: number;
  pipelineFlowPerHourT: number;
  storageSharePct: number;
  throughputTargetT: number;
  throughputScheduledT: number;
  throughputPasses: boolean;
  inboundSlotsScheduled: number;
  inboundSlotsTarget: number;
  outboundSlotsScheduled: number;
  outboundSlotsTarget: number;
  tankBottomHours: number;
  tankTopHours: number;
  refusedAtBottomTonnes: number;
  refusedAtTopTonnes: number;
  partialInboundSlots: number;
  partialOutboundSlots: number;
}

export interface AiSummaryResource {
  name: string;
  type: string;
  slots: number;
  utilizationPct: number;
  hoursOnBerth: number;
}

export interface AiSummaryConstraintTotals {
  [constraintLabel: string]: number;
}

export interface AnalyticsAiSummary {
  simulation: {
    startDate: string;
    endDate: string;
    periodHours: number;
    storageMode: string;
    totalStorageCapacityT: number;
    optimizerRelativeDocMultiplier: number;
    pacerInboundRoundAtDecile: number;
    pacerInboundAllowance: number;
    pacerOutboundRoundAtDecile: number;
    pacerOutboundAllowance: number;
  };
  feasibilityWarnings: string[];
  customers: AiSummaryCustomer[];
  constraintBlockHoursByType: AiSummaryConstraintTotals;
  constraintBlockHoursByCustomer: Record<string, AiSummaryConstraintTotals>;
  resources: AiSummaryResource[];
  totals: {
    scheduledSlots: number;
    customers: number;
    throughputAllPass: boolean;
  };
}

interface InventorySummaryRow {
  customerName: string;
  starting: number;
  final: number;
  min: number;
  max: number;
  daysOfCover: number | null;
  massInbound: number;
  massOutbound: number;
  inventoryDelta: number;
}

interface ThroughputCoverageRow {
  customerName: string;
  expectedInbound: number;
  scheduledInbound: number;
  passes: boolean;
  targetInboundSlots: number;
  targetOutboundSlots: number;
  scheduledInboundSlots: number;
  scheduledOutboundSlots: number;
}

interface TankExtremeRow {
  customerName: string;
  bottomHours: number;
  topHours: number;
  refusedAtBottomTonnes: number;
  refusedAtTopTonnes: number;
}

interface PartialLoadsRow {
  customerName: string;
  partialInboundSlots: number;
  partialOutboundSlots: number;
}

interface ResourceUtilRow {
  resourceName: string;
  resourceType: string;
  totalSlots: number;
  utilizationPct: number;
  totalHoursOccupied: number;
}

interface CustomerLike {
  name: string;
  pipelineFlowPerHour?: number;
  storageShare?: number;
}

interface ConfigLike {
  startDate?: string;
  endDate?: string;
  storageMode?: string;
  totalStorageCapacity?: number;
  optimizerRelativeDocMultiplier?: number;
  pacerInboundRoundAtDecile?: number;
  pacerInboundAllowance?: number;
  pacerOutboundRoundAtDecile?: number;
  pacerOutboundAllowance?: number;
}

function tallyConstraints(simulationLog: SimulationLogRow[]): {
  byType: AiSummaryConstraintTotals;
  byCustomer: Record<string, AiSummaryConstraintTotals>;
} {
  const byType: AiSummaryConstraintTotals = {};
  const byCustomer: Record<string, AiSummaryConstraintTotals> = {};
  for (const def of SCHEDULING_CONSTRAINTS) {
    byType[def.label] = 0;
  }

  for (const row of simulationLog) {
    for (const leg of row.transportStatus ?? []) {
      const key = leg.blockingConstraint;
      if (!key || leg.action !== "idle") continue;
      const label =
        SCHEDULING_CONSTRAINTS.find((d) => d.key === key)?.label ?? key;
      byType[label] = (byType[label] ?? 0) + 1;
      const cust = leg.customerName || leg.customerId;
      if (!byCustomer[cust]) {
        byCustomer[cust] = {};
        for (const def of SCHEDULING_CONSTRAINTS) {
          byCustomer[cust][def.label] = 0;
        }
      }
      byCustomer[cust][label] = (byCustomer[cust][label] ?? 0) + 1;
    }
  }

  return { byType, byCustomer };
}

export function buildAnalyticsAiSummary(input: {
  config: ConfigLike | null;
  periodHours: number;
  customers: CustomerLike[];
  feasibilityWarnings: string[];
  simulationLog: SimulationLogRow[];
  inventorySummary: InventorySummaryRow[];
  throughputCoverage: ThroughputCoverageRow[];
  tankExtremes: TankExtremeRow[];
  partialLoads: PartialLoadsRow[];
  resourceUtilization: ResourceUtilRow[];
  totalSlots: number;
}): AnalyticsAiSummary | null {
  if (!input.config?.startDate || !input.config?.endDate) return null;
  if (input.inventorySummary.length === 0 && input.simulationLog.length === 0) return null;

  const invByName = new Map(input.inventorySummary.map((r) => [r.customerName, r]));
  const throughputByName = new Map(input.throughputCoverage.map((r) => [r.customerName, r]));
  const tankByName = new Map(input.tankExtremes.map((r) => [r.customerName, r]));
  const partialByName = new Map(input.partialLoads.map((r) => [r.customerName, r]));

  const customers: AiSummaryCustomer[] = input.customers.map((c) => {
    const inv = invByName.get(c.name);
    const tp = throughputByName.get(c.name);
    const tank = tankByName.get(c.name);
    const partial = partialByName.get(c.name);
    return {
      name: c.name,
      startingInventoryT: inv?.starting ?? 0,
      finalInventoryT: inv?.final ?? 0,
      minInventoryT: inv?.min ?? 0,
      maxInventoryT: inv?.max ?? 0,
      daysOfCoverFinalD: inv?.daysOfCover ?? null,
      inboundTonnes: inv?.massInbound ?? 0,
      outboundTonnes: inv?.massOutbound ?? 0,
      inventoryDeltaT: inv?.inventoryDelta ?? 0,
      pipelineFlowPerHourT: c.pipelineFlowPerHour ?? 0,
      storageSharePct: c.storageShare ?? 0,
      throughputTargetT: tp?.expectedInbound ?? 0,
      throughputScheduledT: tp?.scheduledInbound ?? 0,
      throughputPasses: tp?.passes ?? true,
      inboundSlotsScheduled: tp?.scheduledInboundSlots ?? 0,
      inboundSlotsTarget: tp?.targetInboundSlots ?? 0,
      outboundSlotsScheduled: tp?.scheduledOutboundSlots ?? 0,
      outboundSlotsTarget: tp?.targetOutboundSlots ?? 0,
      tankBottomHours: tank?.bottomHours ?? 0,
      tankTopHours: tank?.topHours ?? 0,
      refusedAtBottomTonnes: tank?.refusedAtBottomTonnes ?? 0,
      refusedAtTopTonnes: tank?.refusedAtTopTonnes ?? 0,
      partialInboundSlots: partial?.partialInboundSlots ?? 0,
      partialOutboundSlots: partial?.partialOutboundSlots ?? 0
    };
  });

  const { byType, byCustomer } = tallyConstraints(input.simulationLog);

  return {
    simulation: {
      startDate: input.config.startDate,
      endDate: input.config.endDate,
      periodHours: Math.round(input.periodHours * 10) / 10,
      storageMode: input.config.storageMode ?? "fixed_band",
      totalStorageCapacityT: input.config.totalStorageCapacity ?? 100000,
      optimizerRelativeDocMultiplier: input.config.optimizerRelativeDocMultiplier ?? 0,
      pacerInboundRoundAtDecile: input.config.pacerInboundRoundAtDecile ?? 1,
      pacerInboundAllowance: input.config.pacerInboundAllowance ?? 0.5,
      pacerOutboundRoundAtDecile: input.config.pacerOutboundRoundAtDecile ?? 1,
      pacerOutboundAllowance: input.config.pacerOutboundAllowance ?? 0.5
    },
    feasibilityWarnings: input.feasibilityWarnings,
    customers,
    constraintBlockHoursByType: byType,
    constraintBlockHoursByCustomer: byCustomer,
    resources: input.resourceUtilization.map((r) => ({
      name: r.resourceName,
      type: r.resourceType,
      slots: r.totalSlots,
      utilizationPct: r.utilizationPct,
      hoursOnBerth: r.totalHoursOccupied
    })),
    totals: {
      scheduledSlots: input.totalSlots,
      customers: input.customers.length,
      throughputAllPass:
        input.throughputCoverage.length > 0 && input.throughputCoverage.every((r) => r.passes)
    }
  };
}

export function summaryToPromptText(summary: AnalyticsAiSummary, userNotes?: string): string {
  const payload = {
    ...summary,
    notes: userNotes?.trim() || undefined
  };
  return JSON.stringify(payload, null, 2);
}

/** JSON payload plus optional notes for a bespoke question about the same run. */
export function questionToPromptText(
  summary: AnalyticsAiSummary,
  question: string,
  userNotes?: string
): string {
  const payload = {
    ...summary,
    userQuestion: question.trim(),
    notes: userNotes?.trim() || undefined
  };
  return JSON.stringify(payload, null, 2);
}
