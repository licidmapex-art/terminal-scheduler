import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type PointerEvent,
  type UIEvent
} from "react";
import { flushSync } from "react-dom";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useStore } from "../store";
import type { SimulationLogRow, TransportModeStatus } from "../../engine/simulationLog";
import {
  SCHEDULING_CONSTRAINTS,
  constraintDef,
  type BlockingConstraintKey
} from "../lib/schedulingConstraints";
import TransportStatusIcon, { WorstConstraintIcon } from "../components/TransportStatusIcon";
import { ConstraintIcon, UncategorisedConstraintIcon } from "../components/ConstraintIcon";
import { CheckCircle2, ClipboardList } from "lucide-react";

interface Customer {
  id: string;
  name: string;
}

type DirectionMode = { direction: "inbound" | "outbound"; mode: "ship" | "barge" | "train" };

/** One (customer + direction + mode) leg that appears in the log; drives mode column headers/cells. */
type LegColumn = DirectionMode & {
  customerId: string;
  customerName: string;
  legKey?: string;
  legLabel?: string;
};

type ViewMode = "events" | "daily" | "all";

type ConstraintFilterKey = BlockingConstraintKey | "uncategorised";

const VISIBLE_ROWS = 150;
const ROW_HEIGHT = 48;

function hashSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  const hash = window.location.hash.replace(/^#/, "");
  const q = hash.includes("?") ? hash.split("?")[1] ?? "" : "";
  return new URLSearchParams(q);
}

function modeKey(m: DirectionMode): string {
  return `${m.direction ?? ""}:${m.mode ?? ""}`;
}

function getTooltip(status: TransportModeStatus | undefined): string {
  if (!status) return "No status row for this leg in this hour.";
  if (status.action === "loaded")
    return `Loaded ${status.volume?.toLocaleString() ?? "?"}t on ${status.resourceName ?? "resource"}`;
  if (status.action === "loading_in_progress")
    return `Loading in progress on ${status.resourceName ?? "resource"}`;
  if (status.action === "pre_ops")
    return `Pre-ops alongside ${status.resourceName ?? "resource"} (${status.constraintDetail ?? "pre-cargo"})`;
  if (status.action === "post_ops")
    return `Post-ops alongside ${status.resourceName ?? "resource"} (${status.constraintDetail ?? "post-cargo"})`;
  if (status.blockingConstraint) {
    const label = constraintDef(status.blockingConstraint).label;
    const detail = status.constraintDetail?.trim();
    return detail ? `${label}: ${detail}` : label;
  }
  return (
    `Idle — all constraints pass but no slot scheduled this hour. ` +
    `Inventory: ${status.constraintDetail ?? "unknown"}`
  );
}

function findTransportStatusForLeg(
  row: SimulationLogRow,
  customerId: string,
  direction: string,
  mode: string,
  legKey?: string
): TransportModeStatus | undefined {
  const d = String(direction).toLowerCase();
  const mo = String(mode).toLowerCase();
  return (row.transportStatus ?? []).find(
    (s) =>
      s.customerId === customerId &&
      String(s.direction).toLowerCase() === d &&
      String(s.mode).toLowerCase() === mo &&
      (legKey == null || (s.legKey ?? "lane0") === legKey)
  );
}

function constraintPriority(c: TransportModeStatus["blockingConstraint"]): number {
  if (c === "insufficient_inventory") return 5;
  if (c === "customer_inventory_floor") return 5;
  if (c === "tank_full") return 4;
  if (c === "roundtrip") return 3;
  if (c === "resource_occupied") return 2;
  if (c === "pace_ahead") return 1;
  if (c === "optimizer_days_of_cover") return 1;
  return 0;
}

function higherConstraint(
  a: TransportModeStatus["blockingConstraint"],
  b: TransportModeStatus["blockingConstraint"]
): TransportModeStatus["blockingConstraint"] {
  return constraintPriority(b) > constraintPriority(a) ? b : a;
}

function formatDaysOfCover(doc: number | null | undefined): string {
  if (doc == null || !Number.isFinite(doc)) return "∞";
  return doc >= 10 ? doc.toFixed(1) : doc.toFixed(2);
}

