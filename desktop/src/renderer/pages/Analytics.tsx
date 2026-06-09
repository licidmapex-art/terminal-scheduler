import { useState, useEffect, useMemo } from "react";
import AiAnalysisPanel from "../components/AiAnalysisPanel";
import { PageTitleWithHelp, HelpPopover } from "../components/HelpPopover";
import { useStore } from "../store";
import type {
  Customer as EngineCustomer,
  SimulationConfig as EngineSimulationConfig,
  ScheduledSlot
} from "../../types";
import type { SimulationLogRow } from "../../engine/simulationLog";
import {
  inboundTargetSlots,
  outboundTargetSlots,
  inboundThroughputTonnes,
  outboundThroughputTonnes,
  customerRepresentativeDaysOfCover
} from "../../engine/customerLegTargets";
import {
  simulationPeriodHoursFloored,
  tallyPipelineTonnesFromSimulationLog,
  tallyRefusedTonnesAtTankExtremes,
  theoreticalInventoryDeltaWithoutTankClamp,
  replaySharedShippingTerminalFlowTotals,
  attributeSharedShippingFlowsForAnalytics
} from "../../engine/inventory";
import { tallyBerthTonnesByCustomerFromSlots } from "../../engine/simulationExcelExport";
import { slotBerthOccupationHours } from "../../engine/slotLaytime";
import { resolveCustomerChartColor } from "../lib/customerChartColor";
import { resolveCustomerPipelineRates } from "../lib/pipelineFlows";
import {
  AVERAGE_CUSTOMER_ID,
  COMBINED_TERMINAL_ID,
  buildDocTrendByCustomer
} from "../lib/timelineChartData";

interface Customer {
  id: string;
  name: string;
  /** Tonnes at simulation start (same seed as scheduler); mass balance uses final minus this. */
  currentInventory?: number;
  pipelineFlowPerHour?: number;
  storageShare?: number;
  declaredInboundThroughput?: number;
  inboundMEPS?: number;
  outboundMEPS?: number;
  inboundMode?: string;
  outboundMode?: string;
  inboundRoundtripHours?: number;
  outboundRoundtripHours?: number;
  chartColor?: string | null;
}

interface Slot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
  end: string;
  status?: string;
}

interface Resource {
  id: string;
  name: string;
  type: string;
}

interface SimulationConfig {
  startDate: string;
  endDate: string;
  pipelineFlowRate?: number;
  pipelineDirection?: string;
  totalStorageCapacity?: number;
  storageMode?: string;
  preOpsHours?: number;
  postOpsHours?: number;
  optimizerRelativeDocMultiplier?: number;
  pacerInboundRoundAtDecile?: number;
  pacerInboundAllowance?: number;
  pacerOutboundRoundAtDecile?: number;
  pacerOutboundAllowance?: number;
}

interface InventoryTimelineResponse {
  timeline: Record<string, number[]>;
  startDate: string | null;
  totalStorageCapacity?: number | null;
}

interface InventorySummaryRow {
  customerId: string;
  customerName: string;
  starting: number;
  final: number;
  min: number;
  max: number;
  /** Engine-aligned composite DoC; null when no pipeline and no transport targets. */
  daysOfCover: number | null;
  /** Pipeline inbound + inbound slot volumes (t) */
  massInbound: number;
  /** Pipeline outbound + outbound slot volumes (t) */
  massOutbound: number;
  /** Final minus starting inventory (t) */
  inventoryDelta: number;
  /** True when massInbound − massOutbound − inventoryDelta ≈ 0 */
  massBalanceOk: boolean;
  massBalanceHint: string;
}

interface ResourceUtilRow {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  totalSlots: number;
  totalHoursOccupied: number;
  /** Mean laytime per visit (pre-ops + loading + post-ops); empty resources use 0. */
  avgHoursPerSlot: number;
  availableHours: number;
  utilizationPct: number;
}

interface ThroughputCoverageRow {
  customerId: string;
  customerName: string;
  /** Declared inbound transport + pipeline inbound (t). */
  expectedInbound: number;
  /** Berth inbound cargo + pipeline inbound delivered (t). */
  scheduledInbound: number;
  berthInboundTonnes: number;
  pipelineInboundTonnes: number;
  declaredInboundTonnes: number;
  delta: number;
  passes: boolean;
  targetInboundSlots: number;
  targetOutboundSlots: number;
  scheduledInboundSlots: number;
  scheduledOutboundSlots: number;
  labelInbound: string;
  labelOutbound: string;
  parcelInMeps: number;
  parcelOutMeps: number;
  parcelAvgInVol: number;
  parcelAvgOutVol: number;
}

function formatTransportMode(mode: string | undefined): string {
  if (mode === "ship") return "Ship";
  if (mode === "barge") return "Barge";
  if (mode === "train") return "Train";
  return "—";
}

function pipelineConfigForAnalytics(direction: string | undefined): EngineSimulationConfig {
  const d = direction === "outbound" ? "outbound" : "inbound";
  const t0 = new Date(0);
  return {
    startDate: t0,
    endDate: t0,
    pipelineFlowRate: 0,
    pipelineDirection: d,
    totalStorageCapacity: 0,
    storageMode: "fixed_band",
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 0,
    tankCapacity: 0
  };
}

interface TankExtremeRow {
  customerId: string;
  customerName: string;
  maxCapacity: number;
  bottomHours: number;
  bottomOccurrences: number;
  topHours: number;
  topOccurrences: number;
  refusedAtBottomTonnes: number;
  refusedAtTopTonnes: number;
}

interface PartialLoadsRow {
  customerId: string;
  customerName: string;
  partialInboundSlots: number;
  partialOutboundSlots: number;
}

