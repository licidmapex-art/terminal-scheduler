import { useMemo, useState, useCallback, useEffect, type CSSProperties } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer
} from "recharts";
import type { SimulationLogRow } from "../../engine/simulationLog";
import { formatDirectionModeLabel } from "../../engine/pacing";
import { resolveCustomerChartColor } from "../lib/customerChartColor";
import { useChartHourZoom } from "../hooks/useChartHourZoom";
import ChartHourZoomToolbar from "./ChartHourZoomToolbar";

export type MetricKey = "inventory" | "doc" | "pacing";

interface CustomerLite {
  id: string;
  name: string;
  chartColor?: string | null;
}

interface Props {
  customers: CustomerLite[];
  simulationLog: SimulationLogRow[];
  docTrendByCustomer: Record<string, Array<number | null>>;
  /** customerId → direction:mode → hourly pacing % */
  pacingByCustomerMode: Record<string, Record<string, number[]>>;
  startDate: string | null;
}

const SAMPLE_HOUR_STEP = 6;
const ALL_METRICS: MetricKey[] = ["inventory", "doc", "pacing"];
/** Only draw pacing segments strictly behind the pacer (same idea as pipeline interruption bands). */
const PACING_ON_PACE_THRESHOLD = 100;

function isPacingDeficit(v: number): boolean {
  return Number.isFinite(v) && v < PACING_ON_PACE_THRESHOLD;
}

function legHasPacingDeficit(series: number[]): boolean {
  return series.some(isPacingDeficit);
}

const METRIC_LABELS: Record<MetricKey, string> = {
  inventory: "Inventory",
  doc: "Days of cover",
  pacing: "Pacing %"
};

function formatDocTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v >= 100) return `${Math.round(v)}`;
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function invKey(cid: string): string {
  return `inv_${cid}`;
}
function docKey(cid: string): string {
  return `doc_${cid}`;
}
function pacingKey(cid: string, directionMode: string): string {
  return `pace_${cid}_${directionMode.replace(/:/g, "_")}`;
}

/** Pseudo-customer id for cross-customer average series (toggle like any customer). */
export const AVERAGE_CUSTOMER_ID = "__all_customers_avg__";
const AVERAGE_CUSTOMER_NAME = "Average (all customers)";

const AVG_INV_KEY = "inv_avg";
const AVG_DOC_KEY = "doc_avg";
const AVG_PACE_KEY = "pace_avg";
const AVG_STROKE = "#0f172a";