/** Multiline text for the floating leg/mode cell tooltip (hour rows). */
function buildHourLegModeTooltipContent(
  row: SimulationLogRow,
  customerName: string,
  customerId: string,
  direction: string,
  mode: string,
  legKey?: string,
  legLabel?: string
): string {
  const status = findTransportStatusForLeg(row, customerId, direction, mode, legKey);
  const lane = legLabel ? ` (${legLabel})` : "";
  const legLine = `${customerName} — ${mode} ${direction === "inbound" ? "↓" : "↑"}${lane}`;
  const timeLine = `Hour ${row.hour} · ${new Date(row.datetime).toLocaleString()}`;

  if (!status) {
    return [
      legLine,
      timeLine,
      "",
      "No transport row for this leg in this hour.",
      "",
      "If you expected activity here, check configuration (throughput targets, MEPS, mode) so the scheduler opens this leg."
    ].join("\n");
  }

  const docLine =
    status.daysOfCover !== undefined
      ? `Sort metric: ${formatDaysOfCover(status.daysOfCover)} (lower = tried earlier). Inbound leg: inventory ÷ total outbound pull (t/d). Outbound leg: headroom ÷ total inbound fill (t/d), or raw headroom if no inbound fill.`
      : null;

  const head = [
    legLine,
    timeLine,
    ...(docLine ? ["", docLine] : []),
    "",
    "● This column is one leg (customer + direction + mode only).",
    ""
  ];

  if (status.action !== "idle") {
    return [...head, "Berth / activity:", getTooltip(status)].join("\n");
  }

  const bc = status.blockingConstraint;
  const primary = ["Primary (stored when idle):", getTooltip(status), ""];
  const checklist = [
    "When idle, the engine stores one primary reason. Compare to the checklist:",
    ...SCHEDULING_CONSTRAINTS.map(
      (def) => `${def.label.padEnd(28)} ${bc === def.key ? "← primary" : "—"}`
    ),
    `${"Uncategorised idle".padEnd(28)} ${bc === null ? "← primary" : "—"}`
  ];
  if (status.constraintDetail?.trim()) {
    checklist.push("", `Detail: ${status.constraintDetail.trim()}`);
  }
  return [...head, ...primary, ...checklist].join("\n");
}

/** Daily roll-up cell: counts + worst idle reason + sample detail. */
function buildDailyLegModeTooltipContent(
  customerName: string,
  dateLabel: string,
  m: DirectionMode,
  agg: ModeDayAgg,
  legLabel?: string
): string {
  const lane = legLabel ? ` (${legLabel})` : "";
  const legLine = `${customerName} — ${m.mode} ${m.direction === "inbound" ? "↓" : "↑"}${lane}`;
  const lines = [
    legLine,
    `Day ${dateLabel} (daily summary)`,
    "",
    `Loads started this day: ${agg.loadedCount.toLocaleString()}`,
    agg.loadedCount > 0
      ? "At least one load started on this leg."
      : "No load starts on this leg this day (often idle all hours).",
    ""
  ];
  if (agg.docMin !== undefined && agg.docMax !== undefined) {
    lines.push(
      agg.docMin === agg.docMax
        ? `Days-of-cover (engine): ${formatDaysOfCover(agg.docMin)} d at each sampled hour`
        : `Days-of-cover (engine): ${formatDaysOfCover(agg.docMin)} – ${formatDaysOfCover(agg.docMax)} d (min–max across hours)`
    );
    lines.push("");
  }
  if (agg.worst) {
    lines.push(`Worst idle reason (by severity across hours): ${constraintDef(agg.worst).label}`);
    if (agg.sampleDetail?.trim()) {
      lines.push(`Sample detail: ${agg.sampleDetail.trim()}`);
    }
  } else if (agg.loadedCount === 0) {
    lines.push("No idle blocker was recorded for this leg on this day, or the leg had no open target.");
  }
  lines.push(
    "",
    "When idle, the same primary-reason checklist applies per hour (see All hours view and hover an hour cell).",
    "",
    SCHEDULING_CONSTRAINTS.map((d) => d.label).join(" · ") + " · Uncategorised idle"
  );
  return lines.join("\n");
}

function matchesFilters(
  s: TransportModeStatus,
  activeCustomers: Set<string>,
  activeModes: Set<string>
): boolean {
  return activeCustomers.has(s.customerId) && activeModes.has(modeKey(s));
}

function statusMatchesConstraintFilter(
  s: TransportModeStatus,
  activeConstraints: Set<ConstraintFilterKey>
): boolean {
  if (activeConstraints.size === 0) return true;
  if (s.action !== "idle") return false;
  const key: ConstraintFilterKey = s.blockingConstraint ?? "uncategorised";
  return activeConstraints.has(key);
}

function rowMatchesConstraintFilter(
  row: SimulationLogRow,
  activeCustomers: Set<string>,
  activeModes: Set<string>,
  activeConstraints: Set<ConstraintFilterKey>
): boolean {
  if (activeConstraints.size === 0) return true;
  for (const s of row.transportStatus ?? []) {
    if (!matchesFilters(s, activeCustomers, activeModes)) continue;
    if (statusMatchesConstraintFilter(s, activeConstraints)) return true;
  }
  return false;
}

function rowIsInterestingEvent(
  row: SimulationLogRow,
  activeCustomers: Set<string>,
  activeModes: Set<string>
): boolean {
  for (const s of row.transportStatus ?? []) {
    if (!matchesFilters(s, activeCustomers, activeModes)) continue;
    if (s.action === "loaded") return true;
    if (s.action === "pre_ops" || s.action === "post_ops") return true;
    if (s.blockingConstraint === "insufficient_inventory") return true;
    if (s.blockingConstraint === "tank_full") return true;
    if (s.blockingConstraint === "roundtrip") return true;
  }
  return false;
}

