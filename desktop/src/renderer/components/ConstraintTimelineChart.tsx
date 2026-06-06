import { useMemo, useState, useCallback, useEffect, type CSSProperties } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from "recharts";
import type { SimulationLogRow } from "../../engine/simulationLog";
import {
  SCHEDULING_CONSTRAINTS,
  constraintDataKey,
  type BlockingConstraintKey
} from "../lib/schedulingConstraints";
import { resolveCustomerChartColor } from "../lib/customerChartColor";
import { useChartHourZoom } from "../hooks/useChartHourZoom";
import ChartHourZoomToolbar from "./ChartHourZoomToolbar";

interface CustomerLite {
  id: string;
  name: string;
  chartColor?: string | null;
}

interface Props {
  customers: CustomerLite[];
  simulationLog: SimulationLogRow[];
  startDate: string | null;
}

interface ConstraintSummary {
  key: BlockingConstraintKey;
  legHours: number;
  customerIds: Set<string>;
}

function isBlockingIdle(
  action: string,
  blockingConstraint: SimulationLogRow["transportStatus"][number]["blockingConstraint"]
): blockingConstraint is BlockingConstraintKey {
  return action === "idle" && blockingConstraint != null;
}

export default function ConstraintTimelineChart({ customers, simulationLog, startDate }: Props) {
  const [enabledConstraints, setEnabledConstraints] = useState<Set<BlockingConstraintKey>>(
    () => new Set(SCHEDULING_CONSTRAINTS.map((c) => c.key))
  );
  const [enabledCustomers, setEnabledCustomers] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (customers.length === 0) return;
    setEnabledCustomers((prev) => {
      if (prev.size === 0) return new Set(customers.map((c) => c.id));
      const next = new Set<string>();
      for (const c of customers) {
        if (prev.has(c.id)) next.add(c.id);
      }
      if (next.size === 0) return new Set(customers.map((c) => c.id));
      for (const c of customers) {
        if (!prev.has(c.id) && !next.has(c.id)) next.add(c.id);
      }
      return next;
    });
  }, [customers]);

  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    customers.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [customers]);

  const chartStartDate = useMemo(() => {
    if (simulationLog.length === 0) return null;
    const sorted = [...simulationLog].sort((a, b) => a.hour - b.hour);
    const first = sorted[0];
    const firstDt = first?.datetime ? new Date(first.datetime) : null;
    if (firstDt && !Number.isNaN(firstDt.getTime())) return firstDt;
    if (startDate) {
      const d = new Date(startDate);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }, [simulationLog, startDate]);

  const maxHour = useMemo(() => {
    if (simulationLog.length === 0) return 0;
    return Math.max(...simulationLog.map((r) => r.hour));
  }, [simulationLog]);

  const logByHour = useMemo(() => {
    const m = new Map<number, SimulationLogRow>();
    for (const row of simulationLog) {
      m.set(Math.round(row.hour), row);
    }
    return m;
  }, [simulationLog]);

  const { chartData, summaries, activeConstraintKeys } = useMemo(() => {
    const customerFilter = enabledCustomers;
    const summariesAcc = new Map<BlockingConstraintKey, ConstraintSummary>();
    for (const def of SCHEDULING_CONSTRAINTS) {
      summariesAcc.set(def.key, { key: def.key, legHours: 0, customerIds: new Set() });
    }

    const rows: Array<Record<string, string | number>> = [];
    for (let h = 0; h <= maxHour; h++) {
      const row: Record<string, string | number> = { hourIndex: h };
      if (chartStartDate != null) {
        row.date = new Date(chartStartDate.getTime() + h * 3_600_000).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric"
        });
      }
      for (const def of SCHEDULING_CONSTRAINTS) {
        row[constraintDataKey(def.key)] = 0;
      }

      const logRow = logByHour.get(h);
      if (logRow) {
        for (const status of logRow.transportStatus ?? []) {
          if (!customerFilter.has(status.customerId)) continue;
          if (!isBlockingIdle(status.action, status.blockingConstraint)) continue;
          const key = status.blockingConstraint;
          const dk = constraintDataKey(key);
          row[dk] = (Number(row[dk]) || 0) + 1;
          const sum = summariesAcc.get(key)!;
          sum.legHours++;
          sum.customerIds.add(status.customerId);
        }
      }
      rows.push(row);
    }

    const active = SCHEDULING_CONSTRAINTS.filter(
      (def) => (summariesAcc.get(def.key)?.legHours ?? 0) > 0
    ).map((d) => d.key);

    return {
      chartData: rows,
      summaries: summariesAcc,
      activeConstraintKeys: active
    };
  }, [maxHour, logByHour, enabledCustomers, chartStartDate]);

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

  const formatHourTick = (h: number): string => {
    if (!chartStartDate || !Number.isFinite(h)) return "";
    const d = new Date(chartStartDate.getTime() + h * 3_600_000);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatHourLabel = (h: number): string => {
    if (!chartStartDate || !Number.isFinite(h)) return String(h);
    const d = new Date(chartStartDate.getTime() + h * 3_600_000);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const visibleBars = SCHEDULING_CONSTRAINTS.filter(
    (def) => enabledConstraints.has(def.key) && activeConstraintKeys.includes(def.key)
  );

  const { viewDomain, zoomIn, zoomOut, handleWheel, resetZoom, isZoomed } =
    useChartHourZoom(maxHour);

  const hasAnyBlocking = activeConstraintKeys.length > 0;

  if (simulationLog.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🚧</div>
        <div className="empty-state-title">No simulation log</div>
        <div className="empty-state-text">Run the scheduler to see when constraints blocked slot starts</div>
      </div>
    );
  }

  return (
    <div className="constraint-timeline-chart">
      <div className="multi-metric-toolbar">
        <div className="multi-metric-toolbar-group">
          <span className="multi-metric-toolbar-label">Constraints</span>
          <div className="multi-metric-toggles">
            {SCHEDULING_CONSTRAINTS.map((def) => {
              const on = enabledConstraints.has(def.key);
              const total = summaries.get(def.key)?.legHours ?? 0;
              const inactive = total === 0;
              return (
                <button
                  key={def.key}
                  type="button"
                  className={`constraint-toggle-chip${on && !inactive ? " constraint-toggle-chip--on" : ""}${
                    inactive ? " constraint-toggle-chip--inactive" : ""
                  }`}
                  style={
                    on && !inactive
                      ? ({ "--chip-color": def.color } as CSSProperties)
                      : undefined
                  }
                  onClick={() => !inactive && toggleConstraint(def.key)}
                  disabled={inactive}
                  title={
                    inactive
                      ? `${def.label} did not block any leg in this run`
                      : `${def.label}: ${total} leg-hour${total === 1 ? "" : "s"}`
                  }
                >
                  <span className="constraint-toggle-chip-icon" aria-hidden>
                    {def.icon}
                  </span>
                  {def.label}
                  {!inactive ? (
                    <span className="constraint-toggle-chip-count">{total}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="multi-metric-toolbar-group">
          <span className="multi-metric-toolbar-label">Customers</span>
          <div className="multi-metric-toggles">
            {customers.map((c, i) => {
              const on = enabledCustomers.has(c.id);
              const color = resolveCustomerChartColor(c.chartColor, orderIndex.get(c.id) ?? i);
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
      </div>

      {!hasAnyBlocking ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div className="empty-state-text">
            No blocking constraints recorded for the selected customers — legs either loaded or were idle with all
            checks passing.
          </div>
        </div>
      ) : visibleBars.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div className="empty-state-text">Select at least one constraint type that occurred in this run</div>
        </div>
      ) : (
        <>
          <ChartHourZoomToolbar
            viewDomain={viewDomain}
            chartStartDate={chartStartDate}
            onZoomIn={() => zoomIn()}
            onZoomOut={() => zoomOut()}
            onReset={resetZoom}
            isZoomed={isZoomed}
          />
          <div className="constraint-timeline-chart-area" onWheel={handleWheel}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  type="number"
                  dataKey="hourIndex"
                  tick={{ fontSize: 12 }}
                  tickFormatter={formatHourTick}
                  domain={viewDomain}
                  allowDataOverflow
                  minTickGap={40}
                />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12 }}
                label={{
                  value: "Legs blocked",
                  angle: -90,
                  position: "insideLeft",
                  style: { fontSize: 11 }
                }}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const hourLabel =
                    typeof label === "number" ? formatHourLabel(label) : String(label ?? "");
                  const items = payload.filter((p) => {
                    const v = typeof p.value === "number" ? p.value : Number(p.value);
                    return Number.isFinite(v) && v > 0;
                  });
                  if (items.length === 0) return null;
                  return (
                    <div
                      style={{
                        background: "#1e293b",
                        color: "white",
                        padding: "12px 16px",
                        borderRadius: 8,
                        fontSize: 13,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
                      }}
                    >
                      <div style={{ marginBottom: 8, fontWeight: 600 }}>{hourLabel}</div>
                      {items.map((p) => (
                        <div key={p.dataKey ?? p.name}>{String(p.name)}: {p.value}</div>
                      ))}
                    </div>
                  );
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {visibleBars.map((def) => (
                <Bar
                  key={def.key}
                  dataKey={constraintDataKey(def.key)}
                  name={`${def.icon} ${def.label}`}
                  stackId="constraints"
                  fill={def.color}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        </>
      )}
    </div>
  );
}
