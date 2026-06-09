import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useLayoutEffect,
  type CSSProperties
} from "react";
import { Loader2, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { setLastSchedulerRun } from "../store";
import { resolveCustomerChartColor } from "../lib/customerChartColor";
import {
  totalInboundPipelineTph,
  totalOutboundPipelineTph
} from "../lib/pipelineFlows";
import {
  buildConstraintHourData,
  buildDocTrendByCustomer,
  buildPacingByCustomerMode,
  buildPacingLegOptions,
  SAMPLE_HOUR_STEP
} from "../lib/timelineChartData";
import {
  SCHEDULING_CONSTRAINTS,
  type BlockingConstraintKey
} from "../lib/schedulingConstraints";
import type { Customer as EngineCustomer, ScheduledSlot, SimulationConfig as EngineSimulationConfig } from "../../types";
import {
  inboundTargetSlots,
  outboundTargetSlots
} from "../../engine/customerLegTargets";
import { ConstraintIcon } from "./ConstraintIcon";
import TimelineChartLegend, { type LegendEntry } from "./TimelineChartLegend";

// Single source of truth for all positioning
const LABEL_WIDTH = 140;
/** Berth / rail rows — 40% shorter than the original 58px layout. */
const RESOURCE_ROW_SCALE = 0.6;
const ROW_HEIGHT = Math.round(58 * RESOURCE_ROW_SCALE);
/** Stacked roundtrip duration bars under each berth row (timeline scale). */
const RT_LEGEND_LINE_H = Math.round(8 * RESOURCE_ROW_SCALE);
const RT_LEGEND_GAP = Math.round(4 * RESOURCE_ROW_SCALE);
const RT_LEGEND_PAD_TOP = Math.round(6 * RESOURCE_ROW_SCALE);
const RT_LEGEND_PAD_BOTTOM = Math.round(4 * RESOURCE_ROW_SCALE);
const SLOT_BAND_MIN_H = Math.round(16 * RESOURCE_ROW_SCALE);
const SLOT_BAND_MIN_H_RT = Math.round(13 * RESOURCE_ROW_SCALE);
const HOUR_MS = 60 * 60 * 1000;
const CHART_HEIGHT = 260;
const INV_Y_AXIS_STEP_T = 5000;
const PIPELINE_ROW_H = 28;
/** Constraint band — taller than berth rows for readable hourly stacks. */
const CONSTRAINT_ROW_H = 80;
const CHART_END_PAD_PX = 16;
const INV_PLOT_PAD_TOP = 10;
const INV_PLOT_PAD_BOTTOM = 10;
const HEADER_HEIGHT = 32;
const AXIS_WIDTH = 60;
const OVERLAY_AXIS_WIDTH = 44;
const MIN_PIXELS_PER_DAY = 3;
const MAX_PIXELS_PER_DAY = 300;
const DEFAULT_PIXELS_PER_DAY = 20;
/** Visual floor only — keeps sub-pixel slots hoverable without distorting duration when zoomed out. */
const SLOT_MIN_WIDTH_PX = 2;
const ONE_DAY_MS = 1000 * 60 * 60 * 24;
/** Delay before hiding slot tooltip so the cursor can reach the fixed panel without clearing hover. */
const SLOT_TOOLTIP_LEAVE_MS = 400;

function formatDDMMYYYY(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseSlotDirection(d: string): "inbound" | "outbound" | null {
  const x = String(d).toLowerCase().trim();
  if (x === "inbound") return "inbound";
  if (x === "outbound") return "outbound";
  return null;
}

function generateMonthMarkers(startDate: Date, endDate: Date, pixelsPerDay: number) {
  const markers: Array<{ x: number; label: string; key: string }> = [];
  const simStart = startDate.getTime();
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const end = new Date(endDate);

  while (current.getTime() <= end.getTime()) {
    const dayOffset = (current.getTime() - simStart) / ONE_DAY_MS;
    const x = dayOffset * pixelsPerDay;
    const label = current.toLocaleDateString("en-GB", { month: "short" });
    markers.push({ x, label, key: `${current.getFullYear()}-${current.getMonth()}` });
    current.setMonth(current.getMonth() + 1);
  }

  return markers;
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
  status: string;
  conflictReason: string | null;
}

interface Resource {
  id: string;
  name: string;
  type: string;
}

interface Customer {
  id: string;
  name: string;
  declaredInboundThroughput?: number;
  pipelineFlowPerHour?: number;
  inboundMEPS?: number;
  outboundMEPS?: number;
  inboundRoundtripHours?: number;
  outboundRoundtripHours?: number;
  timeSharedMinBand?: number;
  timeSharedDuration?: number;
  chartColor?: string | null;
}

interface SimulationConfig {
  startDate: string;
  endDate: string;
  totalStorageCapacity?: number;
  pipelineFlowRate?: number;
  pipelineDirection?: string;
  storageMode?: string;
}

interface SimTransportStatus {
  customerId?: string;
  direction?: string;
  mode?: string;
  action?: string;
  slotId?: string;
  resourceName?: string;
}

interface SimLogRow {
  hour: number;
  customerInventories?: Record<string, number>;
  /** Matches Simulation Log / scheduler snapshots; prefer for Gantt when log is hour-aligned. */
  terminalTotal?: number;
  transportStatus?: SimTransportStatus[];
}

/** Log rows indexed 0..n with row.hour === index — same grid as timeline / IPC inventory. */
function simulationLogIsHourAligned(log: SimLogRow[]): boolean {
  if (log.length === 0) return false;
  for (let i = 0; i < log.length; i++) {
    const hv = Number(log[i]?.hour);
    if (!Number.isFinite(hv) || Math.round(hv) !== i) return false;
  }
  return true;
}

/** First ~3 weeks sampled every hour so opening stock and pipeline drift stay visible when zoomed out (6h-only samples looked like “no data” until first berth activity). */
const INVENTORY_DENSE_HOURS = 21 * 24;

function collectImportantInventoryHours(
  maxHours: number,
  slots: Slot[],
  simStart: number,
  customerId: string | null
): number[] {
  const set = new Set<number>();
  const denseUntil = Math.min(maxHours, INVENTORY_DENSE_HOURS);
  for (let h = 0; h < denseUntil; h++) set.add(h);
  for (let h = denseUntil; h < maxHours; h += 6) set.add(h);
  for (const slot of slots) {
    if (customerId !== null && slot.customerId !== customerId) continue;
    const startHour = Math.round((new Date(slot.start).getTime() - simStart) / HOUR_MS);
    const endHour = Math.round((new Date(slot.end).getTime() - simStart) / HOUR_MS);
    if (startHour > 0) set.add(startHour - 1);
    set.add(startHour);
    set.add(endHour);
    if (endHour + 1 < maxHours) set.add(endHour + 1);
  }
  set.add(0);
  if (maxHours > 0) set.add(maxHours - 1);
  return Array.from(set)
    .filter((h) => h >= 0 && h < maxHours)
    .sort((a, b) => a - b);
}

function rgbaFromHex(hex: string, alpha: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return `rgba(100,116,139,${alpha})`;
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}

function invY(value: number, lo: number, hi: number): number {
  const span = hi - lo || 1;
  const t = (value - lo) / span;
  const plotH = CHART_HEIGHT - INV_PLOT_PAD_TOP - INV_PLOT_PAD_BOTTOM;
  return (
    CHART_HEIGHT -
    INV_PLOT_PAD_BOTTOM -
    Math.max(0, Math.min(1, t)) * plotH
  );
}

function overlayY(value: number, lo: number, hi: number): number {
  return invY(value, lo, hi);
}

/** ~1–2–5 × 10^n step for readable ticks */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const f = rough / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

/** Linear scale — label `top` must use invY(v) (not equal flex gaps). */
function buildInventoryAxisTicks(lo: number, hi: number): number[] {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo];
  const span = hi - lo;
  const step = niceStep(span / 4);
  const ticks: number[] = [];
  let v = Math.floor(lo / step) * step;
  while (v < lo - 1e-9) v += step;
  for (; v <= hi + step * 1e-9; v += step) ticks.push(v);
  if (ticks.length === 0 || ticks[0]! > lo + 1e-6) ticks.unshift(lo);
  if (ticks[ticks.length - 1]! < hi - 1e-6) ticks.push(hi);
  if (lo < -1e-9 && hi > 1e-9 && !ticks.some((t) => Math.abs(t) < step * 0.02)) ticks.push(0);
  return [...new Set(ticks.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b);
}

/** Match scheduler deriveLegs target slot counts for pace hint. */
function legTargetSlots(
  c: Customer,
  direction: "inbound" | "outbound",
  config: SimulationConfig,
  periodHours: number
): number {
  const engineC = c as EngineCustomer;
  const engineCfg = config as EngineSimulationConfig;
  return direction === "inbound"
    ? inboundTargetSlots(engineC, periodHours)
    : outboundTargetSlots(engineC, engineCfg, periodHours);
}

function slotStartHour(slot: Slot, simStartMs: number): number {
  return Math.round((new Date(slot.start).getTime() - simStartMs) / HOUR_MS);
}

function slotEndHour(slot: Slot, simStartMs: number): number {
  return Math.round((new Date(slot.end).getTime() - simStartMs) / HOUR_MS);
}

/** Counts starts for same leg with start hour index <= h (matches scheduler loadsStartedByHour). */
function loadsStartedThroughHour(
  h: number,
  legSlot: Slot,
  allSlots: Slot[],
  simStartMs: number
): number {
  if (h < 0) return 0;
  return allSlots.filter((s) => {
    if (s.customerId !== legSlot.customerId || s.direction !== legSlot.direction || s.mode !== legSlot.mode)
      return false;
    const sh = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);
    return sh <= h;
  }).length;
}

interface InventoryTimelineResponse {
  timeline: Record<string, number[]>;
  startDate: string | null;
  totalStorageCapacity?: number | null;
}

export default function GanttChart() {
  const navigate = useNavigate();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [timelineData, setTimelineData] = useState<InventoryTimelineResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [hoverSlot, setHoverSlot] = useState<Slot | null>(null);
  const [invChartTooltip, setInvChartTooltip] = useState<{
    hourIndex: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const hoverClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [config, setConfig] = useState<SimulationConfig | null>(null);
  const [simulationLog, setSimulationLog] = useState<SimLogRow[]>([]);
  const [feasibilityWarnings, setFeasibilityWarnings] = useState<string[]>([]);
  const [pixelsPerDay, setPixelsPerDay] = useState(DEFAULT_PIXELS_PER_DAY);
  const [showInventory, setShowInventory] = useState(true);
  const [showRoundtrip, setShowRoundtrip] = useState(true);
  const [showTimeshared, setShowTimeshared] = useState(true);
  const [showStorageCapLine, setShowStorageCapLine] = useState(true);
  const [showDoc, setShowDoc] = useState(false);
  const [showPacing, setShowPacing] = useState(false);
  const [showConstraints, setShowConstraints] = useState(false);
  const [enabledConstraints, setEnabledConstraints] = useState<Set<BlockingConstraintKey>>(
    () => new Set(SCHEDULING_CONSTRAINTS.map((c) => c.key))
  );
  const [enabledCustomers, setEnabledCustomers] = useState<Set<string>>(() => new Set());
  const [selectedPacingLeg, setSelectedPacingLeg] = useState<string | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportClientW, setViewportClientW] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const feasibilityWarningsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;

    const loadData = async () => {
      if (!window.schedulerAPI || !window.dbAPI) return;
      try {
        const [r, c, cfg] = await Promise.all([
          window.dbAPI.getResources(),
          window.dbAPI.getCustomers(),
          window.dbAPI.getSimulationConfigs()
        ]);
        if (!mounted) return;
        setResources(Array.isArray(r) ? r : []);
        setCustomers(Array.isArray(c) ? c : []);
        const configs = Array.isArray(cfg) ? cfg : [];
        setConfig(configs[0] ?? null);
      } catch {
        if (mounted) {
          setResources([]);
          setCustomers([]);
          setConfig(null);
        }
      }
    };

    loadData();
    return () => { mounted = false; };
  }, []);

  const cancelPendingHoverClear = useCallback(() => {
    if (hoverClearTimeoutRef.current !== null) {
      clearTimeout(hoverClearTimeoutRef.current);
      hoverClearTimeoutRef.current = null;
    }
  }, []);

  const scheduleHoverClear = useCallback(() => {
    cancelPendingHoverClear();
    hoverClearTimeoutRef.current = setTimeout(() => {
      hoverClearTimeoutRef.current = null;
      setHoverSlot(null);
    }, SLOT_TOOLTIP_LEAVE_MS);
  }, [cancelPendingHoverClear]);

  useEffect(() => () => cancelPendingHoverClear(), [cancelPendingHoverClear]);

  // Restore slots / timeline / log when returning to this tab (state resets on unmount).
  useEffect(() => {
    let mounted = true;

    const hydrateFromScheduler = async () => {
      if (!window.schedulerAPI) return;
      try {
        const [slotsRes, inv, sim, warn] = await Promise.all([
          window.schedulerAPI.getSlots(),
          window.schedulerAPI.getInventoryTimeline(),
          window.schedulerAPI.getSimulationLog(),
          window.schedulerAPI.getFeasibilityWarnings()
        ]);
        if (!mounted) return;
        const slotList = (slotsRes as Slot[]) ?? [];
        setSlots(slotList);
        setTimelineData((inv as InventoryTimelineResponse | null) ?? null);
        const logArr = Array.isArray(sim) ? (sim as SimLogRow[]) : [];
        setSimulationLog(logArr);
        setFeasibilityWarnings(Array.isArray(warn) ? warn : []);
        setHasRun(slotList.length > 0 || logArr.length > 0);
      } catch {
        if (mounted) {
          setSlots([]);
          setTimelineData(null);
          setSimulationLog([]);
          setFeasibilityWarnings([]);
          setHasRun(false);
        }
      }
    };

    hydrateFromScheduler();
    return () => { mounted = false; };
  }, []);

  const handleRunScheduler = async () => {
    if (!window.schedulerAPI || !window.dbAPI) return;
    setIsRunning(true);
    try {
      const runResult = await window.schedulerAPI.run();
      const [slotsRes, inv, sim] = await Promise.all([
        window.schedulerAPI.getSlots(),
        window.schedulerAPI.getInventoryTimeline(),
        window.schedulerAPI.getSimulationLog()
      ]);
      setSlots(slotsRes as Slot[]);
      setTimelineData(inv as InventoryTimelineResponse | null);
      setSimulationLog(Array.isArray(sim) ? (sim as SimLogRow[]) : []);
      const fw = runResult?.feasibilityWarnings;
      const warnList = Array.isArray(fw) ? fw : [];
      setFeasibilityWarnings(warnList);
      setHasRun(true);
      setLastSchedulerRun();
      if (warnList.length > 0) {
        setTimeout(() => {
          feasibilityWarningsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 0);
      }
    } finally {
      setIsRunning(false);
    }
  };

  const applyWheelZoom = useCallback(
    (clientX: number, deltaY: number) => {
      const container = scrollRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const cursorXInView = clientX - rect.left;
      const cursorXInContent = cursorXInView + container.scrollLeft;
      const dayAtCursor = cursorXInContent / pixelsPerDay;

      const factor = deltaY < 0 ? 1.25 : 0.8;
      const newPPD = Math.max(MIN_PIXELS_PER_DAY, Math.min(MAX_PIXELS_PER_DAY, pixelsPerDay * factor));

      setPixelsPerDay(newPPD);

      requestAnimationFrame(() => {
        if (!scrollRef.current) return;
        const newCursorXInContent = dayAtCursor * newPPD;
        scrollRef.current.scrollLeft = newCursorXInContent - cursorXInView;
        setScrollLeft(scrollRef.current.scrollLeft);
      });
    },
    [pixelsPerDay]
  );

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    applyWheelZoom(e.clientX, e.deltaY);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      applyWheelZoom(e.clientX, e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyWheelZoom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollLeft(el.scrollLeft);
    setViewportClientW(el.clientWidth);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportClientW(el.clientWidth));
    ro.observe(el);
    setViewportClientW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cfg = config ?? {
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 365 * ONE_DAY_MS).toISOString(),
    pipelineFlowRate: 0,
    pipelineDirection: "inbound",
    totalStorageCapacity: 100000,
    storageMode: "fixed_band"
  };
  const simStart = new Date(cfg.startDate).getTime();
  const terminalStorageCap = cfg.totalStorageCapacity ?? timelineData?.totalStorageCapacity ?? 100000;
  const periodHoursSafe = Math.max(
    (new Date(cfg.endDate).getTime() - new Date(cfg.startDate).getTime()) / HOUR_MS,
    1
  );

  const dayOffset = useCallback(
    (date: Date | string) => (new Date(date).getTime() - simStart) / ONE_DAY_MS,
    [simStart]
  );

  const totalDays = dayOffset(new Date(cfg.endDate));

  const syncScrollFromMinimapClientX = useCallback(
    (clientX: number) => {
      const minimap = minimapRef.current;
      if (!minimap || !scrollRef.current) return;
      const rect = minimap.getBoundingClientRect();
      const clickPct = (clientX - rect.left) / rect.width;
      const targetDay = clickPct * totalDays;
      scrollRef.current.scrollLeft = targetDay * pixelsPerDay - scrollRef.current.clientWidth / 2;
      setScrollLeft(scrollRef.current.scrollLeft);
    },
    [pixelsPerDay, totalDays]
  );

  const handleMinimapMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    syncScrollFromMinimapClientX(e.clientX);
    const onMove = (ev: MouseEvent) => syncScrollFromMinimapClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const viewportStart = scrollLeft / pixelsPerDay;
  const viewportWidth =
    viewportClientW > 0 ? viewportClientW / pixelsPerDay : 30;

  const slotX = useCallback((date: Date | string) => dayOffset(date) * pixelsPerDay, [dayOffset, pixelsPerDay]);
  const slotWidth = useCallback(
    (start: Date | string, end: Date | string) =>
      Math.max(SLOT_MIN_WIDTH_PX, (dayOffset(end) - dayOffset(start)) * pixelsPerDay),
    [dayOffset, pixelsPerDay]
  );
  /** Timeline width from sim start→end (pixels); do not stretch to viewport when zoomed out. */
  const totalWidth = dayOffset(new Date(cfg.endDate)) * pixelsPerDay + CHART_END_PAD_PX;
  const contentWidth = Math.max(totalWidth, 1);

  const resourceRows = useMemo(() => {
    const berths = resources
      .filter((r) => r?.type?.startsWith?.("berth"))
      .sort((a, b) =>
        a.type === "berth_large" && b.type !== "berth_large" ? -1 : a.type !== "berth_large" && b.type === "berth_large" ? 1 : 0
      );
    const rails = resources.filter((r) => r?.type === "rail_siding");
    return [...berths, ...rails];
  }, [resources]);

  const monthMarkers = useMemo(
    () => generateMonthMarkers(new Date(cfg.startDate), new Date(cfg.endDate), pixelsPerDay),
    [cfg.startDate, cfg.endDate, pixelsPerDay]
  );

  const customerColorMap = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const slot of slots) {
      if (slot && !seen.has(slot.customerId)) {
        seen.add(slot.customerId);
        ids.push(slot.customerId);
      }
    }
    const fromTimeline = timelineData?.timeline ? Object.keys(timelineData.timeline) : [];
    for (const id of fromTimeline) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const map = new Map<string, string>();
    ids.forEach((id, i) => {
      const listIdx = customers.findIndex((c) => c.id === id);
      const cust = listIdx >= 0 ? customers[listIdx] : undefined;
      map.set(
        id,
        resolveCustomerChartColor(cust?.chartColor, listIdx >= 0 ? listIdx : i)
      );
    });
    return map;
  }, [slots, timelineData, customers]);

  const customerColor = (id: string) => customerColorMap.get(id) ?? "#64748b";

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  useEffect(() => {
    if (customers.length === 0) return;
    setEnabledCustomers((prev) => {
      if (prev.size === 0) return new Set(customers.map((c) => c.id));
      const next = new Set<string>();
      for (const c of customers) {
        if (prev.has(c.id)) next.add(c.id);
      }
      if (next.size === 0) return new Set(customers.map((c) => c.id));
      return next;
    });
  }, [customers]);

  const pipeDir = (cfg.pipelineDirection ?? "inbound") as "inbound" | "outbound";

  const hasRoundtripConfig = useMemo(
    () =>
      customers.some(
        (c) => (c.inboundRoundtripHours ?? 0) > 0 || (c.outboundRoundtripHours ?? 0) > 0
      ),
    [customers]
  );

  const hasTimeShareConfig = (cfg.storageMode ?? "fixed_band") === "time_shared_storage";

  const hasStorageCapConfig = terminalStorageCap > 0;

  const inboundPipelineTph = useMemo(
    () => totalInboundPipelineTph(customers, pipeDir),
    [customers, pipeDir]
  );

  const outboundPipelineTph = useMemo(
    () => totalOutboundPipelineTph(customers, pipeDir),
    [customers, pipeDir]
  );

  const docTrendByCustomer = useMemo(
    () =>
      buildDocTrendByCustomer(
        simulationLog as unknown as import("../../engine/simulationLog").SimulationLogRow[],
        customers,
        timelineData,
        cfg as EngineSimulationConfig,
        customerById as Map<string, EngineCustomer>
      ),
    [simulationLog, customers, timelineData, cfg, customerById]
  );

  const pacingByCustomerMode = useMemo(
    () =>
      buildPacingByCustomerMode(
        customers as EngineCustomer[],
        cfg as EngineSimulationConfig,
        periodHoursSafe,
        slots as unknown as ScheduledSlot[],
        simulationLog as unknown as import("../../engine/simulationLog").SimulationLogRow[]
      ),
    [customers, cfg, periodHoursSafe, slots, simulationLog]
  );

  const pacingLegOptions = useMemo(
    () => buildPacingLegOptions(customers, pacingByCustomerMode),
    [customers, pacingByCustomerMode]
  );

  const hasPacingConfig = pacingLegOptions.length > 0;

  const hasDocConfig =
    simulationLog.length > 0 && Object.keys(docTrendByCustomer).length > 0;

  useEffect(() => {
    if (!hasPacingConfig) {
      setSelectedPacingLeg(null);
      return;
    }
    setSelectedPacingLeg((prev) => {
      if (prev && pacingLegOptions.some((o) => o.key === prev)) return prev;
      return pacingLegOptions[0]?.key ?? null;
    });
  }, [hasPacingConfig, pacingLegOptions]);

  const constraintData = useMemo(
    () =>
      buildConstraintHourData(
        simulationLog as unknown as import("../../engine/simulationLog").SimulationLogRow[],
        enabledCustomers
      ),
    [simulationLog, enabledCustomers]
  );

  const hasConstraintData = constraintData.activeConstraintKeys.length > 0;

  useEffect(() => {
    if (!hasConstraintData) return;
    setEnabledConstraints((prev) => {
      const active = new Set(constraintData.activeConstraintKeys);
      const next = new Set<BlockingConstraintKey>();
      for (const key of prev) {
        if (active.has(key)) next.add(key);
      }
      if (next.size === 0) return active;
      return next;
    });
  }, [hasConstraintData, constraintData.activeConstraintKeys]);

  const toggleCustomer = useCallback((id: string) => {
    setEnabledCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleConstraint = useCallback((key: BlockingConstraintKey) => {
    setEnabledConstraints((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  /**
   * Per berth: one bar per scheduled slot with roundtrip > 0 at that slot’s start.
   * `lane` is per customer so multiple visits sit on one row (side by side in time), not stacked vertically.
   */
  const berthRoundtripLegendsByResource = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        slotId: string;
        customerId: string;
        direction: "inbound" | "outbound";
        hours: number;
        anchorStartMs: number;
        lane: number;
      }>
    >();
    const berths = resources.filter((r) => r?.type?.startsWith?.("berth"));
    for (const r of berths) {
      const raw: Array<{
        slotId: string;
        customerId: string;
        direction: "inbound" | "outbound";
        hours: number;
        anchorStartMs: number;
      }> = [];
      for (const slot of slots) {
        if (slot.resourceId !== r.id) continue;
        const dir = parseSlotDirection(slot.direction as string);
        if (!dir) continue;
        const c = customerById.get(slot.customerId);
        const h =
          dir === "inbound"
            ? c?.inboundRoundtripHours ?? 0
            : c?.outboundRoundtripHours ?? 0;
        if (h <= 0) continue;
        raw.push({
          slotId: slot.id,
          customerId: slot.customerId,
          direction: dir,
          hours: h,
          anchorStartMs: new Date(slot.start).getTime()
        });
      }
      raw.sort((a, b) => {
        const dt = a.anchorStartMs - b.anchorStartMs;
        if (dt !== 0) return dt;
        return a.slotId.localeCompare(b.slotId);
      });
      if (raw.length === 0) continue;
      const uniqCustomers = [...new Set(raw.map((e) => e.customerId))];
      uniqCustomers.sort((a, b) => {
        const na = customerById.get(a)?.name ?? a;
        const nb = customerById.get(b)?.name ?? b;
        return na.localeCompare(nb);
      });
      const laneByCustomer = new Map(uniqCustomers.map((id, i) => [id, i]));
      const entries = raw.map((e) => ({
        ...e,
        lane: laneByCustomer.get(e.customerId) ?? 0
      }));
      map.set(r.id, entries);
    }
    return map;
  }, [resources, slots, customerById]);

  const berthLegendExtraHeight = (resourceId: string) => {
    if (!showRoundtrip) return 0;
    const leg = berthRoundtripLegendsByResource.get(resourceId);
    if (!leg?.length) return 0;
    const nLanes = new Set(leg.map((e) => e.customerId)).size;
    return (
      RT_LEGEND_PAD_BOTTOM +
      RT_LEGEND_PAD_TOP +
      nLanes * (RT_LEGEND_LINE_H + RT_LEGEND_GAP) -
      RT_LEGEND_GAP
    );
  };

  const ganttRowHeight = (r: Resource) =>
    ROW_HEIGHT + (r.type?.startsWith("berth") ? berthLegendExtraHeight(r.id) : 0);

  const slotLoadHourMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of simulationLog) {
      for (const ts of row.transportStatus ?? []) {
        if (ts.slotId && ts.action === "loaded") {
          m.set(ts.slotId, row.hour);
        }
      }
    }
    return m;
  }, [simulationLog]);

  const slotsForResource = (resourceId: string) => slots.filter((s) => s.resourceId === resourceId);

  /** Prefer simulation log customer inventories / terminalTotal so Gantt matches Simulation Log UI. */
  const ganttInventorySeries = useMemo(() => {
    if (!timelineData?.timeline || Object.keys(timelineData.timeline).length === 0) {
      return {
        byCustomer: new Map<string, number[]>(),
        terminalByHour: [] as number[],
        maxHours: 0
      };
    }
    const ids = Object.keys(timelineData.timeline);
    const fromTimelineLen = Math.max(...ids.map((id) => timelineData.timeline[id]?.length ?? 0));
    if (
      simulationLog.length > 0 &&
      simulationLogIsHourAligned(simulationLog) &&
      fromTimelineLen > 0 &&
      simulationLog.length === fromTimelineLen
    ) {
      const byCustomer = new Map<string, number[]>();
      for (const id of ids) {
        byCustomer.set(
          id,
          simulationLog.map((row) => row.customerInventories?.[id] ?? 0)
        );
      }
      const terminalByHour = simulationLog.map((row) => {
        if (row.terminalTotal != null && Number.isFinite(row.terminalTotal)) return row.terminalTotal;
        return ids.reduce((s, id) => s + (row.customerInventories?.[id] ?? 0), 0);
      });
      return { byCustomer, terminalByHour, maxHours: simulationLog.length };
    }
    const byCustomer = new Map<string, number[]>();
    for (const id of ids) {
      byCustomer.set(id, timelineData.timeline[id] ? [...timelineData.timeline[id]!] : []);
    }
    const maxHours = fromTimelineLen;
    const terminalByHour = new Array<number>(maxHours).fill(0);
    for (const id of ids) {
      const arr = byCustomer.get(id);
      if (!arr) continue;
      for (let h = 0; h < arr.length; h++) terminalByHour[h] += arr[h] ?? 0;
    }
    return { byCustomer, terminalByHour, maxHours };
  }, [timelineData, simulationLog]);

  /** Y-axis = strict min/max over terminal inventory (all hours) and every customer's inventory (all hours). */
  const ganttInvYAxis = useMemo(() => {
    const { byCustomer, terminalByHour } = ganttInventorySeries;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const arr of byCustomer.values()) {
      for (const v of arr) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    for (const t of terminalByHour) {
      if (t < minV) minV = t;
      if (t > maxV) maxV = t;
    }
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
      return { lo: 0, hi: 1, maxHours: ganttInventorySeries.maxHours };
    }
    if (maxV === minV) maxV = minV + 1;
    const step = INV_Y_AXIS_STEP_T;
    let lo = Math.min(0, Math.floor(minV / step) * step);
    let hi = Math.max(0, Math.ceil(maxV / step) * step);
    if (hi <= lo) hi = lo + step;
    return { lo, hi, maxHours: ganttInventorySeries.maxHours };
  }, [ganttInventorySeries]);

  const hoverSlotMeta = useMemo(() => {
    if (!hoverSlot) return null;
    const c = customerById.get(hoverSlot.customerId);
    const dir = hoverSlot.direction as "inbound" | "outbound";
    const H = slotStartHour(hoverSlot, simStart);
    const series = ganttInventorySeries.byCustomer.get(hoverSlot.customerId);
    const invAtStart =
      series && series.length > 0 ? series[Math.max(0, Math.min(series.length - 1, H))] ?? null : null;
    const dailyPipe = (c?.pipelineFlowPerHour ?? 0) * 24;
    const doc =
      invAtStart != null && dailyPipe > 0 ? Math.round((invAtStart / dailyPipe) * 10) / 10 : null;
    const target = c ? legTargetSlots(c, dir, cfg, periodHoursSafe) : 0;
    const nThroughPrev = loadsStartedThroughHour(H - 1, hoverSlot, slots, simStart);
    const paceTarget = target > 0 ? (H / periodHoursSafe) * target + 1 : 0;
    const rt = dir === "outbound" ? c?.outboundRoundtripHours ?? 0 : c?.inboundRoundtripHours ?? 0;
    const meps = dir === "outbound" ? c?.outboundMEPS ?? 0 : c?.inboundMEPS ?? 0;
    const logHour = slotLoadHourMap.get(hoverSlot.id);
    const resName = resources.find((r) => r.id === hoverSlot.resourceId)?.name;
    return {
      name: c?.name ?? hoverSlot.customerId,
      resName,
      invAtStart,
      doc,
      target,
      nThroughPrev,
      paceTarget,
      rt,
      meps,
      logHour,
      startHour: H
    };
  }, [
    hoverSlot,
    customerById,
    ganttInventorySeries.byCustomer,
    cfg,
    simStart,
    slots,
    periodHoursSafe,
    resources,
    slotLoadHourMap
  ]);

  const slotLabel = (slot: Slot) => {
    const w = slotWidth(slot.start, slot.end);
    if (w < 50) return "";
    const c = customerById.get(slot.customerId);
    return `${c?.name ?? slot.customerId}`;
  };

  const inventoryPoints = useCallback(
    (customerId: string): string => {
      const data = ganttInventorySeries.byCustomer.get(customerId);
      if (!data || data.length === 0) return "";
      const { lo, hi } = ganttInvYAxis;
      const hours = collectImportantInventoryHours(data.length, slots, simStart, customerId);
      return hours
        .map((h) => {
          const x = (h / 24) * pixelsPerDay;
          const y = invY(data[h]!, lo, hi);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    },
    [ganttInventorySeries.byCustomer, ganttInvYAxis, simStart, pixelsPerDay, slots]
  );

  const terminalTotalPoints = useCallback((): string => {
    const terminalByHour = ganttInventorySeries.terminalByHour;
    if (terminalByHour.length === 0) return "";
    const maxHours = terminalByHour.length;
    const { lo, hi } = ganttInvYAxis;
    const hours = collectImportantInventoryHours(maxHours, slots, simStart, null);
    return hours
      .map((h) => {
        const total = terminalByHour[h] ?? 0;
        const x = (h / 24) * pixelsPerDay;
        const y = invY(total, lo, hi);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [ganttInventorySeries.terminalByHour, ganttInvYAxis, simStart, pixelsPerDay, slots]);

  const terminalTotalByHour = useMemo((): number[] => {
    return ganttInventorySeries.terminalByHour.length > 0
      ? [...ganttInventorySeries.terminalByHour]
      : [];
  }, [ganttInventorySeries]);

  interface PipelineSegment { startH: number; endH: number; status: "flowing" | "tank_top" | "tank_bottom" }

  const buildPipelineSegments = useCallback(
    (direction: "inbound" | "outbound"): PipelineSegment[] => {
      if (!terminalTotalByHour.length) return [];
      const cap = cfg.totalStorageCapacity ?? 100000;
      const EPS = 1;
      const segments: PipelineSegment[] = [];
      let curStatus: PipelineSegment["status"] | null = null;
      let segStart = 0;
      for (let h = 0; h < terminalTotalByHour.length; h++) {
        const total = terminalTotalByHour[h] ?? 0;
        let status: PipelineSegment["status"];
        if (direction === "inbound") {
          status = total >= cap - EPS ? "tank_top" : "flowing";
        } else {
          status = total <= EPS ? "tank_bottom" : "flowing";
        }
        if (status !== curStatus) {
          if (curStatus !== null) segments.push({ startH: segStart, endH: h, status: curStatus });
          curStatus = status;
          segStart = h;
        }
      }
      if (curStatus !== null) {
        segments.push({ startH: segStart, endH: terminalTotalByHour.length, status: curStatus });
      }
      return segments;
    },
    [terminalTotalByHour, cfg]
  );

  const inboundPipelineSegments = useMemo(
    () => buildPipelineSegments("inbound"),
    [buildPipelineSegments]
  );

  const outboundPipelineSegments = useMemo(
    () => buildPipelineSegments("outbound"),
    [buildPipelineSegments]
  );

  const selectedPacingOption = useMemo(
    () => pacingLegOptions.find((o) => o.key === selectedPacingLeg) ?? null,
    [pacingLegOptions, selectedPacingLeg]
  );

  const docYAxis = useMemo(() => {
    if (!showDoc) return null;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [cid, series] of Object.entries(docTrendByCustomer)) {
      if (!enabledCustomers.has(cid)) continue;
      for (const v of series) {
        if (v != null && Number.isFinite(v)) {
          minV = Math.min(minV, v);
          maxV = Math.max(maxV, v);
        }
      }
    }
    if (!Number.isFinite(minV)) return null;
    if (maxV === minV) maxV = minV + 1;
    return { lo: Math.max(0, minV * 0.95), hi: maxV * 1.05 };
  }, [showDoc, docTrendByCustomer, enabledCustomers]);

  const pacingYAxis = useMemo(() => {
    if (!showPacing || !selectedPacingOption) return null;
    const series =
      pacingByCustomerMode[selectedPacingOption.customerId]?.[selectedPacingOption.directionMode];
    if (!series) return null;
    const finite = series.filter((v) => Number.isFinite(v));
    if (finite.length === 0) return null;
    const minV = Math.min(...finite, 0);
    const maxV = Math.max(...finite, 100);
    return { lo: Math.min(0, minV * 0.9), hi: Math.max(110, maxV * 1.05) };
  }, [showPacing, selectedPacingOption, pacingByCustomerMode]);

  const extraAxisWidth =
    (showDoc && docYAxis ? OVERLAY_AXIS_WIDTH : 0) +
    (showPacing && pacingYAxis ? OVERLAY_AXIS_WIDTH : 0);

  const labelColumnWidth = LABEL_WIDTH + extraAxisWidth;

  const constraintRowVisible = hasRun && showConstraints && hasConstraintData;

  const docOverlayPoints = useCallback(
    (customerId: string): string => {
      const series = docTrendByCustomer[customerId];
      const axis = docYAxis;
      if (!series || !axis) return "";
      const pts: string[] = [];
      for (let h = 0; h < series.length; h += SAMPLE_HOUR_STEP) {
        const v = series[h];
        if (v == null || !Number.isFinite(v)) continue;
        const x = (h / 24) * pixelsPerDay;
        const y = overlayY(v, axis.lo, axis.hi);
        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      }
      return pts.join(" ");
    },
    [docTrendByCustomer, docYAxis, pixelsPerDay]
  );

  const pacingOverlayPoints = useCallback((): string => {
    const opt = selectedPacingOption;
    const axis = pacingYAxis;
    if (!opt || !axis) return "";
    const series = pacingByCustomerMode[opt.customerId]?.[opt.directionMode];
    if (!series) return "";
    const pts: string[] = [];
    for (let h = 0; h < series.length; h += SAMPLE_HOUR_STEP) {
      const v = series[h];
      if (!Number.isFinite(v)) continue;
      const x = (h / 24) * pixelsPerDay;
      const y = overlayY(v, axis.lo, axis.hi);
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(" ");
  }, [selectedPacingOption, pacingYAxis, pacingByCustomerMode, pixelsPerDay]);

  const hasInventoryData = timelineData?.timeline && Object.keys(timelineData.timeline).length > 0;

  const timeSharedOverlayTriangles = useMemo(() => {
    if (!showTimeshared) return [];
    if ((cfg.storageMode ?? "fixed_band") !== "time_shared_storage") return [];
    if (!hasInventoryData) return [];
    const { lo, hi } = ganttInvYAxis;
    const out: Array<{ slotId: string; points: string; fill: string; title: string }> = [];
    for (const slot of slots) {
      const cust = customerById.get(slot.customerId);
      const m = slot.volume;
      if (!cust || m <= 0) continue;
      const rate = Math.abs(cust.pipelineFlowPerHour ?? 0);
      if (rate <= 0) continue;
      const durationHours = m / rate;
      if (durationHours <= 0) continue;
      const dir = parseSlotDirection(String(slot.direction));
      if (!dir) continue;
      const isIn = dir === "inbound";
      const anchorDate = isIn ? slot.end : slot.start;
      const xAnchor = slotX(anchorDate);
      const w = Math.max(2, (durationHours / 24) * pixelsPerDay);
      const col = customerColor(slot.customerId);
      const fill = rgbaFromHex(col, 0.35);
      // Entitlement: starts at cargo size (t), decreases to 0 over cargo ÷ pipeline flow.
      const yTop = invY(m, lo, hi);
      const yZero = invY(0, lo, hi);
      const points = `${xAnchor - w},${yTop} ${xAnchor},${yZero} ${xAnchor - w},${yZero}`;
      out.push({
        slotId: slot.id,
        points,
        fill,
        title: `${cust.name} · time-shared · ${m.toLocaleString()} t → 0 over ${durationHours.toFixed(1)} h (= ${m}/${rate} t/h) · anchor ${isIn ? "slot end" : "slot start"}`
      });
    }
    return out;
  }, [
    showTimeshared,
    cfg.storageMode,
    hasInventoryData,
    ganttInvYAxis,
    slots,
    customerById,
    slotX,
    customerColor
  ]);

  const handleInvChartMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!hasInventoryData || !scrollRef.current) return;
      const maxH = ganttInvYAxis.maxHours;
      if (maxH <= 0) return;
      const scrollEl = scrollRef.current;
      const scrollRect = scrollEl.getBoundingClientRect();
      const xInContent = e.clientX - scrollRect.left + scrollEl.scrollLeft;
      const hourFloat = (xInContent / pixelsPerDay) * 24;
      const hourIndex = Math.max(0, Math.min(maxH - 1, Math.round(hourFloat)));
      setInvChartTooltip({ hourIndex, clientX: e.clientX, clientY: e.clientY });
    },
    [hasInventoryData, ganttInvYAxis.maxHours, pixelsPerDay]
  );

  const handleInvChartMouseLeave = useCallback(() => setInvChartTooltip(null), []);

  const invChartTooltipLabel = useMemo(() => {
    if (!invChartTooltip) return "";
    const startMs = timelineData?.startDate
      ? new Date(timelineData.startDate).getTime()
      : new Date(cfg.startDate).getTime();
    const pointDate = new Date(startMs + invChartTooltip.hourIndex * HOUR_MS);
    return pointDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }, [invChartTooltip, timelineData?.startDate, cfg.startDate]);

  const legendCustomers = useMemo(() => {
    const ids = new Set<string>();
    for (const s of slots) ids.add(s.customerId);
    if (timelineData?.timeline) for (const id of Object.keys(timelineData.timeline)) ids.add(id);
    return [...ids].map((id) => ({ id, name: customerById.get(id)?.name ?? id }));
  }, [slots, timelineData, customerById]);

  const dateRangeLabel = `${formatDDMMYYYY(new Date(cfg.startDate))} – ${formatDDMMYYYY(new Date(cfg.endDate))}`;

  const legendEntries = useMemo((): LegendEntry[] => {
    const entries: LegendEntry[] = [];
    if (showInventory && hasInventoryData) {
      for (const c of legendCustomers) {
        if (!enabledCustomers.has(c.id)) continue;
        entries.push({
          id: `inv-${c.id}`,
          label: `${c.name} · inventory`,
          kind: "line",
          color: customerColor(c.id)
        });
      }
      entries.push({
        id: "terminal-total",
        label: "Terminal total",
        kind: "dashed-line",
        color: "#0f172a",
        dashArray: "6 3"
      });
    }
    if (showDoc && docYAxis) {
      for (const c of legendCustomers) {
        if (!enabledCustomers.has(c.id) || !docTrendByCustomer[c.id]) continue;
        entries.push({
          id: `doc-${c.id}`,
          label: `${c.name} · days of cover`,
          kind: "dashed-line",
          color: customerColor(c.id),
          dashArray: "8 4"
        });
      }
    }
    if (showPacing && pacingYAxis && selectedPacingOption) {
      entries.push({
        id: "pacing-leg",
        label: `${selectedPacingOption.label} · pacing %`,
        kind: "dashed-line",
        color: customerColor(selectedPacingOption.customerId),
        dashArray: "2 6"
      });
      entries.push({
        id: "pacing-100",
        label: "On pace (100%)",
        kind: "dashed-line",
        color: "#94a3b8",
        dashArray: "4 4"
      });
    }
    if (showRoundtrip && hasRoundtripConfig) {
      entries.push({
        id: "roundtrip",
        label: "Round-trip duration",
        kind: "rect",
        color: "rgba(100,116,139,0.25)"
      });
    }
    if (showTimeshared && hasTimeShareConfig) {
      entries.push({
        id: "timeshare",
        label: "Time-share entitlement",
        kind: "triangle",
        color: "rgba(59,130,246,0.35)"
      });
    }
    if (showStorageCapLine && hasStorageCapConfig) {
      entries.push({
        id: "storage-cap",
        label: "Storage capacity",
        kind: "dashed-line",
        color: "#dc2626",
        dashArray: "4 4"
      });
    }
    if (inboundPipelineTph > 0) {
      entries.push({ id: "pipe-in-flow", label: "Pipeline inbound · flowing", kind: "rect", color: "#d1d5db" });
      entries.push({
        id: "pipe-in-block",
        label: "Pipeline inbound · interrupted (tank top)",
        kind: "rect",
        color: "#ef4444"
      });
    }
    if (outboundPipelineTph > 0) {
      entries.push({ id: "pipe-out-flow", label: "Pipeline outbound · flowing", kind: "rect", color: "#d1d5db" });
      entries.push({
        id: "pipe-out-block",
        label: "Pipeline outbound · interrupted (tank bottom)",
        kind: "rect",
        color: "#ef4444"
      });
    }
    if (constraintRowVisible) {
      for (const def of SCHEDULING_CONSTRAINTS) {
        if (!enabledConstraints.has(def.key)) continue;
        if (!constraintData.activeConstraintKeys.includes(def.key)) continue;
        entries.push({
          id: def.key,
          label: def.label,
          kind: "constraint",
          color: def.color,
          icon: def.icon
        });
      }
    }
    return entries;
  }, [
    showInventory,
    hasInventoryData,
    legendCustomers,
    enabledCustomers,
    showDoc,
    docYAxis,
    docTrendByCustomer,
    showPacing,
    pacingYAxis,
    selectedPacingOption,
    showRoundtrip,
    hasRoundtripConfig,
    showTimeshared,
    hasTimeShareConfig,
    showStorageCapLine,
    hasStorageCapConfig,
    inboundPipelineTph,
    outboundPipelineTph,
    constraintRowVisible,
    enabledConstraints,
    constraintData.activeConstraintKeys,
    customerColor
  ]);

  const renderPipelineRow = (
    segments: PipelineSegment[],
    hasFlow: boolean,
    keyPrefix: string
  ) => {
    if (!hasFlow) return null;
    return (
      <div
        style={{
          height: PIPELINE_ROW_H,
          position: "relative",
          borderTop: "1px solid #e2e8f0",
          background: "#ffffff"
        }}
      >
        {monthMarkers.map((m) => (
          <div
            key={`${keyPrefix}-${m.key}`}
            style={{ position: "absolute", left: m.x, top: 0, bottom: 0, borderLeft: "1px solid #f1f5f9" }}
          />
        ))}
        {segments.length > 0 && (
          <svg style={{ position: "absolute", top: 0, left: 0 }} width={contentWidth} height={PIPELINE_ROW_H}>
            {segments.map((seg, i) => {
              const x = (seg.startH / 24) * pixelsPerDay;
              const w = Math.max(1, ((seg.endH - seg.startH) / 24) * pixelsPerDay);
              const fill = seg.status === "flowing" ? "#d1d5db" : "#ef4444";
              const label =
                seg.status === "tank_top"
                  ? "Tank top — pipeline blocked"
                  : seg.status === "tank_bottom"
                    ? "Tank bottom — pipeline blocked"
                    : "Flowing";
              return (
                <rect key={i} x={x} y={8} width={w} height={12} fill={fill} fillOpacity={0.85} rx={2}>
                  <title>{label}</title>
                </rect>
              );
            })}
          </svg>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "hidden"
      }}
    >
      <div className="dashboard-hero" style={{ marginBottom: 16 }}>
        <div>
          <div className="dashboard-hero-title">Simulation window</div>
          <div className="dashboard-hero-meta">
            <strong style={{ color: "#e2e8f0", fontSize: 15 }}>{dateRangeLabel}</strong>
            <span style={{ marginLeft: 8 }}>· {Math.round(periodHoursSafe).toLocaleString()} h</span>
          </div>
        </div>
        <div className="dashboard-hero-actions">
          <span className="chart-hour-zoom-hint" style={{ color: "#94a3b8" }}>
            Scroll wheel to zoom (cursor-centered)
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button className="btn btn-primary" disabled={isRunning} onClick={handleRunScheduler}>
          {isRunning ? (
            <>
              <Loader2 size={16} strokeWidth={2} style={{ animation: "spin 1s linear infinite" }} />
              Scheduling...
            </>
          ) : (
            <>
              <Zap size={16} strokeWidth={2} />
              Run Scheduler
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-secondary chart-hour-zoom-btn"
          onClick={() => setPixelsPerDay((p) => Math.min(p * 1.2, MAX_PIXELS_PER_DAY))}
        >
          ＋
        </button>
        <button
          type="button"
          className="btn btn-secondary chart-hour-zoom-btn"
          onClick={() => setPixelsPerDay((p) => Math.max(p / 1.2, MIN_PIXELS_PER_DAY))}
        >
          －
        </button>
      </div>

      <div className="multi-metric-toolbar" style={{ marginBottom: 16 }}>
        <div className="multi-metric-toolbar-group">
          <span className="multi-metric-toolbar-label">Layers</span>
          <div className="multi-metric-toggles">
            {hasRun && (
              <button
                type="button"
                className={`metric-toggle${showInventory ? " metric-toggle--on" : ""}`}
                onClick={() => setShowInventory((v) => !v)}
              >
                Inventory
              </button>
            )}
            {hasRoundtripConfig && (
              <button
                type="button"
                className={`metric-toggle${showRoundtrip ? " metric-toggle--on" : ""}`}
                onClick={() => setShowRoundtrip((v) => !v)}
              >
                Round-trip
              </button>
            )}
            {hasTimeShareConfig && (
              <button
                type="button"
                className={`metric-toggle${showTimeshared ? " metric-toggle--on" : ""}`}
                onClick={() => setShowTimeshared((v) => !v)}
              >
                Time-share
              </button>
            )}
            {hasStorageCapConfig && (
              <button
                type="button"
                className={`metric-toggle${showStorageCapLine ? " metric-toggle--on" : ""}`}
                onClick={() => setShowStorageCapLine((v) => !v)}
              >
                Storage cap
              </button>
            )}
            {hasDocConfig && (
              <button
                type="button"
                className={`metric-toggle${showDoc ? " metric-toggle--on" : ""}`}
                onClick={() => setShowDoc((v) => !v)}
              >
                Days of cover
              </button>
            )}
            {hasPacingConfig && (
              <button
                type="button"
                className={`metric-toggle${showPacing ? " metric-toggle--on" : ""}`}
                onClick={() => setShowPacing((v) => !v)}
              >
                Pacing %
              </button>
            )}
            {hasConstraintData && (
              <button
                type="button"
                className={`metric-toggle${showConstraints ? " metric-toggle--on" : ""}`}
                onClick={() => setShowConstraints((v) => !v)}
              >
                Constraints
              </button>
            )}
          </div>
        </div>
        {hasConstraintData && showConstraints && (
          <div className="multi-metric-toolbar-group">
            <span className="multi-metric-toolbar-label">Constraints</span>
            <div className="multi-metric-toggles">
              {SCHEDULING_CONSTRAINTS.map((def) => {
                const total =
                  constraintData.summaries.find((s) => s.key === def.key)?.legHours ?? 0;
                const inactive = total === 0;
                const on = enabledConstraints.has(def.key);
                return (
                  <button
                    key={def.key}
                    type="button"
                    disabled={inactive}
                    className={`constraint-toggle-chip${on ? " constraint-toggle-chip--on" : ""}${
                      inactive ? " constraint-toggle-chip--inactive" : ""
                    }`}
                    style={
                      on && !inactive
                        ? ({ "--chip-color": def.color } as CSSProperties)
                        : undefined
                    }
                    onClick={() => !inactive && toggleConstraint(def.key)}
                  >
                    <span className="constraint-toggle-chip-icon">
                      <ConstraintIcon constraintKey={def.key} size={13} />
                    </span>
                    {def.label}
                    <span className="constraint-toggle-chip-count">{total}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {customers.length > 0 && (
          <div className="multi-metric-toolbar-group">
            <span className="multi-metric-toolbar-label">Customers</span>
            <div className="multi-metric-toggles">
              {customers.map((c, i) => {
                const on = enabledCustomers.has(c.id);
                const color = resolveCustomerChartColor(c.chartColor, i);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`customer-toggle-chip${on ? " customer-toggle-chip--on" : ""}`}
                    style={on ? ({ "--chip-color": color } as CSSProperties) : undefined}
                    onClick={() => toggleCustomer(c.id)}
                  >
                    <span className="customer-toggle-chip-dot" style={{ background: color }} />
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {showPacing && hasPacingConfig && (
          <div className="multi-metric-toolbar-group">
            <span className="multi-metric-toolbar-label">Pacing leg</span>
            <select
              className="form-input"
              style={{ maxWidth: 320, fontSize: 13 }}
              value={selectedPacingLeg ?? ""}
              onChange={(e) => setSelectedPacingLeg(e.target.value || null)}
            >
              {pacingLegOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Main chart area */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          overflow: "hidden",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0
        }}
      >
        <div
          style={{
            display: "flex",
            minHeight: 0,
            minWidth: 0,
            width: "100%",
            overflow: "hidden"
          }}
        >
        {/* Fixed left labels */}
        <div style={{ width: labelColumnWidth, flexShrink: 0, borderRight: "1px solid #e2e8f0", zIndex: 2, background: "#f8fafc" }}>
          <div style={{ height: HEADER_HEIGHT, borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }} />
          {hasRun && resourceRows.map((r) => (
            <div
              key={r.id}
              className="timeline-row-label"
              style={{
                height: ganttRowHeight(r),
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderBottom: "1px solid #f1f5f9"
              }}
            >
              {r.name}
            </div>
          ))}
          {constraintRowVisible && (
            <div
              className="timeline-row-label"
              style={{
                height: CONSTRAINT_ROW_H,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderTop: "1px solid #e2e8f0"
              }}
            >
              Constraints
            </div>
          )}
          {hasRun && inboundPipelineTph > 0 && (
            <div
              className="timeline-row-label"
              style={{
                height: PIPELINE_ROW_H,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderTop: "1px solid #e2e8f0"
              }}
            >
              Pipeline inbound
            </div>
          )}
          {hasRun && outboundPipelineTph > 0 && (
            <div
              className="timeline-row-label"
              style={{
                height: PIPELINE_ROW_H,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderTop: outboundPipelineTph > 0 && inboundPipelineTph === 0 ? "1px solid #e2e8f0" : undefined
              }}
            >
              Pipeline outbound
            </div>
          )}
          {hasRun && (
            <div
              style={{
                height: CHART_HEIGHT,
                display: "flex",
                flexDirection: "row",
                alignItems: "stretch",
                padding: "0 0 0 8px",
                borderTop: "1px solid #e2e8f0",
                minWidth: 0
              }}
            >
              <div
                className="timeline-row-label"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  minWidth: 0,
                  lineHeight: 1.2,
                  padding: "0 4px"
                }}
              >
                Inventory
              </div>
              <div
                style={{
                  position: "relative",
                  width: AXIS_WIDTH,
                  flexShrink: 0,
                  height: CHART_HEIGHT,
                  pointerEvents: "none",
                  borderRight: "1px solid #e2e8f0",
                  boxSizing: "border-box",
                  paddingRight: 4,
                  paddingLeft: 2
                }}
              >
                {hasInventoryData &&
                  buildInventoryAxisTicks(ganttInvYAxis.lo, ganttInvYAxis.hi).map((v) => (
                    <span
                      key={String(v)}
                      className="timeline-axis-tick"
                      style={{
                        position: "absolute",
                        left: 2,
                        right: 4,
                        top: invY(v, ganttInvYAxis.lo, ganttInvYAxis.hi),
                        transform: "translateY(-50%)"
                      }}
                    >
                      {Math.round(v).toLocaleString()}
                    </span>
                  ))}
              </div>
              {showDoc && docYAxis && (
                <div
                  className="timeline-overlay-axis"
                  style={{
                    position: "relative",
                    width: OVERLAY_AXIS_WIDTH,
                    flexShrink: 0,
                    height: CHART_HEIGHT,
                    pointerEvents: "none",
                    borderRight: "1px solid #e2e8f0",
                    boxSizing: "border-box",
                    paddingRight: 4
                  }}
                >
                  {buildInventoryAxisTicks(docYAxis.lo, docYAxis.hi).map((v) => (
                    <span
                      key={`doc-${v}`}
                      className="timeline-axis-tick timeline-axis-tick--doc"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 4,
                        top: overlayY(v, docYAxis.lo, docYAxis.hi),
                        transform: "translateY(-50%)"
                      }}
                    >
                      {v >= 10 ? v.toFixed(0) : v.toFixed(1)}
                    </span>
                  ))}
                </div>
              )}
              {showPacing && pacingYAxis && (
                <div
                  className="timeline-overlay-axis"
                  style={{
                    position: "relative",
                    width: OVERLAY_AXIS_WIDTH,
                    flexShrink: 0,
                    height: CHART_HEIGHT,
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    paddingRight: 4
                  }}
                >
                  {buildInventoryAxisTicks(pacingYAxis.lo, pacingYAxis.hi).map((v) => (
                    <span
                      key={`pace-${v}`}
                      className="timeline-axis-tick timeline-axis-tick--pace"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 4,
                        top: overlayY(v, pacingYAxis.lo, pacingYAxis.hi),
                        transform: "translateY(-50%)"
                      }}
                    >
                      {Math.round(v)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scrollable right area */}
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          onScroll={handleScroll}
          className="gantt-scroll-area"
          style={{
            overflowX: "auto",
            overflowY: "hidden",
            flex: 1,
            minWidth: 0,
            userSelect: "none",
            background: "#f8fafc"
          }}
        >
          <div style={{ width: contentWidth, position: "relative" }}>
            {/* Month header row */}
            <div
              style={{
                height: HEADER_HEIGHT,
                position: "relative",
                background: "#f8fafc",
                borderBottom: "1px solid #e2e8f0"
              }}
            >
              {monthMarkers.map((m) => (
                <div
                  key={m.key}
                  style={{
                    position: "absolute",
                    left: m.x,
                    top: 0,
                    height: "100%",
                    borderLeft: "1px solid #e2e8f0",
                    paddingLeft: 6,
                    display: "flex",
                    alignItems: "center",
                    fontSize: 12,
                    color: "#64748b",
                    fontWeight: 600
                  }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Empty state before first run */}
            {!hasRun && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: resourceRows.reduce((h, r) => h + ganttRowHeight(r), 0) + PIPELINE_ROW_H + CHART_HEIGHT,
                  color: "#94a3b8",
                  fontSize: 14,
                  gap: 8
                }}
              >
                <Zap size={28} strokeWidth={1.5} color="#94a3b8" />
                <span>Run the scheduler to see results</span>
              </div>
            )}

            {/* Gantt rows, pipeline and inventory — only after a run */}
            {hasRun && resourceRows.map((r, ri) => {
              const rowH = ganttRowHeight(r);
              const rtExtra = r.type?.startsWith("berth") ? berthLegendExtraHeight(r.id) : 0;
              const slotBandH =
                rtExtra > 0
                  ? Math.max(SLOT_BAND_MIN_H_RT, Math.floor((rowH - rtExtra - 6) / 2))
                  : Math.max(SLOT_BAND_MIN_H, Math.floor((ROW_HEIGHT - 6) / 2));
              const slotTop = Math.max(2, (rowH - rtExtra - slotBandH) / 2);
              const rtLegend = berthRoundtripLegendsByResource.get(r.id) ?? [];
              return (
                <div
                  key={r.id}
                  style={{
                    height: rowH,
                    position: "relative",
                    background: ri % 2 === 0 ? "#ffffff" : "#f8fafc",
                    borderBottom: "1px solid #f1f5f9"
                  }}
                >
                  {monthMarkers.map((m) => (
                    <div
                      key={`row-${m.key}`}
                      style={{
                        position: "absolute",
                        left: m.x,
                        top: 0,
                        bottom: 0,
                        borderLeft: "1px solid #f1f5f9"
                      }}
                    />
                  ))}
                  {slotsForResource(r.id).map((slot) => {
                    const col = customerColor(slot.customerId);
                    return (
                      <div
                        key={slot.id}
                        onMouseEnter={() => {
                          cancelPendingHoverClear();
                          setHoverSlot(slot);
                        }}
                        onMouseLeave={scheduleHoverClear}
                        style={{
                          position: "absolute",
                          left: slotX(slot.start),
                          width: slotWidth(slot.start, slot.end),
                          top: slotTop,
                          height: slotBandH,
                          background: rgbaFromHex(col, 0.2),
                          border: `1px solid ${rgbaFromHex(col, 0.45)}`,
                          borderRadius: 6,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          fontWeight: 600,
                          color: "#0f172a",
                          overflow: "hidden",
                          cursor: "pointer",
                          zIndex: 1
                        }}
                      >
                        {slotLabel(slot)}
                      </div>
                    );
                  })}
                  {showRoundtrip && rtLegend.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: rtExtra,
                        paddingTop: RT_LEGEND_PAD_TOP,
                        paddingBottom: RT_LEGEND_PAD_BOTTOM,
                        boxSizing: "border-box",
                        pointerEvents: "none"
                      }}
                    >
                      {rtLegend.map((e) => {
                        const nm = customerById.get(e.customerId)?.name ?? e.customerId;
                        const w = Math.max(3, (e.hours / 24) * pixelsPerDay);
                        const leftPx = slotX(new Date(e.anchorStartMs));
                        const rtCol = customerColor(e.customerId);
                        return (
                          <div
                            key={`${e.slotId}-rt`}
                            title={`${nm} · ${e.direction} roundtrip · ${e.hours} h · this visit (length follows zoom)`}
                            style={{
                              position: "absolute",
                              left: leftPx,
                              top: RT_LEGEND_PAD_TOP + e.lane * (RT_LEGEND_LINE_H + RT_LEGEND_GAP),
                              width: w,
                              height: RT_LEGEND_LINE_H,
                              background: rgbaFromHex(rtCol, 0.2),
                              border: `1px solid ${rgbaFromHex(rtCol, 0.45)}`,
                              borderRadius: 3
                            }}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {hasRun && <>
            {constraintRowVisible && (
              <div
                style={{
                  height: CONSTRAINT_ROW_H,
                  position: "relative",
                  borderTop: "1px solid #e2e8f0",
                  background: "#ffffff"
                }}
              >
                {monthMarkers.map((m) => (
                  <div
                    key={`con-${m.key}`}
                    style={{ position: "absolute", left: m.x, top: 0, bottom: 0, borderLeft: "1px solid #f1f5f9" }}
                  />
                ))}
                <svg
                  style={{ position: "absolute", top: 0, left: 0 }}
                  width={contentWidth}
                  height={CONSTRAINT_ROW_H}
                >
                  {constraintData.rows.flatMap((row) => {
                    const colW = Math.max(2, pixelsPerDay / 24);
                    const x = (row.hour / 24) * pixelsPerDay;
                    const padY = 8;
                    const maxH = CONSTRAINT_ROW_H - padY * 2;
                    const maxCount = Math.max(1, constraintData.maxCountPerHour);
                    let stackTop = CONSTRAINT_ROW_H - padY;
                    const rects: React.ReactElement[] = [];
                    for (const def of SCHEDULING_CONSTRAINTS) {
                      if (!enabledConstraints.has(def.key)) continue;
                      const n = row.counts[def.key] ?? 0;
                      if (n <= 0) continue;
                      const h = Math.max(4, (n / maxCount) * maxH);
                      stackTop -= h;
                      rects.push(
                        <rect
                          key={`${row.hour}-${def.key}`}
                          x={x}
                          y={stackTop}
                          width={colW}
                          height={h}
                          fill={def.color}
                          fillOpacity={0.75}
                          rx={2}
                        >
                          <title>
                            {def.label}: {n} leg{n !== 1 ? "s" : ""} blocked at hour {row.hour}
                          </title>
                        </rect>
                      );
                    }
                    return rects;
                  })}
                </svg>
              </div>
            )}

            {renderPipelineRow(inboundPipelineSegments, inboundPipelineTph > 0, "pipe-in")}
            {renderPipelineRow(outboundPipelineSegments, outboundPipelineTph > 0, "pipe-out")}

            {/* Inventory chart area - SVG with same coordinate system */}
            <div
              role="img"
              aria-label="Inventory timeline — hover for values by date"
              onMouseMove={handleInvChartMouseMove}
              onMouseLeave={handleInvChartMouseLeave}
              style={{
                height: CHART_HEIGHT,
                position: "relative",
                borderTop: "1px solid #e2e8f0",
                background: "#ffffff",
                cursor: hasInventoryData ? "crosshair" : "default"
              }}
            >
              {monthMarkers.map((m) => (
                <div key={`inv-${m.key}`} style={{ position: "absolute", left: m.x, top: 0, bottom: 0, borderLeft: "1px solid #f1f5f9" }} />
              ))}
              <svg
                style={{ position: "absolute", top: 0, left: 0 }}
                width={contentWidth}
                height={CHART_HEIGHT}
              >
                {(() => {
                  const lo = ganttInvYAxis.lo;
                  const hi = ganttInvYAxis.hi;
                  const span = hi - lo;
                  const yZero = invY(0, lo, hi);
                  const faintYs = [0.25, 0.5, 0.75]
                    .map((p) => invY(lo + span * p, lo, hi))
                    .filter((y) => Math.abs(y - yZero) > 2);
                  return (
                    <>
                      {faintYs.map((y, i) => (
                        <line
                          key={`gf-${i}`}
                          x1={0}
                          x2={contentWidth}
                          y1={y}
                          y2={y}
                          stroke="#f1f5f9"
                          strokeWidth={1}
                        />
                      ))}
                      {lo <= 0 && hi >= 0 && (
                        <line
                          x1={0}
                          x2={contentWidth}
                          y1={yZero}
                          y2={yZero}
                          stroke="#94a3b8"
                          strokeWidth={1}
                        />
                      )}
                    </>
                  );
                })()}
                {showInventory &&
                  hasInventoryData &&
                  Object.keys(timelineData!.timeline)
                    .filter((cid) => enabledCustomers.has(cid))
                    .map((cid) => (
                      <polyline
                        key={cid}
                        points={inventoryPoints(cid)}
                        fill="none"
                        stroke={customerColor(cid)}
                        strokeWidth={2.5}
                      />
                    ))}
                {showInventory && hasInventoryData && (
                  <polyline
                    points={terminalTotalPoints()}
                    fill="none"
                    stroke="#0f172a"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                  />
                )}
                {showDoc &&
                  docYAxis &&
                  Object.keys(docTrendByCustomer)
                    .filter((cid) => enabledCustomers.has(cid))
                    .map((cid) => {
                      const pts = docOverlayPoints(cid);
                      if (!pts) return null;
                      return (
                        <polyline
                          key={`doc-${cid}`}
                          points={pts}
                          fill="none"
                          stroke={customerColor(cid)}
                          strokeWidth={2}
                          strokeDasharray="8 4"
                          strokeOpacity={0.9}
                        />
                      );
                    })}
                {showPacing && pacingYAxis && selectedPacingOption && (
                  <>
                    <line
                      x1={0}
                      x2={contentWidth}
                      y1={overlayY(100, pacingYAxis.lo, pacingYAxis.hi)}
                      y2={overlayY(100, pacingYAxis.lo, pacingYAxis.hi)}
                      stroke="#94a3b8"
                      strokeWidth={1}
                      strokeDasharray="4 4"
                    />
                    <polyline
                      points={pacingOverlayPoints()}
                      fill="none"
                      stroke={customerColor(selectedPacingOption.customerId)}
                      strokeWidth={2}
                      strokeDasharray="2 6"
                    />
                  </>
                )}
                {timeSharedOverlayTriangles.map((tri) => (
                  <polygon
                    key={`ts-${tri.slotId}`}
                    points={tri.points}
                    fill={tri.fill}
                    stroke="rgba(15,23,42,0.25)"
                    strokeWidth={0.75}
                  >
                    <title>{tri.title}</title>
                  </polygon>
                ))}
                {showStorageCapLine && hasInventoryData && terminalStorageCap > 0 && (
                  <line
                    x1={0}
                    x2={contentWidth}
                    y1={invY(terminalStorageCap, ganttInvYAxis.lo, ganttInvYAxis.hi)}
                    y2={invY(terminalStorageCap, ganttInvYAxis.lo, ganttInvYAxis.hi)}
                    stroke="#dc2626"
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    strokeLinecap="butt"
                  >
                    <title>
                      Terminal storage capacity ({Math.round(terminalStorageCap).toLocaleString()} t)
                    </title>
                  </line>
                )}
              </svg>
            </div>
            </>}
          </div>
        </div>
        </div>

        {/* Minimap */}
        {totalDays > 0 && (
          <div
            style={{
              marginTop: 8,
              marginLeft: labelColumnWidth,
              width: `calc(100% - ${labelColumnWidth}px)`,
              boxSizing: "border-box",
              position: "relative",
              height: 32,
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              overflow: "hidden",
              background: "#f8fafc",
              cursor: "pointer"
            }}
            ref={minimapRef}
            onMouseDown={handleMinimapMouseDown}
          >
            {slots.map((slot) => {
              const x = (dayOffset(slot.start) / totalDays) * 100;
              const w = Math.max(
                0.3,
                ((dayOffset(slot.end) - dayOffset(slot.start)) / totalDays) * 100
              );
              return (
                <div
                  key={slot.id}
                  style={{
                    position: "absolute",
                    left: `${x}%`,
                    width: `${w}%`,
                    top: 4,
                    height: 10,
                    background: customerColor(slot.customerId),
                    borderRadius: 2,
                    opacity: 0.7
                  }}
                />
              );
            })}
            <div
              style={{
                position: "absolute",
                left: `${(viewportStart / totalDays) * 100}%`,
                width: `${(viewportWidth / totalDays) * 100}%`,
                top: 0,
                bottom: 0,
                background: "rgba(59,130,246,0.15)",
                border: "1px solid #3b82f6",
                borderRadius: 2,
                cursor: "grab",
                pointerEvents: "none"
              }}
            />
          </div>
        )}
      </div>

      {feasibilityWarnings.length > 0 && (
        <div
          ref={feasibilityWarningsRef}
          className="alert alert-warning"
          style={{ marginTop: 16, marginBottom: 0 }}
        >
          <strong>Feasibility warnings</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {feasibilityWarnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <TimelineChartLegend entries={legendEntries} />

      {invChartTooltip && hasInventoryData && timelineData?.timeline && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: (() => {
              const pad = 14;
              const tw = 268;
              const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
              return Math.max(8, Math.min(invChartTooltip.clientX + pad, vw - tw));
            })(),
            top: (() => {
              const pad = 14;
              const th = 200;
              const vh = typeof window !== "undefined" ? window.innerHeight : 800;
              return Math.max(8, Math.min(invChartTooltip.clientY + pad, vh - th));
            })(),
            background: "#1e293b",
            color: "white",
            padding: "12px 16px",
            borderRadius: 8,
            fontSize: 12,
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            zIndex: 1001,
            pointerEvents: "none",
            maxWidth: 260
          }}
        >
          <div style={{ marginBottom: 8, fontWeight: 600 }}>{invChartTooltipLabel}</div>
          <div>
            Terminal Total:{" "}
            {(ganttInventorySeries.terminalByHour[invChartTooltip.hourIndex] ?? 0).toLocaleString()} t
          </div>
          {Object.keys(timelineData.timeline).map((cid) => (
            <div key={cid}>
              {customerById.get(cid)?.name ?? cid}:{" "}
              {(
                ganttInventorySeries.byCustomer.get(cid)?.[invChartTooltip.hourIndex] ?? 0
              ).toLocaleString()}{" "}
              t
            </div>
          ))}
        </div>
      )}

      {hoverSlot && hoverSlotMeta && (
        <div
          className="schedule-slot-tooltip"
          role="tooltip"
          onMouseEnter={cancelPendingHoverClear}
          onMouseLeave={scheduleHoverClear}
          style={{
            position: "fixed",
            left: "50%",
            top: 72,
            transform: "translateX(-50%)",
            background: "#0f172a",
            color: "#e2e8f0",
            padding: "14px 18px",
            borderRadius: 10,
            fontSize: 13,
            zIndex: 1000,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            border: "1px solid #334155",
            pointerEvents: "auto"
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: "#f8fafc" }}>
            {hoverSlotMeta.name}
          </div>
          <dl style={{ margin: 0, display: "grid", gap: 0 }}>
            <dt>Move</dt>
            <dd>
              {hoverSlot.direction} {hoverSlot.mode} · {hoverSlot.volume.toLocaleString()} t (MEPS {hoverSlotMeta.meps || "—"} t)
            </dd>
            <dt>Berth</dt>
            <dd>{hoverSlotMeta.resName ?? hoverSlot.resourceId}</dd>
            <dt>Window</dt>
            <dd>
              {formatDDMMYYYY(new Date(hoverSlot.start))} → {formatDDMMYYYY(new Date(hoverSlot.end))}
            </dd>
            {hoverSlotMeta.invAtStart != null && (
              <>
                <dt>Inventory @ start</dt>
                <dd>
                  {Math.round(hoverSlotMeta.invAtStart).toLocaleString()} t
                  {hoverSlotMeta.doc != null ? ` · ~${hoverSlotMeta.doc} d cover (pipeline)` : ""}
                </dd>
              </>
            )}
            <dt>Roundtrip (config)</dt>
            <dd>
              {hoverSlotMeta.rt > 0
                ? `${hoverSlotMeta.rt} h minimum between ${hoverSlot.direction} starts`
                : "Not enforced (0 h)"}
            </dd>
            {hoverSlotMeta.target > 0 && (
              <>
                <dt>Pace (model)</dt>
                <dd>
                  Leg target {hoverSlotMeta.target} slot(s) in horizon · at assignment{" "}
                  {hoverSlotMeta.nThroughPrev} start(s) through prior hour · soft target{" "}
                  {hoverSlotMeta.paceTarget.toFixed(1)}
                </dd>
              </>
            )}
            {hoverSlotMeta.logHour != null && (
              <>
                <dt>Simulation log</dt>
                <dd>Load registered at hour {hoverSlotMeta.logHour}</dd>
              </>
            )}
          </dl>
          <button
            type="button"
            className="schedule-tooltip-log-btn"
            style={{
              marginTop: 12,
              width: "100%",
              padding: "8px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              borderRadius: 6,
              border: "1px solid #475569",
              background: "#1e293b",
              color: "#e2e8f0"
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const { startHour } = hoverSlotMeta;
              const sp = new URLSearchParams();
              sp.set("hour", String(startHour));
              sp.set("customerId", hoverSlot.customerId);
              sp.set("direction", String(hoverSlot.direction));
              sp.set("mode", String(hoverSlot.mode));
              navigate(`/simulation-log?${sp.toString()}`);
            }}
          >
            Open simulation log at hour {hoverSlotMeta.startHour}
          </button>
        </div>
      )}
    </div>
  );
}