function hourRowStylesFixed(
  row: SimulationLogRow,
  activeCustomers: Set<string>,
  activeModes: Set<string>,
  zebra: CSSProperties
): CSSProperties {
  const relevant = (row.transportStatus ?? []).filter((s) =>
    matchesFilters(s, activeCustomers, activeModes)
  );
  if (relevant.length === 0)
    return { ...zebra, verticalAlign: "top", height: ROW_HEIGHT, maxHeight: ROW_HEIGHT, overflow: "hidden" };

  let worst: TransportModeStatus["blockingConstraint"] = null;
  let hasLoadedStart = false;
  for (const s of relevant) {
    if (s.action === "loaded") hasLoadedStart = true;
    if (s.blockingConstraint) worst = higherConstraint(worst, s.blockingConstraint);
  }

  const base: CSSProperties = {
    verticalAlign: "top",
    height: ROW_HEIGHT,
    maxHeight: ROW_HEIGHT,
    overflow: "hidden"
  };
  if (worst === "insufficient_inventory") base.background = "#fef2f2";
  else if (worst === "tank_full") base.background = "#fffbeb";
  else if (worst === "roundtrip") base.background = "#eff6ff";
  else if (worst === "pace_ahead" || worst === "optimizer_days_of_cover")
    base.background = "#f1f5f9";
  else Object.assign(base, zebra);

  if (hasLoadedStart) base.borderLeft = "4px solid #22c55e";

  return base;
}

interface ModeDayAgg {
  loadedCount: number;
  worst: TransportModeStatus["blockingConstraint"];
  /** First non-empty idle constraint detail for this leg on this day (tooltips). */
  sampleDetail: string | null;
  /** Min/max finite days-of-cover across hours for this leg (engine metric). */
  docMin?: number;
  docMax?: number;
}

export interface DailySummary {
  dayKey: string;
  dateLabel: string;
  customerMin: Record<string, number>;
  customerMax: Record<string, number>;
  terminalMin: number;
  terminalMax: number;
  /** key: customerId:direction:mode */
  modeAgg: Record<string, ModeDayAgg>;
}

function aggKey(customerId: string, m: DirectionMode): string {
  const lane = (m as { legKey?: string }).legKey ?? "lane0";
  return `${customerId}:${modeKey(m)}:${lane}`;
}

function buildDailySummaries(logRows: SimulationLogRow[], customers: Customer[]): DailySummary[] {
  const byDay = new Map<string, SimulationLogRow[]>();
  for (const row of logRows) {
    const iso = row.datetime ?? "";
    const dayKey = iso.length >= 10 ? iso.slice(0, 10) : "unknown";
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(row);
  }
  const keys = [...byDay.keys()].sort();
  return keys.map((dayKey) => {
    const rows = byDay.get(dayKey)!;
    const first = rows[0]!;
    const ids = customers.length > 0 ? customers.map((c) => c.id) : Object.keys(first.customerInventories);
    const customerMin: Record<string, number> = {};
    const customerMax: Record<string, number> = {};
    for (const id of ids) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const r of rows) {
        const v = r.customerInventories[id] ?? 0;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      customerMin[id] = mn;
      customerMax[id] = mx;
    }
    let terminalMin = Infinity;
    let terminalMax = -Infinity;
    for (const r of rows) {
      const tt = r.terminalTotal ?? 0;
      terminalMin = Math.min(terminalMin, tt);
      terminalMax = Math.max(terminalMax, tt);
    }

    const modeAgg: Record<string, ModeDayAgg> = {};
    for (const r of rows) {
      for (const s of r.transportStatus ?? []) {
        const k = aggKey(s.customerId, s);
        if (!modeAgg[k]) modeAgg[k] = { loadedCount: 0, worst: null, sampleDetail: null };
        if (s.action === "loaded") modeAgg[k].loadedCount += 1;
        if (s.action === "idle" && s.blockingConstraint) {
          modeAgg[k].worst = higherConstraint(modeAgg[k].worst, s.blockingConstraint);
          const det = (s.constraintDetail ?? "").trim();
          if (det && modeAgg[k].sampleDetail == null) modeAgg[k].sampleDetail = det;
        }
        const d = s.daysOfCover;
        if (d != null && Number.isFinite(d)) {
          const cur = modeAgg[k];
          cur.docMin = cur.docMin === undefined ? d : Math.min(cur.docMin, d);
          cur.docMax = cur.docMax === undefined ? d : Math.max(cur.docMax, d);
        }
      }
    }

    return {
      dayKey,
      dateLabel: dayKey,
      customerMin,
      customerMax,
      terminalMin,
      terminalMax,
      modeAgg
    };
  });
}

type DisplayRow =
  | { kind: "hour"; row: SimulationLogRow }
  | { kind: "daily"; row: DailySummary };

