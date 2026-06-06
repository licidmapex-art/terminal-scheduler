import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { SimulationLogRow, TransportModeStatus } from "../../engine/simulationLog";

type LegOption = {
  key: string;
  label: string;
  customerId: string;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  legKey?: string;
};

function statusLegKey(s: TransportModeStatus): string {
  return `${s.customerId}:${s.direction}:${s.mode}:${s.legKey ?? "lane0"}`;
}

export default function Debugging() {
  const [simulationLog, setSimulationLog] = useState<SimulationLogRow[]>([]);
  const [optimizerMultiplier, setOptimizerMultiplier] = useState<number>(0);
  const [selectedLegKey, setSelectedLegKey] = useState<string>("");

  useEffect(() => {
    async function load() {
      if (!window.schedulerAPI || !window.dbAPI) return;
      const [log, configs] = await Promise.all([
        window.schedulerAPI.getSimulationLog() as Promise<SimulationLogRow[]>,
        window.dbAPI.getSimulationConfigs() as Promise<
          Array<{ optimizerRelativeDocMultiplier?: number }>
        >
      ]);
      setSimulationLog(Array.isArray(log) ? log : []);
      const cfg = Array.isArray(configs) ? configs[0] : undefined;
      const mult =
        typeof cfg?.optimizerRelativeDocMultiplier === "number" &&
        Number.isFinite(cfg.optimizerRelativeDocMultiplier)
          ? Math.max(0, cfg.optimizerRelativeDocMultiplier)
          : 0;
      setOptimizerMultiplier(mult);
    }
    load();
  }, []);

  const legOptions = useMemo((): LegOption[] => {
    const map = new Map<string, LegOption>();
    for (const row of simulationLog) {
      for (const s of row.transportStatus ?? []) {
        const key = statusLegKey(s);
        if (!map.has(key)) {
          const lane = s.legLabel ? ` (${s.legLabel})` : "";
          map.set(key, {
            key,
            label: `${s.customerName} - ${s.direction} ${s.mode}${lane}`,
            customerId: s.customerId,
            direction: s.direction,
            mode: s.mode,
            legKey: s.legKey
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [simulationLog]);

  useEffect(() => {
    if (!selectedLegKey && legOptions.length > 0) {
      setSelectedLegKey(legOptions[0]!.key);
    } else if (selectedLegKey && !legOptions.some((o) => o.key === selectedLegKey)) {
      setSelectedLegKey(legOptions[0]?.key ?? "");
    }
  }, [legOptions, selectedLegKey]);

  const selected = legOptions.find((o) => o.key === selectedLegKey);

  const chartData = useMemo(() => {
    if (!selected) return [];
    return simulationLog.map((row) => {
      const status = (row.transportStatus ?? []).find(
        (s) =>
          s.customerId === selected.customerId &&
          s.direction === selected.direction &&
          s.mode === selected.mode &&
          (s.legKey ?? "lane0") === (selected.legKey ?? "lane0")
      );
      const avg = row.averageCustomerDaysOfCover ?? null;
      const relativeThreshold =
        avg != null && Number.isFinite(avg) && optimizerMultiplier > 0
          ? optimizerMultiplier * avg
          : null;
      return {
        hour: row.hour,
        sortDoc: status?.daysOfCover ?? null,
        optimizerDoc: status?.optimizerDaysOfCover ?? null,
        averageDoc: avg,
        relativeThreshold
      };
    });
  }, [simulationLog, selected, optimizerMultiplier]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Debugging</h1>
          <p className="page-subtitle">
            Optimizer diagnostics: compare scheduler DoC and optimizer DoC by leg.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">Days-of-cover formulas (reminder)</div>
        <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
          Inbound sort DoC = inventory / outbound pressure per day. Outbound sort DoC = headroom / inbound pressure per
          day (or raw headroom when inbound pressure is zero).
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
          Optimizer DoC uses the same directional formulas but with relevant inventory context: terminal inventory for
          shared modes (`shared_inventory`, `shared_shipping`) and customer inventory for non-shared modes.
        </p>
        <p style={{ margin: "0 0 0", fontSize: 13, color: "#475569", lineHeight: 1.55 }}>
          Relative optimizer blocks when optimizer DoC &gt; <strong>× average</strong> cross-customer DoC at that hour
          (mean of each customer&apos;s tightest leg).
        </p>
      </div>

      <div className="card">
        <div className="card-title">Optimizer DoC timeline</div>
        <div style={{ marginBottom: 12, maxWidth: 520 }}>
          <label className="form-label">Leg</label>
          <select
            className="form-select"
            value={selectedLegKey}
            onChange={(e) => setSelectedLegKey(e.target.value)}
          >
            {legOptions.length === 0 ? <option value="">No legs found</option> : null}
            {legOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="form-helper" style={{ marginTop: 8 }}>
            Relative optimizer: <strong>{optimizerMultiplier.toFixed(2)}×</strong> average DoC{" "}
            {optimizerMultiplier === 0 ? "(disabled)" : ""}
          </div>
        </div>

        {selected && chartData.length > 0 ? (
          <div style={{ padding: "0 8px 12px" }}>
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" tick={{ fontSize: 12 }} />
                <YAxis
                  domain={[0, "auto"]}
                  tick={{ fontSize: 12 }}
                  label={{ value: "Days of cover", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
                />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="averageDoc"
                  name="Average DoC (all customers)"
                  stroke="#64748b"
                  dot={false}
                  connectNulls={false}
                  strokeWidth={2}
                  strokeDasharray="6 3"
                />
                {optimizerMultiplier > 0 ? (
                  <Line
                    type="monotone"
                    dataKey="relativeThreshold"
                    name={`${optimizerMultiplier}× average`}
                    stroke="#ef4444"
                    dot={false}
                    connectNulls={false}
                    strokeWidth={2}
                    strokeDasharray="4 4"
                  />
                ) : null}
                <Line
                  type="monotone"
                  dataKey="sortDoc"
                  name="Sort DoC (current log metric)"
                  stroke="#2563eb"
                  dot={false}
                  connectNulls={false}
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="optimizerDoc"
                  name="Optimizer DoC (constraint metric)"
                  stroke="#7c3aed"
                  dot={false}
                  connectNulls={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">🧪</div>
            <div className="empty-state-title">No debug series yet</div>
            <div className="empty-state-text">
              Run scheduler to populate transport statuses and optimizer days-of-cover snapshots.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
