import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setLastSchedulerRun } from "../store";
import { resolveCustomerChartColor } from "../lib/customerChartColor";

// Single source of truth for all positioning
const LABEL_WIDTH = 140;
const ROW_HEIGHT = 58;
/** Stacked roundtrip duration bars under each berth row (timeline scale). */
const RT_LEGEND_LINE_H = 8;
const RT_LEGEND_GAP = 4;
const RT_LEGEND_PAD_TOP = 6;
const RT_LEGEND_PAD_BOTTOM = 4;
/** Time-shared storage triangle layer under berth rows */
const TS_LAYER_H = 14;
const TS_LEGEND_GAP = 4;
const HOUR_MS = 60 * 60 * 1000;
const CHART_HEIGHT = 200;
const INV_Y_AXIS_STEP_T = 5000;
const PIPELINE_ROW_H = 28;
const HEADER_HEIGHT = 32;
const AXIS_WIDTH = 60;
const MIN_PIXELS_PER_DAY = 3;
const MAX_PIXELS_PER_DAY = 300;
const DEFAULT_PIXELS_PER_DAY = 20;
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
    const label = current.toLocaleDateString("en-GB", {
      month: "short",
      year: current.getMonth() === 0 ? "2-digit" : undefined
    });
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

function invY(value: number, lo: number, hi: number): number {
  const span = hi - lo || 1;
  const t = (value - lo) / span;
  return CHART_HEIGHT - Math.max(0, Math.min(1, t)) * (CHART_HEIGHT - 8);
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
  const pipelineRatePerHour = c.pipelineFlowPerHour ?? 0;
  const pipeDir = config.pipelineDirection ?? "inbound";
  const pipelineContribution = pipelineRatePerHour * periodHours;
  const pipelineInbound = pipeDir === "inbound" ? pipelineContribution : 0;
  const pipelineOutbound = pipeDir === "outbound" ? pipelineContribution : 0;
  const outboundThroughput = (c.declaredInboundThroughput ?? 0) + pipelineInbound - pipelineOutbound;

  if (direction === "inbound") {
    const meps = c.inboundMEPS ?? 0;
    const declared = c.declaredInboundThroughput ?? 0;
    if (meps <= 0 || declared <= 0) return 0;
    const byThroughput = Math.ceil(declared / meps);
    const rt = c.inboundRoundtripHours ?? 0;
    if (rt > 0) return Math.min(byThroughput, Math.floor(periodHours / rt));
    return byThroughput;
  }

  const meps = c.outboundMEPS ?? 0;
  if (meps <= 0 || outboundThroughput <= 0) return 0;
  const byThroughput = Math.ceil(outboundThroughput / meps);
  const rt = c.outboundRoundtripHours ?? 0;
  if (rt > 0) return Math.min(byThroughput, Math.floor(periodHours / rt));
  return byThroughput;
}

