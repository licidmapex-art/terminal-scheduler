import { TrendingUp } from "lucide-react";
import { useMemo } from "react";
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
import { resolveCustomerChartColor } from "../lib/customerChartColor";

interface CustomerLite {
  id: string;
  name: string;
  chartColor?: string | null;
}

interface Props {
  /** Per-customer hourly DoC series (engine-aligned composite; see Analytics). */
  docTrendByCustomer: Record<string, Array<number | null>>;
  startDate: string | null;
  customers: CustomerLite[];
}

const SAMPLE_HOUR_STEP = 6;

function formatDocTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v >= 100) return `${Math.round(v)}`;
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export default function DocTimelineChart({ docTrendByCustomer, startDate, customers }: Props) {
  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    customers.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [customers]);

  const chartData = useMemo(() => {
    const ids = Object.keys(docTrendByCustomer);
    if (ids.length === 0 || !startDate) return [];
    const start = new Date(startDate);
    if (Number.isNaN(start.getTime())) return [];
    const maxLen = Math.max(...ids.map((id) => docTrendByCustomer[id]?.length ?? 0));
    const rows: Array<Record<string, string | number | null>> = [];
    for (let h = 0; h < maxLen; h += SAMPLE_HOUR_STEP) {
      const pointDate = new Date(start.getTime() + h * 60 * 60 * 1000);
      const row: Record<string, string | number | null> = {
        date: pointDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        hourIndex: h
      };
      for (const cid of ids) {
        const arr = docTrendByCustomer[cid];
        const v = arr && h < arr.length ? arr[h] : null;
        row[cid] = v == null || !Number.isFinite(v) ? null : v;
      }
      rows.push(row);
    }
    return rows;
  }, [docTrendByCustomer, startDate]);

  const seriesIds = Object.keys(docTrendByCustomer);

  if (seriesIds.length === 0 || chartData.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <TrendingUp size={48} strokeWidth={1.5} />
        </div>
        <div className="empty-state-title">No days-of-cover timeline</div>
        <div className="empty-state-text">
          No customer had a positive DoC denominator (pipeline and/or scheduled transport targets from the model). Add
          throughput / MEPS so slot targets are derived, or set pipeline flow.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 16px 16px" }}>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis
            domain={[0, "auto"]}
            tick={{ fontSize: 12 }}
            tickFormatter={formatDocTick}
            label={{ value: "Days (DoC)", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
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
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>{label}</div>
                  {payload.map((p) => {
                    const raw = p.value;
                    const v = typeof raw === "number" ? raw : Number.NaN;
                    const pretty = Number.isFinite(v) ? formatDocTick(v) : "—";
                    return (
                      <div key={p.dataKey ?? p.name}>
                        {customerById.get(String(p.dataKey))?.name ?? p.dataKey}: {pretty} d
                      </div>
                    );
                  })}
                </div>
              );
            }}
          />
          <Legend />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" />
          {seriesIds.map((cid, i) => (
            <Line
              key={cid}
              type="monotone"
              dataKey={cid}
              name={customerById.get(cid)?.name ?? cid}
              stroke={resolveCustomerChartColor(
                customerById.get(cid)?.chartColor,
                orderIndex.get(cid) ?? i
              )}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
