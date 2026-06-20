import { useCallback, useEffect, useMemo, useState } from "react";
import type { Customer, MonteCarloAggregates, MonteCarloCustomerSummary } from "../../types";
import { normalizeMonteCarloSnapshot } from "../lib/normalizeMonteCarloSnapshot";
const STOCHASTIC_EVENT_KINDS = [
  "arrival_delay",
  "pipeline_reduction",
  "pipeline_stop",
  "immobilisation"
] as const;

export type SerializedMonteCarloSnapshot = {
  iterations: number;
  selectedIndex: number;
  baseSeed: number;
  runSeeds: number[];
  aggregates: MonteCarloAggregates;
  customerSummaries: MonteCarloCustomerSummary[];
  hasFullRuns: boolean;
};

const EVENT_LABELS: Record<string, string> = {
  arrival_delay: "Arrival delay",
  pipeline_reduction: "Pipeline reduction",
  pipeline_stop: "Pipeline stop",
  immobilisation: "Immobilisation"
};

const FEASIBILITY_WARNING_LABELS: Record<string, string> = {
  storage_shares_sum: "Storage shares sum",
  pipeline_interrupted: "Pipeline interrupted",
  borrowing_limit_reached: "Borrowing limit reached",
  terminal_inventory_trending: "Terminal inventory trending",
  customer_inventory_trending: "Customer inventory trending",
  average_doc_trending: "Average DoC trending",
  customer_doc_trending: "Customer DoC trending"
};