function averageFinite(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

interface ChartLineSpec {
  key: string;
  dataKey: string;
  name: string;
  stroke: string;
  yAxisId: string;
  type: "stepAfter" | "monotone";
  strokeDasharray?: string;
  strokeWidth: number;
  metric: MetricKey;
  isAverage?: boolean;
}

function ChartLegend({ lines }: { lines: ChartLineSpec[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="multi-metric-legend-panel" role="list" aria-label="Chart series">
      {lines.map((line) => (
        <div key={line.key} className="multi-metric-legend-item" role="listitem">
          <svg className="multi-metric-legend-swatch" width={40} height={14} aria-hidden>
            <line
              x1={0}
              y1={7}
              x2={40}
              y2={7}
              stroke={line.stroke}
              strokeWidth={line.strokeWidth}
              strokeDasharray={line.strokeDasharray}
            />
          </svg>
          <span
            className={`multi-metric-legend-label${line.isAverage ? " multi-metric-legend-label--avg" : ""}`}
          >
            {line.name}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function MultiMetricChart({
  customers,
  simulationLog,
  docTrendByCustomer,
  pacingByCustomerMode,
  startDate
}: Props) {
  const [enabledMetrics, setEnabledMetrics] = useState<Set<MetricKey>>(
    () => new Set(ALL_METRICS)
  );
  const [enabledCustomers, setEnabledCustomers] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (customers.length === 0) return;
    setEnabledCustomers((prev) => {
      const defaultIds = customers.map((c) => c.id);
      if (prev.size === 0) return new Set(defaultIds);
      const next = new Set<string>();
      for (const c of customers) {
        if (prev.has(c.id)) next.add(c.id);
      }
      if (prev.has(AVERAGE_CUSTOMER_ID)) next.add(AVERAGE_CUSTOMER_ID);
      if (next.size === 0) return new Set(defaultIds);
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

  const showAverageSeries = enabledCustomers.has(AVERAGE_CUSTOMER_ID);

  const chartData = useMemo(() => {
    if (maxHour <= 0 && simulationLog.length === 0) return [];
    const customerIds = customers.map((c) => c.id);
    const rows: Array<Record<string, string | number | null>> = [];
    for (let h = 0; h <= maxHour; h += SAMPLE_HOUR_STEP) {
      const row: Record<string, string | number | null> = {
        hourIndex: h,
        date:
          chartStartDate != null
            ? new Date(chartStartDate.getTime() + h * 3_600_000).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric"
              })
            : String(h)
      };
      const logRow = logByHour.get(h);
      const invForAvg: number[] = [];
      const docForAvg: number[] = [];
      const paceForAvg: number[] = [];

      for (const cid of customerIds) {
        const inv = logRow?.customerInventories?.[cid];
        const invVal = inv != null && Number.isFinite(inv) ? inv : null;
        row[invKey(cid)] = invVal;
        if (invVal != null) invForAvg.push(invVal);

        const docArr = docTrendByCustomer[cid];
        const docVal = docArr && h < docArr.length ? docArr[h] : null;
        const docNum = docVal != null && Number.isFinite(docVal) ? docVal : null;
        row[docKey(cid)] = docNum;
        if (docNum != null) docForAvg.push(docNum);

        const byMode = pacingByCustomerMode[cid];
        if (byMode) {
          const custPaceVals: number[] = [];
          for (const [dk, paceArr] of Object.entries(byMode)) {
            const paceVal = h < paceArr.length ? paceArr[h] : null;
            const paceNum =
              paceVal != null && isPacingDeficit(paceVal) ? paceVal : null;
            row[pacingKey(cid, dk)] = paceNum;
            if (paceNum != null) custPaceVals.push(paceNum);
          }
          if (custPaceVals.length > 0) {
            const custMean = averageFinite(custPaceVals);
            if (custMean != null) paceForAvg.push(custMean);
          }
        }
      }

      if (customerIds.length > 0) {
        row[AVG_INV_KEY] = averageFinite(invForAvg);
        const logAvgDoc = logRow?.averageCustomerDaysOfCover;
        row[AVG_DOC_KEY] =
          logAvgDoc != null && Number.isFinite(logAvgDoc)
            ? logAvgDoc
            : averageFinite(docForAvg);
        const paceAvg = averageFinite(paceForAvg);
        row[AVG_PACE_KEY] = paceAvg != null && isPacingDeficit(paceAvg) ? paceAvg : null;
      }

      rows.push(row);
    }
    return rows;
  }, [
    maxHour,
    simulationLog.length,
    customers,
    chartStartDate,
    logByHour,
    docTrendByCustomer,
    pacingByCustomerMode
  ]);

  const toggleMetric = useCallback((key: MetricKey) => {
    setEnabledMetrics((prev) => {
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

  const showInv = enabledMetrics.has("inventory");
  const showDoc = enabledMetrics.has("doc");
  const showPacing = enabledMetrics.has("pacing");

  const hasChartData = chartData.length > 0 && simulationLog.length > 0;

  const { viewDomain, zoomIn, zoomOut, handleWheel, resetZoom, isZoomed } =
    useChartHourZoom(maxHour);

  const lines = useMemo((): ChartLineSpec[] => {
    const out: ChartLineSpec[] = [];
    customers.forEach((c, i) => {
      if (!enabledCustomers.has(c.id)) return;
      const color = resolveCustomerChartColor(c.chartColor, orderIndex.get(c.id) ?? i);
      const baseName = c.name;

      if (showInv) {
        out.push({
          key: `inv-${c.id}`,
          dataKey: invKey(c.id),
          name: `${baseName} · inventory`,
          stroke: color,
          yAxisId: "inv",
          type: "stepAfter",
          strokeWidth: 2.5,
          metric: "inventory"
        });
      }
      if (showDoc && docTrendByCustomer[c.id]) {
        out.push({
          key: `doc-${c.id}`,
          dataKey: docKey(c.id),
          name: `${baseName} · DoC`,
          stroke: color,
          yAxisId: "doc",
          type: "monotone",
          strokeDasharray: "8 4",
          strokeWidth: 2.5,
          metric: "doc"
        });
      }
      if (showPacing) {
        const byMode = pacingByCustomerMode[c.id];
        if (byMode) {
          const dks = Object.keys(byMode).sort();
          for (const dk of dks) {
            const series = byMode[dk];
            if (!series || !legHasPacingDeficit(series)) continue;
            out.push({
              key: `pace-${c.id}-${dk}`,
              dataKey: pacingKey(c.id, dk),
              name: `${baseName} · ${formatDirectionModeLabel(dk)} · behind pace`,
              stroke: color,
              yAxisId: "pacing",
              type: "monotone",
              strokeDasharray: "2 6",
              strokeWidth: 2,
              metric: "pacing"
            });
          }
        }
      }
    });

    if (showAverageSeries && customers.length > 0) {
      const avgName = AVERAGE_CUSTOMER_NAME;
      if (showInv) {
        out.push({
          key: "inv-avg",
          dataKey: AVG_INV_KEY,
          name: `${avgName} · inventory`,
          stroke: AVG_STROKE,
          yAxisId: "inv",
          type: "stepAfter",
          strokeDasharray: "10 5",
          strokeWidth: 3,
          metric: "inventory",
          isAverage: true
        });
      }
      if (showDoc) {
        out.push({
          key: "doc-avg",
          dataKey: AVG_DOC_KEY,
          name: `${avgName} · DoC`,
          stroke: AVG_STROKE,
          yAxisId: "doc",
          type: "monotone",
          strokeDasharray: "10 5",
          strokeWidth: 3,
          metric: "doc",
          isAverage: true
        });
      }
      if (showPacing && chartData.some((row) => row[AVG_PACE_KEY] != null)) {
        out.push({
          key: "pace-avg",
          dataKey: AVG_PACE_KEY,
          name: `${avgName} · behind pace`,
          stroke: AVG_STROKE,
          yAxisId: "pacing",
          type: "monotone",
          strokeDasharray: "10 5",
          strokeWidth: 3,
          metric: "pacing",
          isAverage: true
        });
      }
    }

    return out;
  }, [
    customers,
    enabledCustomers,
    showAverageSeries,
    orderIndex,
    showInv,
    showDoc,
    showPacing,
    docTrendByCustomer,
    pacingByCustomerMode,
    chartData
  ]);

  const hasPacingDeficitLines = lines.some((l) => l.metric === "pacing");

  if (!hasChartData) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-title">No timeline data</div>
        <div className="empty-state-text">Run the scheduler first to compare metrics over time</div>
      </div>
    );
  }

  return (
    <div className="multi-metric-chart">
      <div className="multi-metric-toolbar">
        <div className="multi-metric-toolbar-group">
          <span className="multi-metric-toolbar-label">Metrics</span>
          <div className="multi-metric-toggles">
            {ALL_METRICS.map((m) => (
              <button
                key={m}
                type="button"
                className={`metric-toggle${enabledMetrics.has(m) ? " metric-toggle--on" : ""}`}
                onClick={() => toggleMetric(m)}
              >
                {METRIC_LABELS[m]}
              </button>
            ))}
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
                  style={
                    on ? ({ "--chip-color": color } as CSSProperties) : undefined
                  }
                  onClick={() => toggleCustomer(c.id)}
                >
                  <span className="customer-toggle-chip-dot" style={{ background: color }} />
                  {c.name}
                </button>
              );
            })}
            {customers.length > 0 && (
              <button
                key={AVERAGE_CUSTOMER_ID}
                type="button"
                className={`customer-toggle-chip customer-toggle-chip--avg${
                  showAverageSeries ? " customer-toggle-chip--on" : ""
                }`}
                style={
                  showAverageSeries ? ({ "--chip-color": AVG_STROKE } as CSSProperties) : undefined
                }
                onClick={() => toggleCustomer(AVERAGE_CUSTOMER_ID)}
                title="Mean across all customers at each hour (DoC matches the relative optimizer)"
              >
                <span
                  className="customer-toggle-chip-dot customer-toggle-chip-dot--avg"
                  style={{ borderColor: AVG_STROKE }}
                />
                {AVERAGE_CUSTOMER_NAME}
              </button>
            )}
          </div>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          <div className="empty-state-text">Select at least one metric and one customer</div>
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
          <div className="multi-metric-chart-area" onWheel={handleWheel}>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart
                data={chartData}
                margin={{ top: 8, right: showDoc && showPacing ? 72 : 48, left: 8, bottom: 8 }}
              >
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
                {showInv && (
                  <YAxis
                    yAxisId="inv"
                    orientation="left"
                    tick={{ fontSize: 12 }}
                    label={{
                      value: "Tonnes",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 11 }
                    }}
                  />
                )}
                {showDoc && (
                  <YAxis
                    yAxisId="doc"
                    orientation="right"
                    tick={{ fontSize: 12 }}
                    tickFormatter={formatDocTick}
                    label={{
                      value: "Days (DoC)",
                      angle: 90,
                      position: "insideRight",
                      style: { fontSize: 11 }
                    }}
                  />
                )}
                {showPacing && (
                  <YAxis
                    yAxisId="pacing"
                    orientation="right"
                    width={showDoc ? 48 : 40}
                    domain={[0, 100]}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => `${v}%`}
                    label={{
                      value: "Pacing %",
                      angle: 90,
                      position: "insideRight",
                      offset: showDoc ? 20 : 0,
                      style: { fontSize: 11 }
                    }}
                  />
                )}
                {showPacing && hasPacingDeficitLines && (
                  <ReferenceLine
                    yAxisId="pacing"
                    y={100}
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                    label={{ value: "On pace", position: "insideTopRight", fontSize: 10, fill: "#64748b" }}
                  />
                )}
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const hourLabel =
                      typeof label === "number" ? formatHourLabel(label) : String(label ?? "");
                    return (
                      <div
                        style={{
                          background: "#1e293b",
                          color: "white",
                          padding: "12px 16px",
                          borderRadius: 8,
                          fontSize: 13,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
                          maxHeight: 320,
                          overflowY: "auto"
                        }}
                      >
                        <div style={{ marginBottom: 8, fontWeight: 600 }}>{hourLabel}</div>
                        {payload.map((p) => {
                          const raw = p.value;
                          const v = typeof raw === "number" ? raw : Number.NaN;
                          const name = String(p.name ?? p.dataKey ?? "");
                          let pretty = "—";
                          if (Number.isFinite(v)) {
                            if (name.includes("behind pace") || name.includes("Average · behind"))
                              pretty = `${v.toFixed(1)}%`;
                            else if (name.includes("DoC")) pretty = `${formatDocTick(v)} d`;
                            else pretty = `${Math.round(v).toLocaleString()} t`;
                          }
                          return (
                            <div key={p.dataKey ?? p.name}>
                              {name}: {pretty}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }}
                />
                {lines.map((line) => (
                  <Line
                    key={line.key}
                    yAxisId={line.yAxisId}
                    type={line.type}
                    dataKey={line.dataKey}
                    name={line.name}
                    stroke={line.stroke}
                    strokeWidth={line.strokeWidth}
                    strokeDasharray={line.strokeDasharray}
                    dot={false}
                    connectNulls={line.metric === "pacing" ? false : line.type === "stepAfter"}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ChartLegend lines={lines} />
          {showPacing && !hasPacingDeficitLines && (
            <p className="multi-metric-pace-note">
              No legs fell behind the pacer in this window — pacing lines only appear during gaps (like pipeline
              interruption on the Gantt).
            </p>
          )}
        </>
      )}
    </div>
  );
}