export default function SimulationLog() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const suppressNextScrollResetRef = useRef(false);
  const [logRows, setLogRows] = useState<SimulationLogRow[]>([]);
  const logRowsRef = useRef(logRows);
  logRowsRef.current = logRows;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [totalVolumeMoved, setTotalVolumeMoved] = useState(0);
  /** Default on each visit: Daily summary (see load() + defaultsAppliedRef). */
  const [viewMode, setViewMode] = useState<ViewMode>("daily");
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);
  /** When false, next non-empty log fetch applies Daily + all customers + all modes (page load / remount). */
  const defaultsAppliedRef = useRef(false);

  const [activeCustomers, setActiveCustomers] = useState<Set<string>>(() => new Set());
  const [activeModes, setActiveModes] = useState<Set<string>>(() => new Set());
  const [activeConstraints, setActiveConstraints] = useState<Set<ConstraintFilterKey>>(() => new Set());
  const [maxLegColumns, setMaxLegColumns] = useState(16);

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [custs, log, slotsRaw] = await Promise.all([
        window.dbAPI.getCustomers() as Promise<Customer[]>,
        window.schedulerAPI.getSimulationLog() as Promise<SimulationLogRow[]>,
        window.schedulerAPI.getSlots() as Promise<Array<{ volume?: number }>>
      ]);
      setCustomers(custs ?? []);
      const normalizedLog = (log ?? []).map((row) => ({
        ...row,
        transportStatus: row.transportStatus ?? [],
        pipelineFlow: row.pipelineFlow ?? {},
        customerInventories: row.customerInventories ?? {},
        terminalTotal: row.terminalTotal ?? 0,
        datetime: row.datetime ?? new Date(0).toISOString()
      }));
      setLogRows(normalizedLog);

      let vol = 0;
      for (const s of slotsRaw ?? []) {
        vol += s.volume ?? 0;
      }
      setTotalVolumeMoved(vol);

      if (normalizedLog.length === 0) {
        defaultsAppliedRef.current = false;
      } else {
        const c = custs ?? [];
        if (c.length > 0 && !defaultsAppliedRef.current) {
          defaultsAppliedRef.current = true;
          const hourFocus = hashSearchParams().get("hour");
          setViewMode(hourFocus ? "all" : "daily");
          setActiveCustomers(new Set(c.map((x) => x.id)));
          const modeKeys = new Set<string>();
          for (const row of normalizedLog) {
            for (const st of row.transportStatus ?? []) {
              modeKeys.add(`${st.direction}:${st.mode}`);
            }
          }
          setActiveModes(modeKeys);
        }
      }
    }
    load();
  }, [lastSchedulerRun]);

  const availableModes = useMemo((): DirectionMode[] => {
    const m = new Map<string, DirectionMode>();
    for (const row of logRows) {
      for (const s of row.transportStatus ?? []) {
        const k = modeKey(s);
        if (!m.has(k)) m.set(k, { direction: s.direction, mode: s.mode });
      }
    }
    return [...m.values()].sort(
      (a, b) =>
        String(a.direction ?? "").localeCompare(String(b.direction ?? "")) ||
        String(a.mode ?? "").localeCompare(String(b.mode ?? ""))
    );
  }, [logRows]);

  const activeCustomerList = useMemo(
    () => customers.filter((c) => activeCustomers.has(c.id)),
    [customers, activeCustomers]
  );

  const activeModeList = useMemo(
    () => availableModes.filter((m) => activeModes.has(modeKey(m))),
    [availableModes, activeModes]
  );

  /** Idle-hour counts per blocking constraint (respects customer + mode filters). */
  const constraintCounts = useMemo(() => {
    const counts = new Map<ConstraintFilterKey, number>();
    for (const row of logRows) {
      for (const s of row.transportStatus ?? []) {
        if (!matchesFilters(s, activeCustomers, activeModes)) continue;
        if (s.action !== "idle") continue;
        const key: ConstraintFilterKey = s.blockingConstraint ?? "uncategorised";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [logRows, activeCustomers, activeModes]);

  const uncategorisedIdleCount = constraintCounts.get("uncategorised") ?? 0;

  /** Per-run legs only: no empty columns for unseen transport rows. */
  const inventoryLegColumns = useMemo((): LegColumn[] => {
    const seen = new Set<string>();
    const cols: Array<LegColumn & { score: number }> = [];
    const scoreMap = new Map<string, number>();
    for (const row of logRows) {
      for (const s of row.transportStatus ?? []) {
        if (!activeCustomers.has(s.customerId)) continue;
        if (!activeModes.has(modeKey(s))) continue;
        const lane = s.legKey ?? "lane0";
        const uid = `${s.customerId}:${modeKey(s)}:${lane}`;
        const w =
          s.action === "loaded"
            ? 5
            : s.action === "loading_in_progress"
              ? 3
              : s.blockingConstraint
                ? 2
                : 1;
        scoreMap.set(uid, (scoreMap.get(uid) ?? 0) + w);
        if (!seen.has(uid)) {
          seen.add(uid);
          cols.push({
            customerId: s.customerId,
            customerName: customers.find((c) => c.id === s.customerId)?.name ?? s.customerId,
            direction: s.direction,
            mode: s.mode,
            legKey: lane,
            legLabel: s.legLabel ?? undefined,
            score: 0
          });
        }
      }
    }
    for (const c of cols) {
      const uid = `${c.customerId}:${modeKey(c)}:${c.legKey ?? "lane0"}`;
      c.score = scoreMap.get(uid) ?? 0;
    }
    const orderIdx = new Map(activeCustomerList.map((c, i) => [c.id, i]));
    cols.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ia = orderIdx.get(a.customerId) ?? 999;
      const ib = orderIdx.get(b.customerId) ?? 999;
      if (ia !== ib) return ia - ib;
      return (
        modeKey(a).localeCompare(modeKey(b)) ||
        String(a.legLabel ?? a.legKey ?? "").localeCompare(String(b.legLabel ?? b.legKey ?? ""))
      );
    });
    return cols.slice(0, Math.max(1, Math.min(maxLegColumns, cols.length)));
  }, [logRows, activeCustomers, activeModes, activeCustomerList, customers, maxLegColumns]);

  const filterKey = `${[...activeCustomers].sort().join(",")}|${[...activeModes].sort().join(",")}|${[...activeConstraints].sort().join(",")}`;

  const searchKey = searchParams.toString();

  const clearLogDeepLinkParams = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("hour");
    next.delete("customerId");
    next.delete("direction");
    next.delete("mode");
    const qs = next.toString();
    navigate(qs ? `/simulation-log?${qs}` : "/simulation-log", { replace: true });
  }, [navigate, searchParams]);

  /** Deep link from Gantt: apply filters + view in one sync commit, then scroll after layout (avoids race with scroll-reset effect). */
  useEffect(() => {
    const hp = searchParams.get("hour");
    if (!hp || logRows.length === 0) return;
    const hour = parseInt(hp, 10);
    if (Number.isNaN(hour)) return;
    const customerId = searchParams.get("customerId");
    const direction = searchParams.get("direction");
    const mode = searchParams.get("mode");

    suppressNextScrollResetRef.current = true;
    flushSync(() => {
      if (customerId) setActiveCustomers((prev) => new Set(prev).add(customerId));
      if (direction && mode) setActiveModes((prev) => new Set(prev).add(`${direction}:${mode}`));
      setViewMode("all");
    });

    const frame = requestAnimationFrame(() => {
      const rows = logRowsRef.current;
      const idx = rows.findIndex((r) => r.hour === hour);
      if (idx >= 0 && scrollRef.current) {
        const theadH = theadRef.current?.offsetHeight ?? 0;
        const maxOff = Math.max(0, rows.length - VISIBLE_ROWS);
        scrollRef.current.scrollTop = theadH + idx * ROW_HEIGHT;
        setScrollOffset(Math.min(idx, maxOff));
      }
      suppressNextScrollResetRef.current = true;
      clearLogDeepLinkParams();
    });
    return () => cancelAnimationFrame(frame);
  }, [searchKey, logRows.length, clearLogDeepLinkParams]);

  useEffect(() => {
    if (suppressNextScrollResetRef.current) {
      suppressNextScrollResetRef.current = false;
      return;
    }
    setScrollOffset(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [viewMode, logRows.length, filterKey]);

  const displayRows = useMemo((): DisplayRow[] => {
    if (logRows.length === 0) return [];
    const matchesConstraints = (row: SimulationLogRow) =>
      rowMatchesConstraintFilter(row, activeCustomers, activeModes, activeConstraints);

    if (viewMode === "all") {
      return logRows.filter(matchesConstraints).map((row) => ({ kind: "hour", row }));
    }
    if (viewMode === "events") {
      return logRows
        .filter(
          (row) =>
            rowIsInterestingEvent(row, activeCustomers, activeModes) && matchesConstraints(row)
        )
        .map((row) => ({ kind: "hour", row }));
    }
    return buildDailySummaries(logRows, customers)
      .filter((daily) => {
        if (activeConstraints.size === 0) return true;
        return logRows.some(
          (row) =>
            (row.datetime ?? "").slice(0, 10) === daily.dayKey && matchesConstraints(row)
        );
      })
      .map((row) => ({ kind: "daily", row }));
  }, [logRows, viewMode, customers, activeCustomers, activeModes, activeConstraints]);

  const virtualSlice = useMemo(() => {
    const start = Math.min(scrollOffset, Math.max(0, displayRows.length - VISIBLE_ROWS));
    return {
      start,
      rows: displayRows.slice(start, start + VISIBLE_ROWS)
    };
  }, [displayRows, scrollOffset]);

  const [legModeTooltip, setLegModeTooltip] = useState<{ content: string; x: number; y: number } | null>(null);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    setLegModeTooltip(null);
    const st = e.currentTarget.scrollTop;
    const theadH = theadRef.current?.offsetHeight ?? 0;
    const bodyScroll = Math.max(0, st - theadH);
    const idx = Math.floor(bodyScroll / ROW_HEIGHT);
    const maxOff = Math.max(0, displayRows.length - VISIBLE_ROWS);
    setScrollOffset(Math.min(Math.max(0, idx), maxOff));
  };

  const showLegModeTooltip = (e: PointerEvent<HTMLElement>, content: string) => {
    setLegModeTooltip({ content, x: e.clientX, y: e.clientY });
  };
  const moveLegModeTooltip = (e: PointerEvent<HTMLElement>) => {
    setLegModeTooltip((o) => (o ? { ...o, x: e.clientX, y: e.clientY } : null));
  };
  const hideLegModeTooltip = () => setLegModeTooltip(null);

  const summary = useMemo(() => {
    const totalHours = Math.max(0, logRows.length - 1);
    let loadEvents = 0;
    for (const row of logRows) {
      for (const s of row.transportStatus ?? []) {
        if (s.action === "loaded") loadEvents += 1;
      }
    }
    return { totalHours, loadEvents, totalVolume: totalVolumeMoved };
  }, [logRows, totalVolumeMoved]);

  const rowCountLabel = useMemo(() => {
    const total = displayRows.length;
    const vis = virtualSlice.rows.length;
    return `Showing ${vis} of ${total.toLocaleString()} rows`;
  }, [displayRows.length, virtualSlice]);

  const colCount = 2 + activeCustomerList.length + 1 + inventoryLegColumns.length;

  const topSpacerHeight = virtualSlice.start * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(
    0,
    (displayRows.length - virtualSlice.start - virtualSlice.rows.length) * ROW_HEIGHT
  );

  const toggleCustomer = (id: string) => {
    setActiveCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMode = (key: string) => {
    setActiveModes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleConstraint = (key: ConstraintFilterKey) => {
    setActiveConstraints((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const constraintFilterLabel = useMemo(() => {
    if (activeConstraints.size === 0) return null;
    const labels = [...activeConstraints].map((key) => {
      if (key === "uncategorised") return "Uncategorised idle";
      return constraintDef(key).label;
    });
    return labels.join(", ");
  }, [activeConstraints]);

  const zebra = (rowIdx: number): CSSProperties =>
    virtualSlice.start % 2 === rowIdx % 2 ? { background: "#fff" } : { background: "#f8fafc" };

  if (logRows.length === 0) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Simulation Log</h1>
            <p className="page-subtitle">Hour-by-hour transport diagnostics</p>
          </div>
        </div>
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">
              <ClipboardList size={48} strokeWidth={1.5} />
            </div>
            <div className="empty-state-title">No simulation data</div>
            <div className="empty-state-text">Run the scheduler first to see the simulation log</div>
          </div>
        </div>
      </div>
    );
  }

  async function handleExportExcel() {
    if (!window.schedulerAPI?.exportSimulationExcel) return;
    const res = await window.schedulerAPI.exportSimulationExcel();
    if (res.ok) {
      window.alert(`Exported to:\n${res.path}`);
    } else if (!res.error.includes("cancelled")) {
      window.alert(res.error);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Simulation Log</h1>
          <p className="page-subtitle">Time-forward diagnostic: why each mode loaded or not, each hour</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void handleExportExcel()}>
          Export to Excel
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16, padding: "12px 16px" }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 16px",
            fontSize: 14
          }}
        >
          <span>
            <strong>{summary.totalHours.toLocaleString()}</strong> hours
          </span>
          <span style={{ color: "#94a3b8" }}>|</span>
          <span>
            <strong>{summary.loadEvents.toLocaleString()}</strong> load starts
          </span>
          <span style={{ color: "#94a3b8" }}>|</span>
          <span>
            <strong>{summary.totalVolume.toLocaleString()}</strong>t moved
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>CUSTOMERS</span>
        {customers.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`btn ${activeCustomers.has(c.id) ? "btn-primary" : "btn-secondary"}`}
            style={{ padding: "4px 12px", fontSize: 12 }}
            onClick={() => toggleCustomer(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>MODES</span>
        {availableModes.map((m) => (
          <button
            key={modeKey(m)}
            type="button"
            className={`btn ${activeModes.has(modeKey(m)) ? "btn-primary" : "btn-secondary"}`}
            style={{ padding: "4px 12px", fontSize: 12 }}
            onClick={() => toggleMode(modeKey(m))}
          >
            {m.mode} {m.direction === "inbound" ? "↓" : "↑"}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>CONSTRAINTS</span>
        <button
          type="button"
          className={`btn ${activeConstraints.size === 0 ? "btn-primary" : "btn-secondary"}`}
          style={{ padding: "4px 12px", fontSize: 12 }}
          onClick={() => setActiveConstraints(new Set())}
        >
          All
        </button>
        {SCHEDULING_CONSTRAINTS.map((def) => {
          const total = constraintCounts.get(def.key) ?? 0;
          const inactive = total === 0;
          const on = activeConstraints.has(def.key);
          return (
            <button
              key={def.key}
              type="button"
              disabled={inactive}
              className={`constraint-toggle-chip${on ? " constraint-toggle-chip--on" : ""}${
                inactive ? " constraint-toggle-chip--inactive" : ""
              }`}
              style={
                on && !inactive ? ({ "--chip-color": def.color } as CSSProperties) : undefined
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
        {uncategorisedIdleCount > 0 && (
          <button
            type="button"
            className={`constraint-toggle-chip${
              activeConstraints.has("uncategorised") ? " constraint-toggle-chip--on" : ""
            }`}
            style={
              activeConstraints.has("uncategorised")
                ? ({ "--chip-color": "#94a3b8" } as CSSProperties)
                : undefined
            }
            onClick={() => toggleConstraint("uncategorised")}
          >
            <span className="constraint-toggle-chip-icon">
              <UncategorisedConstraintIcon size={13} />
            </span>
            Uncategorised idle
            <span className="constraint-toggle-chip-count">{uncategorisedIdleCount}</span>
          </button>
        )}
      </div>
      {constraintFilterLabel && (
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#64748b" }}>
          Showing rows where at least one visible leg was idle due to:{" "}
          <strong>{constraintFilterLabel}</strong>
        </p>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>VIEW</span>
        {(["daily", "events", "all"] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`btn ${viewMode === v ? "btn-primary" : "btn-secondary"}`}
            style={{ padding: "4px 12px", fontSize: 12 }}
            onClick={() => setViewMode(v)}
          >
            {v === "daily" ? "Daily summary" : v === "events" ? "Events only" : "All hours"}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#64748b" }}>LEG COLUMNS</span>
        <input
          type="number"
          min={1}
          max={64}
          className="form-input"
          style={{ width: 90, padding: "4px 8px", fontSize: 12 }}
          value={maxLegColumns}
          onChange={(e) => setMaxLegColumns(Math.max(1, Math.min(64, parseInt(e.target.value || "1", 10))))}
        />
        <span style={{ fontSize: 12, color: "#64748b" }}>
          Showing top {inventoryLegColumns.length} filtered leg columns
        </span>
      </div>

      <div style={{ marginBottom: 8, fontSize: 13, color: "#64748b" }}>
        {rowCountLabel}
        {activeConstraints.size > 0 && displayRows.length === 0 ? " — no rows match this constraint filter" : ""}
      </div>
      {viewMode === "daily" && (
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#64748b", maxWidth: 900, lineHeight: 1.5 }}>
          <strong>Daily mode columns:</strong> the number is how many <strong>loads started</strong> that day for that
          single leg lane (customer + direction + mode + lane). A green check appears only when that count is greater
          than zero. <strong>0</strong> means no visit started on that leg — hover the cell for roll-up text. Row tint
          still highlights the worst idle reason seen that day across visible legs (inventory, berth, pace, etc.).
        </p>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            overflowX: "auto",
            overflowY: "auto",
            maxHeight: "calc(100vh - 420px)",
            overflowAnchor: "none"
          }}
        >
          {activeCustomerList.length === 0 || activeModeList.length === 0 ? (
            <div style={{ padding: 24, color: "#64748b" }}>
              Select at least one customer and one transport mode to see the grid.
            </div>
          ) : inventoryLegColumns.length === 0 ? (
            <div style={{ padding: 24, color: "#64748b" }}>
              No transport legs in this run match the selected customers and modes.
            </div>
          ) : displayRows.length === 0 ? (
            <div style={{ padding: 24, color: "#64748b" }}>
              No rows match the selected constraint filter
              {constraintFilterLabel ? ` (${constraintFilterLabel})` : ""}. Clear constraints with{" "}
              <strong>All</strong> or select different types.
            </div>
          ) : (
            <table className="data-table" style={{ width: "100%", tableLayout: "fixed" }}>
              <thead
                ref={theadRef}
                style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 2 }}
              >
                <tr>
                  <th style={{ width: 56 }}>Hour</th>
                  <th style={{ width: 160 }}>Date &amp; Time</th>
                  {activeCustomerList.map((c) => (
                    <th key={c.id} style={{ textAlign: "right", minWidth: 88 }}>
                      {c.name}
                      {viewMode === "daily" ? " (min–max)" : ""}
                    </th>
                  ))}
                  <th style={{ textAlign: "right", minWidth: 100 }}>
                    {viewMode === "daily" ? "Terminal min–max" : "Terminal total"}
                  </th>
                  {inventoryLegColumns.map((col) => (
                    <th
                      key={`${col.customerId}-${modeKey(col)}-${col.legKey ?? "lane0"}`}
                      style={{ textAlign: "center", minWidth: 72, fontSize: 12 }}
                      title={`One transport leg: ${col.customerName}, ${col.mode}, ${
                        col.direction === "inbound" ? "inbound" : "outbound"
                      }. Each cell below is only this leg — hover for status and constraint checklist.`}
                    >
                      {col.customerName} — {col.mode}
                      {col.direction === "inbound" ? " ↓" : " ↑"}
                      {col.legLabel ? ` (${col.legLabel})` : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topSpacerHeight > 0 && (
                  <tr aria-hidden>
                    <td
                      colSpan={colCount}
                      style={{
                        height: topSpacerHeight,
                        padding: 0,
                        border: "none",
                        lineHeight: 0,
                        fontSize: 0
                      }}
                    />
                  </tr>
                )}
                {virtualSlice.rows.map((dr, rowIdx) => {
                  if (dr.kind === "hour") {
                    const row = dr.row;
                    const z = zebra(rowIdx);
                    const rowStyle = hourRowStylesFixed(row, activeCustomers, activeModes, z);
                    const dt = new Date(row.datetime).toLocaleString();
                    return (
                      <tr key={`h-${row.hour}-${row.datetime}-${virtualSlice.start + rowIdx}`} style={rowStyle}>
                        <td>{row.hour}</td>
                        <td style={{ fontSize: 12 }}>{dt}</td>
                        {activeCustomerList.map((c) => (
                          <td key={c.id} style={{ textAlign: "right", fontSize: 12 }}>
                            {(row.customerInventories[c.id] ?? 0).toLocaleString()}
                          </td>
                        ))}
                        <td style={{ textAlign: "right" }}>{row.terminalTotal.toLocaleString()}</td>
                        {inventoryLegColumns.map((col) => {
                          const status = findTransportStatusForLeg(
                            row,
                            col.customerId,
                            col.direction,
                            col.mode,
                            col.legKey
                          );
                          return (
                            <td
                              key={`${col.customerId}-${modeKey(col)}-${col.legKey ?? "lane0"}`}
                              onPointerEnter={(e) =>
                                showLegModeTooltip(
                                  e,
                                  buildHourLegModeTooltipContent(
                                    row,
                                    col.customerName,
                                    col.customerId,
                                    col.direction,
                                    col.mode,
                                    col.legKey,
                                    col.legLabel
                                  )
                                )
                              }
                              onPointerMove={moveLegModeTooltip}
                              onPointerLeave={hideLegModeTooltip}
                              style={{
                                textAlign: "center",
                                cursor: "help",
                                fontSize: 14
                              }}
                            >
                              <TransportStatusIcon status={status} />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  }

                  const d = dr.row;
                  let worstDay: TransportModeStatus["blockingConstraint"] = null;
                  for (const col of inventoryLegColumns) {
                    const a = d.modeAgg[aggKey(col.customerId, col)];
                    if (a?.worst) worstDay = higherConstraint(worstDay, a.worst);
                  }
                  const dailyZebra = zebra(rowIdx);
                  let dailyStyle: CSSProperties = {
                    ...dailyZebra,
                    verticalAlign: "top",
                    height: ROW_HEIGHT,
                    maxHeight: ROW_HEIGHT,
                    overflow: "hidden",
                    fontSize: 12
                  };
                  if (worstDay === "insufficient_inventory") dailyStyle.background = "#fef2f2";
                  else if (worstDay === "tank_full") dailyStyle.background = "#fffbeb";
                  else if (worstDay === "roundtrip") dailyStyle.background = "#eff6ff";
                  else if (worstDay === "pace_ahead" || worstDay === "optimizer_days_of_cover")
                    dailyStyle.background = "#f1f5f9";

                  return (
                    <tr key={`d-${d.dayKey}-${virtualSlice.start + rowIdx}`} style={dailyStyle}>
                      <td>—</td>
                      <td>{d.dateLabel}</td>
                      {activeCustomerList.map((c) => (
                        <td key={c.id} style={{ textAlign: "right" }}>
                          {(d.customerMin[c.id] ?? 0).toLocaleString()} –{" "}
                          {(d.customerMax[c.id] ?? 0).toLocaleString()}
                        </td>
                      ))}
                      <td style={{ textAlign: "right" }}>
                        {d.terminalMin.toLocaleString()} – {d.terminalMax.toLocaleString()}
                      </td>
                      {inventoryLegColumns.map((col) => {
                        const a = d.modeAgg[aggKey(col.customerId, col)] ?? {
                          loadedCount: 0,
                          worst: null,
                          sampleDetail: null
                        };
                        const wIcon = a.worst;
                        return (
                          <td
                            key={`${col.customerId}-${modeKey(col)}-${col.legKey ?? "lane0"}`}
                            onPointerEnter={(e) =>
                              showLegModeTooltip(
                                e,
                                buildDailyLegModeTooltipContent(
                                  col.customerName,
                                  d.dateLabel,
                                  col,
                                  a,
                                  col.legLabel
                                )
                              )
                            }
                            onPointerMove={moveLegModeTooltip}
                            onPointerLeave={hideLegModeTooltip}
                            style={{ textAlign: "center", fontSize: 12, cursor: "help" }}
                          >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {a.loadedCount > 0 ? (
                                <>
                                  {a.loadedCount}
                                  <CheckCircle2 size={13} color="#22c55e" strokeWidth={2} aria-hidden />
                                </>
                              ) : (
                                "0"
                              )}
                            </span>
                            {wIcon ? (
                              <span
                                style={{ marginLeft: 4, display: "inline-flex", verticalAlign: "middle" }}
                                aria-hidden
                              >
                                <WorstConstraintIcon constraint={wIcon} />
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {bottomSpacerHeight > 0 && (
                  <tr aria-hidden>
                    <td
                      colSpan={colCount}
                      style={{
                        height: bottomSpacerHeight,
                        padding: 0,
                        border: "none",
                        lineHeight: 0,
                        fontSize: 0
                      }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {legModeTooltip && (
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: Math.min(legModeTooltip.x + 12, window.innerWidth - 392),
            top: Math.min(legModeTooltip.y + 12, window.innerHeight - 280),
            maxWidth: 380,
            maxHeight: "min(70vh, 440px)",
            overflow: "auto",
            padding: "10px 12px",
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            boxShadow: "0 10px 40px rgba(15,23,42,0.2)",
            zIndex: 100,
            fontSize: 12,
            lineHeight: 1.45,
            color: "#1e293b",
            pointerEvents: "none",
            whiteSpace: "pre-wrap"
          }}
        >
          {legModeTooltip.content}
        </div>
      )}
    </div>
  );
}
