import { useCallback, useEffect, useState } from "react";
import type { Customer, StochasticConfig } from "../../types";
import StochasticConfigForm from "../components/StochasticConfigForm";
import ErrorBoundary from "../components/ErrorBoundary";
import { PageTitleWithHelp } from "../components/HelpPopover";
import { useStore } from "../store";
import {
  defaultStochasticConfig,
  normalizeStochasticConfig
} from "../lib/defaultStochasticConfig";

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export default function Stochastics() {
  const [formKey, setFormKey] = useState(0);
  const [stochasticConfig, setStochasticConfig] = useState<StochasticConfig>(defaultStochasticConfig);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [configId, setConfigId] = useState<string | null>(null);
  const [configSnapshot, setConfigSnapshot] = useState<Record<string, unknown> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);

  const loadAll = useCallback(async () => {
    if (!window.dbAPI?.getSimulationConfigs || !window.dbAPI.getCustomers) return;
    try {
      const [configs, customerRows] = await Promise.all([
        window.dbAPI.getSimulationConfigs(),
        window.dbAPI.getCustomers()
      ]);
      setCustomers(Array.isArray(customerRows) ? (customerRows as Customer[]) : []);
      const c = (Array.isArray(configs) ? configs[0] : undefined) as Record<string, unknown> | undefined;
      if (!c || typeof c.id !== "string") {
        setConfigId(null);
        setConfigSnapshot(null);
        setStochasticConfig(defaultStochasticConfig());
        return;
      }
      setConfigId(c.id);
      const { id: _id, ...rest } = c;
      setConfigSnapshot(rest);
      setStochasticConfig(normalizeStochasticConfig(c.stochasticConfig));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll, formKey, lastSchedulerRun]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.dbAPI?.updateSimulationConfig || !configId || !configSnapshot) {
      setError("Save terminal configuration first (Configuration → Terminal).");
      return;
    }
    setError(null);
    try {
      await window.dbAPI.updateSimulationConfig(configId, {
        ...configSnapshot,
        startDate: toIsoDate(configSnapshot.startDate),
        endDate: toIsoDate(configSnapshot.endDate),
        stochasticConfig
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await loadAll();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp
              title="Stochastics"
              help="Configure random arrival delays, pipeline variation, and terminal immobilisation. Use Sample once on the Schedule Gantt to preview one scenario; the baseline schedule is not overwritten."
            />
          </div>
        </div>

        {!configId && (
          <div className="schedule-modified-alert" role="status" style={{ marginBottom: 16 }}>
            <strong>No terminal configuration</strong>
            <span> Open Configuration → Terminal and save the planning horizon first.</span>
          </div>
        )}

        {error && (
          <div className="schedule-modified-alert" role="alert" style={{ marginBottom: 16, borderColor: "#fca5a5" }}>
            <strong>Could not save</strong>
            <span> {error}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="config-layout config-layout--wide">
          <StochasticConfigForm
            value={stochasticConfig}
            onChange={setStochasticConfig}
            customers={customers}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button type="submit" className="btn btn-primary" disabled={!configId}>
              Save stochastics
            </button>
            {saved && (
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#15803d",
                  fontSize: 14,
                  fontWeight: 500
                }}
              >
                Saved
              </span>
            )}
          </div>
        </form>
      </div>
    </ErrorBoundary>
  );
}
