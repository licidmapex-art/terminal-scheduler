import { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer
} from "recharts";
import { useStore } from "../store";
import { resolveCustomerChartColor } from "../lib/customerChartColor";

interface Customer {
  id: string;
  name: string;
  currentInventory?: number;
  chartColor?: string | null;
}

interface InventoryTimelineResponse {
  timeline: Record<string, number[]>;
  startDate: string | null;
  totalStorageCapacity?: number | null;
}

interface SimLogRow {
  hour: number;
  datetime?: string;
  customerInventories?: Record<string, number>;
  terminalTotal?: number;
}

export default function InventoryChart() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [timelineData, setTimelineData] = useState<InventoryTimelineResponse | null>(null);
  const [simulationLog, setSimulationLog] = useState<SimLogRow[]>([]);
  const [chartData, setChartData] = useState<Array<Record<string, string | number>>>([]);
  const [chartStartDate, setChartStartDate] = useState<Date | null>(null);
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [custs, inv, log] = await Promise.all([
        window.dbAPI.getCustomers() as Promise<Customer[]>,
        window.schedulerAPI.getInventoryTimeline() as Promise<InventoryTimelineResponse | null>,
        window.schedulerAPI.getSimulationLog() as Promise<SimLogRow[]>
      ]);
      setCustomers(custs ?? []);
      setTimelineData(inv);
      setSimulationLog(Array.isArray(log) ? log : []);
    }
    load();
  }, [lastSchedulerRun]);

  useEffect(() => {
    if (simulationLog.length === 0) {
      setChartData([]);
      setChartStartDate(null);
      return;
    }

    const sorted = [...simulationLog]
      .filter((r) => Number.isFinite(Number(r.hour)))
      .sort((a, b) => Number(a.hour) - Number(b.hour));
    const first = sorted[0];
    const firstDt = first?.datetime ? new Date(first.datetime) : null;
    const startDate =
      firstDt && !Number.isNaN(firstDt.getTime())
        ? firstDt
        : timelineData?.startDate
          ? new Date(timelineData.startDate)
          : null;
    setChartStartDate(startDate);
    const customerIds = [
      ...new Set([
        ...customers.map((c) => c.id),
        ...sorted.flatMap((r) => Object.keys(r.customerInventories ?? {}))
      ])
    ];
    const data: Array<Record<string, string | number>> = sorted.map((row) => {
      const h = Math.round(Number(row.hour));
      const out: Record<string, string | number> = {
        hourIndex: h,
        date:
          startDate != null
            ? new Date(startDate.getTime() + h * 60 * 60 * 1000).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric"
              })
            : String(h)
      };
      for (const cid of customerIds) {
        out[cid] = row.customerInventories?.[cid] ?? 0;
      }
      out["Terminal Total"] =
        row.terminalTotal ??
        customerIds.reduce((sum, cid) => sum + ((out[cid] as number) ?? 0), 0);
      return out;
    });
    setChartData(data);
  }, [timelineData, simulationLog, customers]);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const customerOrderIndex = useMemo(() => {
    const m = new Map<string, number>();
    customers.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [customers]);
  const customerSeriesIds = useMemo(() => {
    if (chartData.length === 0) return [];
    const keys = new Set<string>();
    for (const row of chartData) {
      for (const k of Object.keys(row)) {
        if (k === "hourIndex" || k === "date" || k === "Terminal Total") continue;
        keys.add(k);
      }
    }
    return Array.from(keys);
  }, [chartData]);

  const formatHourTick = (h: number): string => {
    if (!chartStartDate || !Number.isFinite(h)) return "";
    const d = new Date(chartStartDate.getTime() + h * 60 * 60 * 1000);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatHourLabel = (h: number): string => {
    if (!chartStartDate || !Number.isFinite(h)) return String(h);
    const d = new Date(chartStartDate.getTime() + h * 60 * 60 * 1000);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  if (chartData.length === 0 || simulationLog.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-title">No inventory data</div>
        <div className="empty-state-text">Run the scheduler first to see inventory timeline</div>
      </div>
    );
  }

  const totalStorageCapacity = timelineData.totalStorageCapacity ?? undefined;

  return (
    <div style={{ padding: "0 16px 16px" }}>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            type="number"
            dataKey="hourIndex"
            tick={{ fontSize: 12 }}
            tickFormatter={formatHourTick}
            domain={["dataMin", "dataMax"]}
            minTickGap={40}
          />
          <YAxis
            domain={["auto", "auto"]}
            tick={{ fontSize: 12 }}
            label={{ value: "Tonnes", angle: -90, position: "insideLeft" }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const hourLabel = typeof label === "number" ? formatHourLabel(label) : String(label ?? "");
              return (
                <div
                  style={{
                    background: "#1e293b",
                    color: "white",
                    padding: "12px 16px",
                    borderRadius: 8,
                    fontSize: 12,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
                  }}
                >
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>{hourLabel}</div>
                  {payload.map((p) => (
                    <div key={p.dataKey ?? p.name}>
                      {customerById.get(String(p.dataKey))?.name ?? p.dataKey}: {(p.value as number).toLocaleString()} t
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Legend />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" />
          {totalStorageCapacity != null && (
            <ReferenceLine
              y={totalStorageCapacity}
              stroke="#64748b"
              strokeDasharray="4 4"
              label={{ value: "Terminal capacity", position: "right" }}
            />
          )}
          <Line
            type="stepAfter"
            dataKey="Terminal Total"
            name="Terminal Total"
            stroke="#0f172a"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            connectNulls
          />
          {customerSeriesIds.map((cid, i) => (
            <Line
              key={cid}
              type="stepAfter"
              dataKey={cid}
              name={customerById.get(cid)?.name ?? cid}
              stroke={resolveCustomerChartColor(
                customerById.get(cid)?.chartColor,
                customerOrderIndex.get(cid) ?? i
              )}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