/** Hours in a predicate run and number of separate consecutive runs. */
function countRuns(values: number[], predicate: (v: number) => boolean): { hours: number; occurrences: number } {
  let hours = 0;
  let occurrences = 0;
  let inRun = false;
  for (const v of values) {
    const p = predicate(v);
    if (p) {
      hours++;
      if (!inRun) {
        occurrences++;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return { hours, occurrences };
}

function downsampleSeries<T>(series: T[], maxPoints: number): T[] {
  if (series.length <= maxPoints) return series;
  const step = series.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(series[Math.min(series.length - 1, Math.floor(i * step))]!);
  }
  return out;
}

function DocSparkline({
  series,
  width,
  height,
  stroke = "#2563eb"
}: {
  series: Array<number | null>;
  width: number;
  height: number;
  stroke?: string;
}) {
  const finitePoints = series
    .map((v, i) => ({ value: v, index: i }))
    .filter((p): p is { value: number; index: number } => p.value != null && Number.isFinite(p.value));
  if (finitePoints.length < 2) {
    return (
      <span style={{ color: "#94a3b8", fontSize: 12 }}>
        {finitePoints.length === 1 ? finitePoints[0]!.value.toFixed(1) : "—"}
      </span>
    );
  }
  const finiteValues = finitePoints.map((p) => p.value);
  const max = Math.max(...finiteValues, 0.01);
  const min = Math.min(...finiteValues, 0);
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const rng = max - min || 1;
  const segments: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) {
      if (current.length >= 2) segments.push(current.join(" "));
      current = [];
      continue;
    }
    const x = pad + (i / Math.max(series.length - 1, 1)) * w;
    const y = pad + h - ((v - min) / rng) * h;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  if (current.length >= 2) segments.push(current.join(" "));
  return (
    <svg className="sparkline-svg" width={width} height={height} aria-hidden>
      {segments.map((points, idx) => (
        <polyline key={idx} fill="none" stroke={stroke} strokeWidth={1.5} points={points} />
      ))}
    </svg>
  );
}

function UtilBarCell({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  const tier = p >= 80 ? "high" : p >= 50 ? "mid" : "low";
  return (
    <div className="util-bar-track" style={{ width: 140 }}>
      <div className={`util-bar-fill util-bar-fill--${tier}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** @returns 0–100+ for bar (cap display) */
function achievementPct(scheduled: number, expected: number): number {
  if (expected <= 0.5) return scheduled > 0 ? 100 : 100;
  return Math.min(150, (scheduled / expected) * 100);
}

function achievementSlotPct(scheduled: number, target: number): number {
  if (target <= 0.5) return scheduled > 0 ? 100 : 100;
  return Math.min(150, (scheduled / target) * 100);
}

function SlotTargetBar({
  label,
  scheduled,
  target,
  direction = "inbound"
}: {
  label: string;
  scheduled: number;
  target: number;
  direction?: "inbound" | "outbound";
}) {
  const noLeg = target <= 0 && scheduled <= 0;
  const pct = noLeg ? 0 : achievementSlotPct(scheduled, target);
  const ok = pct >= 99;
  return (
    <div style={{ marginTop: label ? 6 : 0 }}>
      {label ? (
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 3 }}>{label}</div>
      ) : null}
      {noLeg ? (
        <span style={{ fontSize: 11, color: "#94a3b8" }}>No slot target</span>
      ) : (
        <div className="throughput-bar-row" style={{ maxWidth: 280 }}>
          <div className="throughput-bar-track">
            <div
              className={`throughput-bar-fill throughput-bar-fill--${direction}${ok ? " throughput-bar-fill--ok" : ""}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <span style={{ fontSize: 11, fontWeight: 600, minWidth: 40, textAlign: "right" }}>
            {Math.round(Math.min(pct, 999))}%
          </span>
        </div>
      )}
    </div>
  );
}

export default function Analytics() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [timelineData, setTimelineData] = useState<InventoryTimelineResponse | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [config, setConfig] = useState<SimulationConfig | null>(null);
  const [feasibilityWarnings, setFeasibilityWarnings] = useState<string[]>([]);
  const [simulationLog, setSimulationLog] = useState<SimulationLogRow[]>([]);
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [custs, inv, s, res, cfg, warnings, log] = await Promise.all([
        window.dbAPI.getCustomers() as Promise<Customer[]>,
        window.schedulerAPI.getInventoryTimeline() as Promise<InventoryTimelineResponse | null>,
        window.schedulerAPI.getSlots() as Promise<Slot[]>,
        window.dbAPI.getResources() as Promise<Resource[]>,
        window.dbAPI.getSimulationConfigs() as Promise<SimulationConfig[]>,
        window.schedulerAPI.getFeasibilityWarnings(),
        window.schedulerAPI.getSimulationLog() as Promise<SimulationLogRow[]>
      ]);
      setCustomers(custs ?? []);
      setTimelineData(inv);
      setSlots(Array.isArray(s) ? s : []);
      setResources(Array.isArray(res) ? res : []);
      const configs = Array.isArray(cfg) ? cfg : [];
      setConfig(configs[0] ?? null);
      setFeasibilityWarnings(Array.isArray(warnings) ? warnings : []);
      setSimulationLog(Array.isArray(log) ? log : []);
    }
    load();
  }, [lastSchedulerRun]);

  const periodHours = useMemo(() => {
    if (!config?.startDate || !config?.endDate) return 0;
    return (new Date(config.endDate).getTime() - new Date(config.startDate).getTime()) / (60 * 60 * 1000);
  }, [config]);

  const pipelineTonnesFromSchedulerLog = useMemo(
    () => tallyPipelineTonnesFromSimulationLog(simulationLog),
    [simulationLog]
  );

  const isSharedShipping = (config?.storageMode ?? "fixed_band") === "shared_shipping";

  const sharedShippingAttributedFlows = useMemo(() => {
    if (!isSharedShipping || !config || customers.length === 0 || !timelineData?.timeline) {
      return null;
    }
    const engineCustomers = customers as unknown as EngineCustomer[];
    const engineCfg = config as unknown as EngineSimulationConfig;
    const totals = replaySharedShippingTerminalFlowTotals(
      engineCustomers,
      engineCfg,
      slots as unknown as ScheduledSlot[]
    );
    const timelines = new Map<string, number[]>();
    for (const [id, series] of Object.entries(timelineData.timeline)) {
      if (Array.isArray(series)) timelines.set(id, series as number[]);
    }
    return attributeSharedShippingFlowsForAnalytics(engineCustomers, timelines, totals);
  }, [isSharedShipping, config, customers, slots, timelineData]);

  /** Uncapped stock motion (fixed_band only); matches pipeline + slot tonnes when flows reconcile. */
  const theoreticalDeltaNoClamp = useMemo(() => {
    if (!config || customers.length === 0) return null;
    const mode = config.storageMode ?? "fixed_band";
    if (mode === "shared_shipping" || mode === "time_shared_storage") return null;
    return theoreticalInventoryDeltaWithoutTankClamp(
      customers as unknown as EngineCustomer[],
      config as unknown as EngineSimulationConfig,
      slots as unknown as ScheduledSlot[]
    );
  }, [config, customers, slots]);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const customerChartOrderIndex = useMemo(() => {
    const m = new Map<string, number>();
    customers.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [customers]);

  const totalStorageCap = useMemo(() => {
    return config?.totalStorageCapacity ?? timelineData?.totalStorageCapacity ?? 100000;
  }, [config, timelineData]);

  const inventorySummary = useMemo((): InventorySummaryRow[] => {
    if (!timelineData?.timeline || !config || Object.keys(timelineData.timeline).length === 0) return [];
    const cfgEngine = config as EngineSimulationConfig;
    const periodFloored = simulationPeriodHoursFloored(cfgEngine);
    const useLogPipeline = simulationLog.some((r) => r.hour > 0);
    const BAL_STOCK_EPS = 1;
    const BAL_FLOW_EPS = 1;
    const rows: InventorySummaryRow[] = [];
    const maxHourInclusive =
      simulationLog.length > 0
        ? Math.max(...simulationLog.map((r) => r.hour))
        : periodFloored;
    const berthByCustomer = isSharedShipping
      ? null
      : tallyBerthTonnesByCustomerFromSlots(
          slots as unknown as ScheduledSlot[],
          cfgEngine,
          maxHourInclusive
        );
    for (const [customerId, values] of Object.entries(timelineData.timeline)) {
      if (!values || values.length === 0) continue;
      const arr = values as number[];
      const customer = customerById.get(customerId);
      const openingStock = Math.round(
        isSharedShipping
          ? (arr[0] ?? customer?.currentInventory ?? 0)
          : (customer?.currentInventory ?? arr[0] ?? 0)
      );
      const starting = openingStock;
      const finalRaw = arr[arr.length - 1] ?? 0;
      const final = Math.round(finalRaw);
      const min = Math.min(...arr.map((x) => Math.round(x)), openingStock);
      const max = Math.max(...arr.map((x) => Math.round(x)), openingStock);
      let daysOfCover: number | null = null;
      if (customer) {
        const raw = customerRepresentativeDaysOfCover(
          final,
          customer as unknown as EngineCustomer,
          cfgEngine,
          periodFloored
        );
        daysOfCover = raw != null ? Math.round(raw * 10) / 10 : null;
      }
      let pipelineInboundVol = 0;
      let pipelineOutboundVol = 0;
      let cargoIn = 0;
      let cargoOut = 0;
      if (isSharedShipping && sharedShippingAttributedFlows) {
        const attr = sharedShippingAttributedFlows.get(customerId);
        pipelineInboundVol = attr?.pipelineInbound ?? 0;
        pipelineOutboundVol = attr?.pipelineOutbound ?? 0;
        cargoIn = attr?.berthInbound ?? 0;
        cargoOut = attr?.berthOutbound ?? 0;
      } else {
        if (useLogPipeline) {
          const p = pipelineTonnesFromSchedulerLog.get(customerId) ?? { inbound: 0, outbound: 0 };
          pipelineInboundVol = p.inbound;
          pipelineOutboundVol = p.outbound;
        } else if (customer) {
          const rates = resolveCustomerPipelineRates(customer as EngineCustomer, cfgEngine);
          pipelineInboundVol = rates.inboundTph * periodFloored;
          pipelineOutboundVol = rates.outboundTph * periodFloored;
        }
        const berth = berthByCustomer?.get(customerId) ?? { inbound: 0, outbound: 0 };
        cargoIn = berth.inbound;
        cargoOut = berth.outbound;
      }
      const massInbound = Math.round(pipelineInboundVol + cargoIn);
      const massOutbound = Math.round(pipelineOutboundVol + cargoOut);
      const inventoryDelta = final - openingStock;
      const flowsNetInt = massInbound - massOutbound;
      const residualVsStock = flowsNetInt - inventoryDelta;
      const theoryDelta = theoreticalDeltaNoClamp?.get(customerId);
      const residualVsTheory =
        theoryDelta !== undefined ? flowsNetInt - Math.round(theoryDelta) : residualVsStock;
      const massBalanceOk =
        Math.abs(residualVsStock) < BAL_STOCK_EPS ||
        (theoryDelta !== undefined && Math.abs(residualVsTheory) < BAL_FLOW_EPS);
      const sm = config.storageMode ?? "fixed_band";
      const massBalanceHint = !massBalanceOk
        ? "Residual exceeds tolerance — shared shipping / time-shared modes use strict stock check only."
        : Math.abs(residualVsStock) < BAL_STOCK_EPS
          ? sm === "shared_shipping"
            ? "Reported Δ inventory matches berth + pipeline tonnes (attributed by storage share)."
            : "Reported Δ inventory matches pipeline + berth tonnes."
          : sm === "shared_inventory"
            ? "Pipeline + berth tonnes tie out; chart reflects pool scaling to terminal cap."
            : "Pipeline + berth tonnes tie out; chart reflects per-customer tank min/max.";
      rows.push({
        customerId,
        customerName: customer?.name ?? customerId,
        starting,
        final,
        min,
        max,
        daysOfCover,
        massInbound,
        massOutbound,
        inventoryDelta,
        massBalanceOk,
        massBalanceHint
      });
    }
    return rows;
  }, [
    timelineData,
    config,
    customerById,
    slots,
    pipelineTonnesFromSchedulerLog,
    simulationLog,
    theoreticalDeltaNoClamp,
    isSharedShipping,
    sharedShippingAttributedFlows
  ]);

  const docTrendByCustomer = useMemo(
    () =>
      buildDocTrendByCustomer(
        simulationLog,
        customers,
        timelineData,
        config as EngineSimulationConfig | null,
        customerById as Map<string, EngineCustomer>
      ),
    [simulationLog, customers, timelineData, config, customerById]
  );

  const aggregateDocFinal = useMemo(() => {
    const pick = (id: string) => {
      const series = docTrendByCustomer[id];
      if (!series?.length) return null;
      const v = series[series.length - 1];
      return v != null && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
    };
    return {
      average: pick(AVERAGE_CUSTOMER_ID),
      combined: pick(COMBINED_TERMINAL_ID)
    };
  }, [docTrendByCustomer]);

  const throughputCoverage = useMemo((): ThroughputCoverageRow[] => {
    if (!config || periodHours <= 0) return [];
    const simCfg = config as EngineSimulationConfig;
    const periodFloored = simulationPeriodHoursFloored(simCfg);
    const useLogPipeline = simulationLog.some((r) => r.hour > 0);
    const EPS = 0.5;
    const rows: ThroughputCoverageRow[] = [];
    for (const c of customers) {
      const engineC = c as EngineCustomer;
      const declaredInboundTonnes = Math.max(0, c.declaredInboundThroughput ?? 0);
      const expectedInbound = inboundThroughputTonnes(engineC, simCfg, periodFloored);
      const custSlots = slots.filter((s) => s.customerId === c.id);
      const outboundSlots = custSlots.filter((s) => s.direction === "outbound");
      const inboundSlots = custSlots.filter((s) => s.direction === "inbound");
      let berthInboundTonnes = inboundSlots.reduce((sum, s) => sum + s.volume, 0);
      let pipelineInboundTonnes = 0;
      if (isSharedShipping && sharedShippingAttributedFlows) {
        const attr = sharedShippingAttributedFlows.get(c.id);
        berthInboundTonnes = attr?.berthInbound ?? 0;
        pipelineInboundTonnes = attr?.pipelineInbound ?? 0;
      } else if (useLogPipeline) {
        pipelineInboundTonnes = pipelineTonnesFromSchedulerLog.get(c.id)?.inbound ?? 0;
      } else {
        pipelineInboundTonnes =
          resolveCustomerPipelineRates(engineC, simCfg).inboundTph * periodFloored;
      }
      const scheduledInbound = berthInboundTonnes + pipelineInboundTonnes;
      const scheduledInboundSlots = inboundSlots.length;
      const scheduledOutboundSlots = outboundSlots.length;
      const targetInboundSlots = inboundTargetSlots(engineC, periodHours);
      const targetOutboundSlots = outboundTargetSlots(engineC, simCfg, periodHours);
      const outboundTonnes = Math.max(0, outboundThroughputTonnes(engineC, simCfg, periodHours));
      const inboundLegConfigured = (c.inboundMEPS ?? 0) > 0 && declaredInboundTonnes > 0;
      const outboundLegConfigured = (c.outboundMEPS ?? 0) > 0 && outboundTonnes > 0;
      const labelInbound = inboundLegConfigured
        ? `Inbound (${formatTransportMode(c.inboundMode)})`
        : "Inbound —";
      const labelOutbound = outboundLegConfigured
        ? `Outbound (${formatTransportMode(c.outboundMode)})`
        : "Outbound —";
      const parcelInMeps = c.inboundMEPS ?? 0;
      const parcelOutMeps = c.outboundMEPS ?? 0;
      const volIn = berthInboundTonnes;
      const volOut = isSharedShipping
        ? (sharedShippingAttributedFlows?.get(c.id)?.berthOutbound ?? 0)
        : outboundSlots.reduce((s, x) => s + x.volume, 0);
      const parcelAvgInVol =
        inboundSlots.length > 0 ? Math.round((volIn / inboundSlots.length) * 10) / 10 : 0;
      const parcelAvgOutVol =
        outboundSlots.length > 0 ? Math.round((volOut / outboundSlots.length) * 10) / 10 : 0;
      const delta = Math.round((scheduledInbound - expectedInbound) * 10) / 10;
      const passes =
        expectedInbound <= EPS ? true : Math.round((scheduledInbound / expectedInbound) * 100) >= 100;
      rows.push({
        customerId: c.id,
        customerName: c.name,
        expectedInbound: Math.round(expectedInbound * 10) / 10,
        scheduledInbound: Math.round(scheduledInbound * 10) / 10,
        berthInboundTonnes: Math.round(berthInboundTonnes * 10) / 10,
        pipelineInboundTonnes: Math.round(pipelineInboundTonnes * 10) / 10,
        declaredInboundTonnes: Math.round(declaredInboundTonnes * 10) / 10,
        delta,
        passes,
        targetInboundSlots,
        targetOutboundSlots,
        scheduledInboundSlots,
        scheduledOutboundSlots,
        labelInbound,
        labelOutbound,
        parcelInMeps,
        parcelOutMeps,
        parcelAvgInVol,
        parcelAvgOutVol
      });
    }
    return rows;
  }, [
    customers,
    config,
    periodHours,
    slots,
    simulationLog,
    pipelineTonnesFromSchedulerLog,
    isSharedShipping,
    sharedShippingAttributedFlows
  ]);

  const tankExtremes = useMemo((): TankExtremeRow[] => {
    if (!timelineData?.timeline) return [];
    const cfgEngine = config as EngineSimulationConfig | null;
    const refusalByCustomer =
      cfgEngine && simulationLog.length > 1
        ? tallyRefusedTonnesAtTankExtremes(
            customers as unknown as EngineCustomer[],
            cfgEngine,
            simulationLog
          )
        : new Map<string, { refusedAtTopTonnes: number; refusedAtBottomTonnes: number }>();
    const rows: TankExtremeRow[] = [];
    for (const c of customers) {
      const share = c.storageShare ?? 0;
      const maxCap = (totalStorageCap * share) / 100;
      const refusal = refusalByCustomer.get(c.id);
      const vals = timelineData.timeline[c.id];
      if (!vals || vals.length === 0) {
        rows.push({
          customerId: c.id,
          customerName: c.name,
          maxCapacity: Math.round(maxCap * 10) / 10,
          bottomHours: 0,
          bottomOccurrences: 0,
          topHours: 0,
          topOccurrences: 0,
          refusedAtBottomTonnes: refusal?.refusedAtBottomTonnes ?? 0,
          refusedAtTopTonnes: refusal?.refusedAtTopTonnes ?? 0
        });
        continue;
      }
      const bottom = countRuns(vals, (v) => v <= 0);
      const top = countRuns(vals, (v) => maxCap > 0 && v >= maxCap);
      rows.push({
        customerId: c.id,
        customerName: c.name,
        maxCapacity: Math.round(maxCap * 10) / 10,
        bottomHours: bottom.hours,
        bottomOccurrences: bottom.occurrences,
        topHours: top.hours,
        topOccurrences: top.occurrences,
        refusedAtBottomTonnes: refusal?.refusedAtBottomTonnes ?? 0,
        refusedAtTopTonnes: refusal?.refusedAtTopTonnes ?? 0
      });
    }
    return rows;
  }, [customers, timelineData, totalStorageCap, config, simulationLog]);

  const partialLoads = useMemo((): PartialLoadsRow[] => {
    const rows: PartialLoadsRow[] = [];
    for (const c of customers) {
      const inboundM = c.inboundMEPS ?? 0;
      const outboundM = c.outboundMEPS ?? 0;
      const custSlots = slots.filter((s) => s.customerId === c.id);
      let partialIn = 0;
      let partialOut = 0;
      for (const s of custSlots) {
        if (s.direction === "inbound" && inboundM > 0 && s.volume < inboundM) partialIn++;
        if (s.direction === "outbound" && outboundM > 0 && s.volume < outboundM) partialOut++;
      }
      rows.push({
        customerId: c.id,
        customerName: c.name,
        partialInboundSlots: partialIn,
        partialOutboundSlots: partialOut
      });
    }
    return rows;
  }, [customers, slots]);

  const partialByCustomerId = useMemo(
    () => new Map(partialLoads.map((r) => [r.customerId, r])),
    [partialLoads]
  );

  const resourceUtilization = useMemo((): ResourceUtilRow[] => {
    const laytimeCfg = config ?? undefined;
    return resources.map((res) => {
      const resSlots = slots.filter((s) => s.resourceId === res.id);
      const totalHoursRaw = resSlots.reduce(
        (acc, s) => acc + slotBerthOccupationHours(s, laytimeCfg ?? {}),
        0
      );
      const n = resSlots.length;
      const avgHoursPerSlot = n > 0 ? Math.round((totalHoursRaw / n) * 10) / 10 : 0;
      return {
        resourceId: res.id,
        resourceName: res.name,
        resourceType: res.type ?? "—",
        totalSlots: n,
        totalHoursOccupied: Math.round(totalHoursRaw * 10) / 10,
        avgHoursPerSlot,
        availableHours: Math.round(periodHours * 10) / 10,
        utilizationPct: periodHours > 0 ? Math.round((totalHoursRaw / periodHours) * 1000) / 10 : 0
      };
    });
  }, [resources, slots, periodHours, config]);

  const hasData = timelineData && Object.keys(timelineData.timeline ?? {}).length > 0;
  const hasRunData = hasData || simulationLog.length > 0;
  const allThroughputPass =
    throughputCoverage.length > 0 && throughputCoverage.every((r) => r.passes);

  return (
    <div>
      <div className="page-header">
        <div>
          <PageTitleWithHelp
            title="Analytics"
            help="Feasibility diagnostics, coverage vs targets, inventory and days-of-cover trends, and berth load"
          />
        </div>
      </div>

      {feasibilityWarnings.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="alert alert-warning" style={{ margin: 0 }}>
            <strong>Feasibility warnings</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
              {feasibilityWarnings.map((w, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {w}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title-row">
          <div className="card-title" style={{ margin: 0 }}>Model checks (KPIs)</div>
          <HelpPopover
            label="Model checks help"
            content="Soft tests against the last scheduler run. Throughput coverage compares required inbound volume (declared transport + pipeline inbound) to scheduled inbound berth cargo plus pipeline delivered."
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="section-heading-row" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Throughput coverage</h3>
            <HelpPopover
              label="Throughput coverage help"
              content={
                <>
                  Target inbound = declared inbound throughput + pipeline inbound (t/h × period). Scheduled inbound =
                  berth cargo + pipeline inbound
                  {isSharedShipping
                    ? " (shared shipping: terminal flows split by storage share, matching the schedule graph inventory)."
                    : " from berth slots + simulation log pipeline (or nominal rate when no log)."}
                </>
              }
            />
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "#64748b" }}>
            Overall:{" "}
            <span className={`badge ${allThroughputPass ? "badge-blue" : "badge-amber"}`}>
              {throughputCoverage.length === 0 ? "—" : allThroughputPass ? "All pass" : "Gaps"}
            </span>
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th style={{ textAlign: "right" }}>Target inbound (t)</th>
                <th style={{ textAlign: "right" }}>Scheduled inbound (t)</th>
                <th style={{ width: 200 }}>Achievement</th>
                <th style={{ textAlign: "right" }}>Delta</th>
                <th style={{ textAlign: "right" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {throughputCoverage.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "#94a3b8", padding: 16 }}>
                    Add customers and simulation dates to evaluate throughput
                  </td>
                </tr>
              ) : (
                throughputCoverage.map((row) => {
                  const ach = achievementPct(row.scheduledInbound, row.expectedInbound);
                  const targetPipelineTonnes = Math.max(
                    0,
                    Math.round((row.expectedInbound - row.declaredInboundTonnes) * 10) / 10
                  );
                  const targetTip =
                    `Declared transport ${row.declaredInboundTonnes.toLocaleString()} t` +
                    ` + pipeline ${targetPipelineTonnes.toLocaleString()} t`;
                  const schedTip =
                    `Berth cargo ${row.berthInboundTonnes.toLocaleString()} t` +
                    ` + pipeline ${row.pipelineInboundTonnes.toLocaleString()} t`;
                  return (
                    <tr key={row.customerId}>
                      <td style={{ fontWeight: 600 }}>{row.customerName}</td>
                      <td style={{ textAlign: "right" }} title={targetTip}>
                        {row.expectedInbound.toLocaleString()}
                      </td>
                      <td style={{ textAlign: "right" }} title={schedTip}>
                        {row.scheduledInbound.toLocaleString()}
                      </td>
                      <td>
                        <div className="throughput-bar-row">
                          <div className="throughput-bar-track">
                            <div
                              className={`throughput-bar-fill throughput-bar-fill--inbound${
                                ach >= 99 ? " throughput-bar-fill--ok" : ""
                              }`}
                              style={{ width: `${Math.min(100, ach)}%` }}
                            />
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: "right" }}>
                            {Math.round(Math.min(ach, 999))}%
                          </span>
                        </div>
                      </td>
                      <td style={{ textAlign: "right" }}>{row.delta.toLocaleString()}</td>
                      <td style={{ textAlign: "right" }}>
                        <span className={`badge ${row.passes ? "badge-blue" : "badge-amber"}`}>
                          {row.passes ? "OK" : "Short"}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="section-heading-row" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Slot details</h3>
            <HelpPopover
              label="Slot details help"
              content={
                <>
                  Slot coverage vs engine targets, average scheduled parcel size (t), and partial loads (volume &lt;
                  MEPS when MEPS &gt; 0). Inbound on the left, outbound on the right.
                  {isSharedShipping
                    ? " Slot counts are per transport leg owner; tonne totals above use storage-share attribution."
                    : ""}
                </>
              }
            />
          </div>
          <table className="data-table analytics-slot-details-table">
            <thead>
              <tr>
                <th rowSpan={2} style={{ width: "14%", verticalAlign: "bottom" }}>
                  Customer
                </th>
                <th colSpan={3} className="analytics-slot-group analytics-slot-group--in">
                  Inbound ↓
                </th>
                <th rowSpan={2} className="analytics-slot-divider" aria-hidden />
                <th colSpan={3} className="analytics-slot-group analytics-slot-group--out">
                  Outbound ↑
                </th>
              </tr>
              <tr>
                <th className="analytics-slot-subhead--in">Transport &amp; coverage</th>
                <th className="analytics-slot-subhead--in" style={{ textAlign: "right", width: "11%" }}>
                  Sched / target
                </th>
                <th className="analytics-slot-subhead--in" style={{ textAlign: "right", width: "12%" }}>
                  Parcel &amp; partials
                </th>
                <th className="analytics-slot-subhead--out">Transport &amp; coverage</th>
                <th className="analytics-slot-subhead--out" style={{ textAlign: "right", width: "11%" }}>
                  Sched / target
                </th>
                <th className="analytics-slot-subhead--out" style={{ textAlign: "right", width: "12%" }}>
                  Parcel &amp; partials
                </th>
              </tr>
            </thead>
            <tbody>
              {throughputCoverage.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "#94a3b8", padding: 16 }}>
                    Add customers and simulation dates to evaluate slots
                  </td>
                </tr>
              ) : (
                throughputCoverage.map((row) => {
                  const partial = partialByCustomerId.get(row.customerId);
                  const partialIn = partial?.partialInboundSlots ?? 0;
                  const partialOut = partial?.partialOutboundSlots ?? 0;
                  const actIn =
                    row.scheduledInboundSlots > 0 ? row.parcelAvgInVol.toLocaleString() : "—";
                  const actOut =
                    row.scheduledOutboundSlots > 0 ? row.parcelAvgOutVol.toLocaleString() : "—";
                  return (
                    <tr key={row.customerId}>
                      <td style={{ fontWeight: 600 }}>{row.customerName}</td>
                      <td className="analytics-slot-cell--in">
                        <div className="analytics-slot-leg-label analytics-slot-leg-label--in">
                          {row.labelInbound}
                        </div>
                        <SlotTargetBar
                          label=""
                          scheduled={row.scheduledInboundSlots}
                          target={row.targetInboundSlots}
                          direction="inbound"
                        />
                      </td>
                      <td
                        className="analytics-slot-cell--in"
                        style={{ textAlign: "right", whiteSpace: "nowrap" }}
                      >
                        {row.scheduledInboundSlots} / {row.targetInboundSlots}
                      </td>
                      <td className="analytics-slot-cell--in" style={{ textAlign: "right" }}>
                        <div className="analytics-slot-meta">
                          <div>
                            Avg <strong>{actIn}</strong> t
                          </div>
                          <div>
                            Partial <strong>{partialIn}</strong>
                          </div>
                        </div>
                      </td>
                      <td className="analytics-slot-divider" aria-hidden />
                      <td className="analytics-slot-cell--out">
                        <div className="analytics-slot-leg-label analytics-slot-leg-label--out">
                          {row.labelOutbound}
                        </div>
                        <SlotTargetBar
                          label=""
                          scheduled={row.scheduledOutboundSlots}
                          target={row.targetOutboundSlots}
                          direction="outbound"
                        />
                      </td>
                      <td
                        className="analytics-slot-cell--out"
                        style={{ textAlign: "right", whiteSpace: "nowrap" }}
                      >
                        {row.scheduledOutboundSlots} / {row.targetOutboundSlots}
                      </td>
                      <td className="analytics-slot-cell--out" style={{ textAlign: "right" }}>
                        <div className="analytics-slot-meta">
                          <div>
                            Avg <strong>{actOut}</strong> t
                          </div>
                          <div>
                            Partial <strong>{partialOut}</strong>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div className="section-heading-row" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Tank bottoms and tank tops</h3>
            <HelpPopover
              label="Tank bottoms and tops help"
              content={
                <>
                  Bottom hours = that customer&apos;s <strong>attributed</strong> inventory at 0 t (not the same as
                  pipeline interruption). Refused at bottom = pipeline tonnes blocked each hour by the engine (terminal
                  physical stock empty and/or customer −x floor) — same rules as the Gantt pipeline row. Top hours =
                  attributed inventory at customer max capacity; refused at top = inbound pipeline blocked when the
                  terminal is full.
                </>
              }
            />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th style={{ textAlign: "right" }}>Max cap (t)</th>
                <th style={{ textAlign: "right" }}>Bottom hours</th>
                <th style={{ textAlign: "right" }}>Bottom #</th>
                <th style={{ textAlign: "right" }}>Refused at bottom (t)</th>
                <th style={{ textAlign: "right" }}>Top hours</th>
                <th style={{ textAlign: "right" }}>Top #</th>
                <th style={{ textAlign: "right" }}>Refused at top (t)</th>
              </tr>
            </thead>
            <tbody>
              {tankExtremes.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", color: "#94a3b8", padding: 16 }}>
                    No customers
                  </td>
                </tr>
              ) : (
                tankExtremes.map((row) => (
                  <tr key={row.customerId}>
                    <td>{row.customerName}</td>
                    <td style={{ textAlign: "right" }}>{row.maxCapacity.toLocaleString()}</td>
                    <td style={{ textAlign: "right" }}>{row.bottomHours}</td>
                    <td style={{ textAlign: "right" }}>{row.bottomOccurrences}</td>
                    <td style={{ textAlign: "right" }}>{row.refusedAtBottomTonnes.toLocaleString()}</td>
                    <td style={{ textAlign: "right" }}>{row.topHours}</td>
                    <td style={{ textAlign: "right" }}>{row.topOccurrences}</td>
                    <td style={{ textAlign: "right" }}>{row.refusedAtTopTonnes.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
            {tankExtremes.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid #e2e8f0", fontWeight: 600 }}>
                  <td>Total</td>
                  <td />
                  <td style={{ textAlign: "right" }}>
                    {tankExtremes.reduce((s, r) => s + r.bottomHours, 0)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {tankExtremes.reduce((s, r) => s + r.bottomOccurrences, 0)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {Math.round(tankExtremes.reduce((s, r) => s + r.refusedAtBottomTonnes, 0)).toLocaleString()}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {tankExtremes.reduce((s, r) => s + r.topHours, 0)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {tankExtremes.reduce((s, r) => s + r.topOccurrences, 0)}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {Math.round(tankExtremes.reduce((s, r) => s + r.refusedAtTopTonnes, 0)).toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title-row">
          <div className="card-title" style={{ margin: 0 }}>Inventory Summary</div>
          <HelpPopover
            label="Inventory summary help"
            content={
              <>
                <strong>DoC final / trend</strong> mirror the scheduler priority ingredients:{" "}
                <strong>inventory ÷ total outbound pressure</strong> and{" "}
                <strong>headroom ÷ total inbound pressure</strong> (t/d each), then the <strong>minimum</strong> when
                both apply. <strong>Combined DoC</strong> applies the same formula to total terminal inventory and summed
                pressures (shown in the inventory table footer when available). <strong>Average DoC</strong> is the mean
                of each customer&apos;s tightest leg — usually different from combined. With no pipeline and no slot
                targets, DoC is unavailable (—). Starting (t) is configured opening stock. Δ inventory and mass balance
                use final minus that opening (not the first timeline point). Inbound/outbound tonnes are pipeline from
                the simulation log (hour 0 pipeline = 0, matching the engine) plus berth cargo summed as tonnes per
                clock hour over the cargo window (same rule as the simulation Excel export). Tonnes are whole numbers.
                Mass OK also allows a no-clamp / no-pool-scale flow replay for fixed_band and shared_inventory.
              </>
            }
          />
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th style={{ textAlign: "right" }}>Starting (t)</th>
              <th style={{ textAlign: "right" }}>Final (t)</th>
              <th style={{ textAlign: "right" }}>Inbound (t)</th>
              <th style={{ textAlign: "right" }}>Outbound (t)</th>
              <th style={{ textAlign: "right" }}>Δ Inventory (t)</th>
              <th style={{ textAlign: "center" }}>Mass OK</th>
              <th style={{ textAlign: "right" }}>Min</th>
              <th style={{ textAlign: "right" }}>Max</th>
              <th style={{ textAlign: "right" }}>DoC final (d)</th>
              <th style={{ minWidth: 108 }}>DoC trend</th>
            </tr>
          </thead>
          <tbody>
            {inventorySummary.length === 0 ? (
              <tr>
                <td colSpan={11} style={{ textAlign: "center", color: "#94a3b8", padding: 24 }}>
                  Run the scheduler first to see inventory data
                </td>
              </tr>
            ) : (
              inventorySummary.map((row) => (
                <tr key={row.customerId}>
                  <td>{row.customerName}</td>
                  <td style={{ textAlign: "right" }}>{row.starting.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{row.final.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{row.massInbound.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{row.massOutbound.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{row.inventoryDelta.toLocaleString()}</td>
                  <td style={{ textAlign: "center" }}>
                    {row.massBalanceOk ? (
                      <span className="badge badge-blue" title={row.massBalanceHint}>
                        ✓
                      </span>
                    ) : (
                      <span className="badge badge-amber" title={row.massBalanceHint}>
                        ✗
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.min.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>{row.max.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>
                    {row.daysOfCover == null ? "—" : row.daysOfCover.toLocaleString()}
                  </td>
                  <td style={{ verticalAlign: "middle" }}>
                    <DocSparkline
                      series={downsampleSeries(docTrendByCustomer[row.customerId] ?? [], 96)}
                      width={104}
                      height={32}
                      stroke={resolveCustomerChartColor(
                        customerById.get(row.customerId)?.chartColor,
                        customerChartOrderIndex.get(row.customerId) ?? 0
                      )}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {(aggregateDocFinal.average != null || aggregateDocFinal.combined != null) && (
            <tfoot>
              <tr style={{ borderTop: "2px solid #e2e8f0", fontWeight: 600 }}>
                <td colSpan={9} style={{ textAlign: "right", color: "#64748b" }}>
                  Terminal aggregates
                </td>
                <td style={{ textAlign: "right" }}>
                  {aggregateDocFinal.combined != null ? (
                    <>
                      Combined {aggregateDocFinal.combined.toLocaleString()} d
                      {aggregateDocFinal.average != null ? (
                        <span style={{ fontWeight: 400, color: "#64748b" }}>
                          {" "}
                          · avg {aggregateDocFinal.average.toLocaleString()} d
                        </span>
                      ) : null}
                    </>
                  ) : aggregateDocFinal.average != null ? (
                    <>Avg {aggregateDocFinal.average.toLocaleString()} d</>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ verticalAlign: "middle" }}>
                  {aggregateDocFinal.combined != null && docTrendByCustomer[COMBINED_TERMINAL_ID] ? (
                    <DocSparkline
                      series={downsampleSeries(docTrendByCustomer[COMBINED_TERMINAL_ID] ?? [], 96)}
                      width={104}
                      height={32}
                      stroke="#0f172a"
                    />
                  ) : aggregateDocFinal.average != null && docTrendByCustomer[AVERAGE_CUSTOMER_ID] ? (
                    <DocSparkline
                      series={downsampleSeries(docTrendByCustomer[AVERAGE_CUSTOMER_ID] ?? [], 96)}
                      width={104}
                      height={32}
                      stroke="#64748b"
                    />
                  ) : null}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="card">
        <div className="card-title-row">
          <div className="card-title" style={{ margin: 0 }}>Resource Utilization</div>
          <HelpPopover
            label="Resource utilization help"
            content="Hours on berth sums each slot's laytime: pre-ops + cargo transfer + post-ops (from simulation config). Avg h / slot is the mean of those laytimes for visits on that resource."
          />
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Resource</th>
              <th>Type</th>
              <th style={{ textAlign: "right" }}>Slots</th>
              <th style={{ textAlign: "right" }}>Hours on berth</th>
              <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Avg h / slot</th>
              <th style={{ textAlign: "right" }}>Hours available</th>
              <th style={{ minWidth: 160 }}>Load</th>
              <th style={{ textAlign: "right" }}>%</th>
            </tr>
          </thead>
          <tbody>
            {resourceUtilization.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", color: "#94a3b8", padding: 24 }}>
                  No resources — add resources in Configuration
                </td>
              </tr>
            ) : (
              resourceUtilization.map((row) => (
                <tr key={row.resourceId}>
                  <td>{row.resourceName}</td>
                  <td>{row.resourceType}</td>
                  <td style={{ textAlign: "right" }}>{row.totalSlots}</td>
                  <td style={{ textAlign: "right" }}>{row.totalHoursOccupied.toLocaleString()}</td>
                  <td style={{ textAlign: "right" }}>
                    {row.totalSlots > 0 ? row.avgHoursPerSlot.toLocaleString() : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.availableHours.toLocaleString()}</td>
                  <td>
                    <UtilBarCell pct={row.utilizationPct} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span
                      className={`badge ${
                        row.utilizationPct >= 80 ? "badge-amber" : row.utilizationPct >= 50 ? "badge-blue" : "badge-gray"
                      }`}
                    >
                      {row.utilizationPct}%
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AiAnalysisPanel
        config={config}
        periodHours={periodHours}
        customers={customers}
        feasibilityWarnings={feasibilityWarnings}
        simulationLog={simulationLog}
        inventorySummary={inventorySummary}
        throughputCoverage={throughputCoverage}
        tankExtremes={tankExtremes}
        partialLoads={partialLoads}
        resourceUtilization={resourceUtilization}
        totalSlots={slots.length}
        hasRunData={!!hasRunData}
      />
    </div>
  );
}