function slotStartHour(slot: Slot, simStartMs: number): number {
  return Math.round((new Date(slot.start).getTime() - simStartMs) / HOUR_MS);
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
  const [showRoundtrip, setShowRoundtrip] = useState(true);
  const [showTimeshared, setShowTimeshared] = useState(true);
  const [showStorageCapLine, setShowStorageCapLine] = useState(true);
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

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const container = scrollRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const cursorXInView = e.clientX - rect.left;
    const cursorXInContent = cursorXInView + container.scrollLeft;
    const dayAtCursor = cursorXInContent / pixelsPerDay;

    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const newPPD = Math.max(MIN_PIXELS_PER_DAY, Math.min(MAX_PIXELS_PER_DAY, pixelsPerDay * factor));

    setPixelsPerDay(newPPD);

    requestAnimationFrame(() => {
      if (!scrollRef.current) return;
      const newCursorXInContent = dayAtCursor * newPPD;
      scrollRef.current.scrollLeft = newCursorXInContent - cursorXInView;
      setScrollLeft(scrollRef.current.scrollLeft);
    });
  };

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
    (start: Date | string, end: Date | string) => Math.max(24, (dayOffset(end) - dayOffset(start)) * pixelsPerDay),
    [dayOffset, pixelsPerDay]
  );
  /** Timeline width from sim start→end (pixels). */
  const totalWidth = dayOffset(new Date(cfg.endDate)) * pixelsPerDay + 100;
  /** When zoomed out, totalWidth can be narrower than the scroll viewport; fill the viewport so tracks align with the minimap. */
  const contentWidth = Math.max(totalWidth, viewportClientW || 0);

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

  const tsExtraHeightForBerth = useCallback(
    (resourceId: string): number => {
      if (!showTimeshared) return 0;
      if ((cfg.storageMode ?? "fixed_band") !== "time_shared_storage") return 0;
      if (!resources.find((x) => x.id === resourceId)?.type?.startsWith("berth")) return 0;
      if (!slots.some((s) => s.resourceId === resourceId)) return 0;
      return TS_LAYER_H + TS_LEGEND_GAP;
    },
    [showTimeshared, cfg.storageMode, resources, slots]
  );

  const ganttRowHeight = (r: Resource) =>
    ROW_HEIGHT +
    (r.type?.startsWith("berth") ? berthLegendExtraHeight(r.id) + tsExtraHeightForBerth(r.id) : 0);

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

  const periodHoursSafe = Math.max(
    (new Date(cfg.endDate).getTime() - new Date(cfg.startDate).getTime()) / HOUR_MS,
    1
  );

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

  const totalCustomerPipelineTph = useMemo(
    () => customers.reduce((s, c) => s + (c.pipelineFlowPerHour ?? 0), 0),
    [customers]
  );

  const pipelineSegments = useMemo((): PipelineSegment[] => {
    if (!terminalTotalByHour.length || totalCustomerPipelineTph <= 0) return [];
    const cap = cfg.totalStorageCapacity ?? 100000;
    const EPS = 1;
    const isInbound = (cfg.pipelineDirection ?? "inbound") === "inbound";
    const segments: PipelineSegment[] = [];
    let curStatus: PipelineSegment["status"] | null = null;
    let segStart = 0;
    for (let h = 0; h < terminalTotalByHour.length; h++) {
      const total = terminalTotalByHour[h] ?? 0;
      let status: PipelineSegment["status"];
      if (isInbound && total >= cap - EPS) status = "tank_top";
      else if (!isInbound && total <= EPS) status = "tank_bottom";
      else status = "flowing";
      if (status !== curStatus) {
        if (curStatus !== null) segments.push({ startH: segStart, endH: h, status: curStatus });
        curStatus = status;
        segStart = h;
      }
    }
    if (curStatus !== null) segments.push({ startH: segStart, endH: terminalTotalByHour.length, status: curStatus });
    return segments;
  }, [terminalTotalByHour, cfg, totalCustomerPipelineTph]);

  const hasPipeline = totalCustomerPipelineTph > 0;

  const hasInventoryData = timelineData?.timeline && Object.keys(timelineData.timeline).length > 0;

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
      {/* Toolbar */}
      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <button className="btn btn-primary" disabled={isRunning} onClick={handleRunScheduler}>
          {isRunning ? (
            <>
              <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⏳</span>
              Scheduling...
            </>
          ) : (
            <>
              <span>⚡</span>
              Run Scheduler
            </>
          )}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setPixelsPerDay((p) => Math.min(p * 1.2, MAX_PIXELS_PER_DAY))}
        >
          ＋
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setPixelsPerDay((p) => Math.max(p / 1.2, MIN_PIXELS_PER_DAY))}
        >
          －
        </button>
        <button
          type="button"
          className={`btn ${showRoundtrip ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setShowRoundtrip((v) => !v)}
          title="Show roundtrip duration as colored bars under each berth row (timeline scale)"
        >
          RT
        </button>
        <button
          type="button"
          className={`btn ${showTimeshared ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setShowTimeshared((v) => !v)}
          title="Time-shared storage: show entitlement triangles (x, y) under each berth when mode is time-shared"
        >
          TS
        </button>
        <button
          type="button"
          className={`btn ${showStorageCapLine ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setShowStorageCapLine((v) => !v)}
          title="Show terminal storage capacity as a horizontal red reference line on the inventory chart"
        >
          Cap
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>Scroll wheel to zoom (cursor-centered)</span>
        <span style={{ fontSize: 13, color: "#64748b" }}>{dateRangeLabel}</span>
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
        <div style={{ width: LABEL_WIDTH, flexShrink: 0, borderRight: "1px solid #e2e8f0", zIndex: 2, background: "#f8fafc" }}>
          <div style={{ height: HEADER_HEIGHT, borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }} />
          {hasRun && resourceRows.map((r) => (
            <div
              key={r.id}
              style={{
                height: ganttRowHeight(r),
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderBottom: "1px solid #f1f5f9",
                fontSize: 14,
                fontWeight: 500
              }}
            >
              {r.name}
            </div>
          ))}
          {hasRun && (
            <div
              style={{
                height: PIPELINE_ROW_H,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                fontSize: 11,
                color: "#64748b",
                fontWeight: 600,
                letterSpacing: "0.04em",
                borderTop: "1px solid #e2e8f0"
              }}
            >
              PIPELINE
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
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  fontSize: 12,
                  color: "#64748b",
                  fontWeight: 600,
                  minWidth: 0,
                  lineHeight: 1.2,
                  padding: "0 4px"
                }}
              >
                INVENTORY (T)
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
                      style={{
                        position: "absolute",
                        left: 2,
                        right: 4,
                        top: invY(v, ganttInvYAxis.lo, ganttInvYAxis.hi),
                        transform: "translateY(-50%)",
                        fontSize: 10,
                        color: "#475569",
                        lineHeight: 1.1,
                        textAlign: "right",
                        whiteSpace: "nowrap",
                        textShadow:
                          "1px 0 0 #f8fafc, -1px 0 0 #f8fafc, 0 1px 0 #f8fafc, 0 -1px 0 #f8fafc, 1px 1px 0 #f8fafc, -1px -1px 0 #f8fafc, 1px -1px 0 #f8fafc, -1px 1px 0 #f8fafc"
                      }}
                    >
                      {Math.round(v).toLocaleString()}
                    </span>
                  ))}
              </div>
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
            overflowX: "scroll",
            overflowY: "hidden",
            flex: 1,
            minWidth: 0,
            userSelect: "none"
          }}
        >
          <div style={{ width: Math.max(contentWidth, 400), position: "relative", minWidth: "100%" }}>
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
                <span style={{ fontSize: 28 }}>⚡</span>
                <span>Run the scheduler to see results</span>
              </div>
            )}

            {/* Gantt rows, pipeline and inventory — only after a run */}
            {hasRun && resourceRows.map((r, ri) => {
              const rowH = ganttRowHeight(r);
              const rtExtra = r.type?.startsWith("berth") ? berthLegendExtraHeight(r.id) : 0;
              const tsEx = r.type?.startsWith("berth") ? tsExtraHeightForBerth(r.id) : 0;
              const bottomExtras = rtExtra + tsEx;
              const slotBandH =
                bottomExtras > 0
                  ? Math.max(26, rowH - bottomExtras - 10)
                  : Math.max(32, ROW_HEIGHT - 8);
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
                          top: 4,
                          height: slotBandH,
                          background: col,
                          borderRadius: 6,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "white",
                          overflow: "hidden",
                          cursor: "pointer",
                          zIndex: 1,
                          boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
                        }}
                      >
                        {slotLabel(slot)}
                      </div>
                    );
                  })}
                  {/* Time-shared triangles (bottom strip) */}
                  {showTimeshared &&
                    (cfg.storageMode ?? "fixed_band") === "time_shared_storage" &&
                    tsEx > 0 && (
                      <svg
                        style={{
                          position: "absolute",
                          left: 0,
                          bottom: 0,
                          pointerEvents: "none",
                          zIndex: 0
                        }}
                        width={contentWidth}
                        height={tsEx}
                      >
                        {slotsForResource(r.id).map((slot) => {
                          const cust = customerById.get(slot.customerId);
                          const yHours = Math.max(0.01, cust?.timeSharedDuration ?? 24);
                          const xBand = cust?.timeSharedMinBand ?? 0;
                          const m = slot.volume;
                          if (m <= 0) return null;
                          const w = Math.max(2, (yHours / 24) * pixelsPerDay);
                          const x0 = slotX(slot.start);
                          const yTop = 2;
                          const yBot = TS_LAYER_H - 1;
                          const Htri = yBot - yTop;
                          const volToY = (v: number) =>
                            yBot - ((v - xBand) / m) * Htri;
                          const dir = parseSlotDirection(String(slot.direction));
                          const isIn = dir === "inbound";
                          const col = customerColor(slot.customerId);
                          const fill =
                            col.startsWith("#") && col.length === 7
                              ? `rgba(${parseInt(col.slice(1, 3), 16)},${parseInt(col.slice(3, 5), 16)},${parseInt(col.slice(5, 7), 16)},0.35)`
                              : "rgba(100,116,139,0.35)";
                          const yLo = volToY(xBand);
                          const yHi = volToY(m + xBand);
                          const ptsFix = isIn
                            ? `${x0},${yLo} ${x0},${yHi} ${x0 + w},${yLo}`
                            : `${x0},${yLo} ${x0 + w},${yLo} ${x0 + w},${yHi}`;
                          return (
                            <polygon
                              key={`${slot.id}-ts`}
                              points={ptsFix}
                              fill={fill}
                              stroke="rgba(15,23,42,0.2)"
                              strokeWidth={0.5}
                            >
                              <title>{`${cust?.name ?? slot.customerId} · time-shared · x=${xBand} t, y=${yHours} h, MEPS=${m} t`}</title>
                            </polygon>
                          );
                        })}
                      </svg>
                    )}
                  {showRoundtrip && rtLegend.length > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: tsEx,
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
                              background: customerColor(e.customerId),
                              borderRadius: 3,
                              boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.12)"
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
            {/* Pipeline status row */}
            <div
              style={{
                height: PIPELINE_ROW_H,
                position: "relative",
                borderTop: "1px solid #e2e8f0",
                background: "#ffffff"
              }}
            >
              {monthMarkers.map((m) => (
                <div key={`pipe-${m.key}`} style={{ position: "absolute", left: m.x, top: 0, bottom: 0, borderLeft: "1px solid #f1f5f9" }} />
              ))}
              {hasPipeline && pipelineSegments.length > 0 && (
                <svg style={{ position: "absolute", top: 0, left: 0 }} width={contentWidth} height={PIPELINE_ROW_H}>
                  {pipelineSegments.map((seg, i) => {
                    const x = (seg.startH / 24) * pixelsPerDay;
                    const w = Math.max(1, ((seg.endH - seg.startH) / 24) * pixelsPerDay);
                    const fill = seg.status === "flowing" ? "#d1d5db" : "#ef4444";
                    const label = seg.status === "tank_top" ? "Tank top — pipeline blocked" : seg.status === "tank_bottom" ? "Tank bottom — pipeline blocked" : "Flowing";
                    return (
                      <rect
                        key={i}
                        x={x}
                        y={8}
                        width={w}
                        height={12}
                        fill={fill}
                        rx={2}
                      >
                        <title>{label}</title>
                      </rect>
                    );
                  })}
                </svg>
              )}
              {!hasPipeline && (
                <div style={{ display: "flex", alignItems: "center", height: "100%", paddingLeft: 8, fontSize: 11, color: "#cbd5e1" }}>
                  No pipeline configured
                </div>
              )}
            </div>

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
                          stroke="#cbd5e1"
                          strokeWidth={2.25}
                        />
                      )}
                    </>
                  );
                })()}
                {hasInventoryData &&
                  Object.keys(timelineData!.timeline).map((cid) => (
                    <polyline
                      key={cid}
                      points={inventoryPoints(cid)}
                      fill="none"
                      stroke={customerColor(cid)}
                      strokeWidth={2}
                    />
                  ))}
                {hasInventoryData && (
                  <polyline
                    points={terminalTotalPoints()}
                    fill="none"
                    stroke="#0f172a"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                  />
                )}
                {showStorageCapLine && hasInventoryData && terminalStorageCap > 0 && (
                  <line
                    x1={0}
                    x2={contentWidth}
                    y1={invY(terminalStorageCap, ganttInvYAxis.lo, ganttInvYAxis.hi)}
                    y2={invY(terminalStorageCap, ganttInvYAxis.lo, ganttInvYAxis.hi)}
                    stroke="#dc2626"
                    strokeWidth={2}
                    strokeOpacity={0.95}
                    strokeDasharray="8 6"
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
              marginLeft: LABEL_WIDTH,
              width: `calc(100% - ${LABEL_WIDTH}px)`,
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

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
        {legendCustomers.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <div style={{ width: 12, height: 12, borderRadius: 3, background: customerColor(c.id) }} />
            {c.name}
          </div>
        ))}
        {hasInventoryData && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <div style={{ width: 20, height: 2, background: "transparent", borderTop: "2px dashed #0f172a" }} />
            Terminal Total
          </div>
        )}
        {hasPipeline && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <div style={{ width: 20, height: 8, background: "#d1d5db", borderRadius: 2 }} />
              Pipeline flowing
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <div style={{ width: 20, height: 8, background: "#ef4444", borderRadius: 2 }} />
              Pipeline interrupted (tank {(cfg.pipelineDirection ?? "inbound") === "inbound" ? "top" : "bottom"})
            </div>
          </>
        )}
        {showTimeshared && (cfg.storageMode ?? "fixed_band") === "time_shared_storage" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <svg width={22} height={12} aria-hidden style={{ flexShrink: 0 }}>
                <polygon
                  points="2,10 2,2 20,10"
                  fill="rgba(59,130,246,0.35)"
                  stroke="rgba(15,23,42,0.25)"
                  strokeWidth={0.5}
                />
              </svg>
              TS min band (x, tonnes)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <svg width={22} height={12} aria-hidden style={{ flexShrink: 0 }}>
                <rect x={2} y={8} width={16} height={2} fill="#94a3b8" />
              </svg>
              TS duration (y, hours) → triangle width on timeline
            </div>
          </>
        )}
      </div>

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