function feasibilityWarningLabel(key: string): string {
  return (
    FEASIBILITY_WARNING_LABELS[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatTonnes(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function pctBelowZeroClass(pct: number): string {
  if (pct >= 50) return "monte-carlo-num--critical";
  if (pct >= 10) return "monte-carlo-num--warn";
  return "";
}

function inventoryClass(v: number): string {
  return v < 0 ? "monte-carlo-num--critical" : "";
}

interface Props {
  customers: Customer[];
  stochasticsEnabled: boolean;
  hasSchedulerRun: boolean;
}

export default function MonteCarloResultsPanel({
  customers,
  stochasticsEnabled,
  hasSchedulerRun
}: Props) {
  const [iterations, setIterations] = useState(50);
  const [baseSeedInput, setBaseSeedInput] = useState("");
  const [snapshot, setSnapshot] = useState<SerializedMonteCarloSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    if (!window.schedulerAPI?.getMonteCarloState) return;
    const state = await window.schedulerAPI.getMonteCarloState();
    if (state.active && state.snapshot) {
      setSnapshot(normalizeMonteCarloSnapshot(state.snapshot as SerializedMonteCarloSnapshot));
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!window.schedulerAPI?.onMonteCarloProgress) return;
    const unsub = window.schedulerAPI.onMonteCarloProgress((p) => {
      setProgress({ done: p.done, total: p.total });
    });
    return unsub;
  }, []);

  const customerName = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id;
  }, [customers]);

  const terminalSummary = useMemo(() => {
    if (!snapshot) return null;
    const series = snapshot.aggregates.terminalInventory.p50;
    if (!series.length) return null;
    const all = [
      ...snapshot.aggregates.terminalInventory.p10,
      ...snapshot.aggregates.terminalInventory.p50,
      ...snapshot.aggregates.terminalInventory.p90
    ];
    const sum = series.reduce((s, v) => s + v, 0);
    return {
      minInventory: Math.min(...all),
      meanInventory: sum / series.length,
      maxInventory: Math.max(...all),
      pctHoursBelowZero:
        (series.filter((v) => v < 0).length / Math.max(1, series.length)) * 100
    };
  }, [snapshot]);

  const topWarnings = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot.aggregates.warningCounts).sort((a, b) => b[1] - a[1]);
  }, [snapshot]);

  const handleRun = async () => {
    if (!window.schedulerAPI?.runMonteCarlo) return;
    setError(null);
    setRunning(true);
    setProgress(null);
    try {
      await window.schedulerAPI.cancelMonteCarlo?.();
      const baseSeed =
        baseSeedInput.trim() === "" ? undefined : Number.parseInt(baseSeedInput.trim(), 10);
      const res = await window.schedulerAPI.runMonteCarlo({
        iterations,
        baseSeed: Number.isFinite(baseSeed!) ? baseSeed : undefined
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSnapshot(normalizeMonteCarloSnapshot(res.snapshot as SerializedMonteCarloSnapshot));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const handleCancel = async () => {
    await window.schedulerAPI?.cancelMonteCarlo?.();
  };

  const handleClear = async () => {
    await window.schedulerAPI?.clearMonteCarlo?.();
    setSnapshot(null);
    setError(null);
  };

  const handleExportCsv = () => {
    if (!snapshot) return;
    const rows: string[][] = [
      [
        "Customer",
        "Min inventory (t)",
        "Mean inventory (t)",
        "Max inventory (t)",
        "% hours below 0",
        "Warning rate"
      ]
    ];
    for (const s of snapshot.customerSummaries) {
      rows.push([
        customerName(s.customerId),
        s.minInventory.toFixed(0),
        s.meanInventory.toFixed(0),
        s.maxInventory.toFixed(0),
        s.pctHoursBelowZero.toFixed(2),
        (s.warningRate * 100).toFixed(1) + "%"
      ]);
    }
    if (terminalSummary) {
      rows.push([
        "Terminal (p50 series)",
        terminalSummary.minInventory.toFixed(0),
        terminalSummary.meanInventory.toFixed(0),
        terminalSummary.maxInventory.toFixed(0),
        terminalSummary.pctHoursBelowZero.toFixed(2),
        "—"
      ]);
    }
    rows.push([]);
    rows.push(["Hour", "Terminal p10", "Terminal p50", "Terminal p90"]);
    const n = snapshot.aggregates.terminalInventory.p50.length;
    for (let h = 0; h < n; h++) {
      rows.push([
        String(h),
        (snapshot.aggregates.terminalInventory.p10[h] ?? 0).toFixed(0),
        (snapshot.aggregates.terminalInventory.p50[h] ?? 0).toFixed(0),
        (snapshot.aggregates.terminalInventory.p90[h] ?? 0).toFixed(0)
      ]);
    }
    downloadCsv(`monte-carlo-${snapshot.iterations}-iterations.csv`, rows);
  };

  const canRun = stochasticsEnabled && hasSchedulerRun && !running;

  return (
    <div className="card config-section stochastic-monte-carlo-panel">
      <div className="config-section-header">
        <div>
          <div className="config-section-title-row">
            <div className="config-section-title">Monte Carlo analysis</div>
          </div>
          <p className="form-hint" style={{ marginTop: 4, marginBottom: 0 }}>
            Run many stochastic replays from the current schedule. Use the iteration scrubber on the
            Schedule Gantt to inspect individual draws; inventory shows a p10–p90 fan band.
          </p>
        </div>
      </div>

      {!hasSchedulerRun && (
        <div className="schedule-modified-alert" role="status" style={{ marginBottom: 12 }}>
          Run the scheduler on the Schedule tab first.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", marginBottom: 16 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Iterations (1–200)</span>
          <input
            type="range"
            min={1}
            max={200}
            value={iterations}
            onChange={(e) => setIterations(Number(e.target.value))}
            disabled={running}
          />
          <span style={{ fontSize: 12, color: "#64748b" }}>{iterations}</span>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Base seed (optional)</span>
          <input
            type="text"
            className="form-control"
            style={{ width: 120 }}
            placeholder="Random"
            value={baseSeedInput}
            onChange={(e) => setBaseSeedInput(e.target.value)}
            disabled={running}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canRun}
          onClick={() => void handleRun()}
        >
          {running ? "Running…" : "Run Monte Carlo"}
        </button>
        {running && (
          <button type="button" className="btn btn-secondary" onClick={() => void handleCancel()}>
            Cancel
          </button>
        )}
        {snapshot && !running && (
          <button type="button" className="btn btn-secondary" onClick={() => void handleClear()}>
            Clear results
          </button>
        )}
      </div>

      {running && progress && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            Progress: {progress.done} / {progress.total}
          </div>
          <div
            style={{
              height: 8,
              background: "#e2e8f0",
              borderRadius: 4,
              overflow: "hidden"
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                background: "#9333ea",
                transition: "width 0.15s"
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="schedule-modified-alert" role="alert" style={{ marginBottom: 12, borderColor: "#fca5a5" }}>
          {error}
        </div>
      )}

      {snapshot && (
        <>
          <div className="monte-carlo-run-summary">
            <div className="monte-carlo-stat-card">
              <div className="monte-carlo-stat-label">Iterations</div>
              <div className="monte-carlo-stat-value">{snapshot.iterations}</div>
            </div>
            <div className="monte-carlo-stat-card">
              <div className="monte-carlo-stat-label">Base seed</div>
              <div className="monte-carlo-stat-value monte-carlo-stat-value--mono">{snapshot.baseSeed}</div>
            </div>
            <div className="monte-carlo-stat-card">
              <div className="monte-carlo-stat-label">Storage mode</div>
              <div className="monte-carlo-stat-value monte-carlo-stat-value--sm">
                {snapshot.hasFullRuns ? "Full runs cached" : "Sparse (replay on scrub)"}
              </div>
            </div>
          </div>

          <div className="monte-carlo-results-section">
            <h4 className="monte-carlo-section-title">Stochastic events</h4>
            <p className="form-hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Total event counts summed across all iterations (one draw can produce multiple events).
            </p>
            <div className="monte-carlo-event-grid">
              {STOCHASTIC_EVENT_KINDS.map((kind) => (
                <div key={kind} className="monte-carlo-event-chip">
                  <span className="monte-carlo-event-chip-label">{EVENT_LABELS[kind] ?? kind}</span>
                  <span className="monte-carlo-event-chip-value">
                    {(snapshot.aggregates.eventHistograms[kind] ?? 0).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {topWarnings.length > 0 && (
            <div className="monte-carlo-results-section">
              <h4 className="monte-carlo-section-title">Feasibility warnings</h4>
              <p className="form-hint" style={{ marginTop: 0, marginBottom: 10 }}>
                Iterations in which each warning appeared (out of {snapshot.iterations}).
              </p>
              <div className="monte-carlo-warning-list">
                {topWarnings.map(([key, count]) => (
                  <div key={key} className="monte-carlo-warning-row">
                    <span className="monte-carlo-warning-label">{feasibilityWarningLabel(key)}</span>
                    <span className="monte-carlo-warning-count">
                      {count}/{snapshot.iterations}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="monte-carlo-results-section">
            <h4 className="monte-carlo-section-title">Inventory outcomes</h4>
            <p className="form-hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Min, mean, and max attributed inventory (t) across all simulation hours and iterations.
              Terminal row uses the median (p50) path across iterations.
            </p>
            <div className="monte-carlo-table-wrap">
              <table className="data-table monte-carlo-summary-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Min (t)</th>
                    <th>Mean (t)</th>
                    <th>Max (t)</th>
                    <th>% hours &lt; 0</th>
                    <th>Warning rate</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.customerSummaries.map((s) => (
                    <tr key={s.customerId}>
                      <td className="monte-carlo-customer-cell">{customerName(s.customerId)}</td>
                      <td className={inventoryClass(s.minInventory)}>{formatTonnes(s.minInventory)}</td>
                      <td className={inventoryClass(s.meanInventory)}>{formatTonnes(s.meanInventory)}</td>
                      <td>{formatTonnes(s.maxInventory)}</td>
                      <td className={pctBelowZeroClass(s.pctHoursBelowZero)}>
                        {s.pctHoursBelowZero.toFixed(1)}%
                      </td>
                      <td>{(s.warningRate * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
                {terminalSummary && (
                  <tfoot>
                    <tr className="monte-carlo-terminal-row">
                      <td>Terminal (p50 path)</td>
                      <td className={inventoryClass(terminalSummary.minInventory)}>
                        {formatTonnes(terminalSummary.minInventory)}
                      </td>
                      <td>{formatTonnes(terminalSummary.meanInventory)}</td>
                      <td>{formatTonnes(terminalSummary.maxInventory)}</td>
                      <td className={pctBelowZeroClass(terminalSummary.pctHoursBelowZero)}>
                        {terminalSummary.pctHoursBelowZero.toFixed(1)}%
                      </td>
                      <td>—</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          <div className="monte-carlo-actions">
            <button type="button" className="btn btn-secondary" onClick={handleExportCsv}>
              Download CSV
            </button>
          </div>
        </>
      )}
    </div>
  );
}
