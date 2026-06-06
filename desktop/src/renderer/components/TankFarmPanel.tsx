import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";

export default function TankFarmPanel() {
  const location = useLocation();
  const [tankCount, setTankCount] = useState("4");
  const [configId, setConfigId] = useState<string | null>(null);
  const [totalStorageCapacity, setTotalStorageCapacity] = useState(100000);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!window.dbAPI?.getSimulationConfigs) return;
    const configs = (await window.dbAPI.getSimulationConfigs()) as Array<
      Record<string, unknown> & { id?: string }
    >;
    const c = configs[0];
    if (!c) {
      setConfigId(null);
      return;
    }
    setConfigId(typeof c.id === "string" ? c.id : null);
    setTankCount(String(typeof c.tankCount === "number" && c.tankCount >= 1 ? c.tankCount : 4));
    setTotalStorageCapacity(Number(c.totalStorageCapacity ?? 100000));
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load, location.pathname]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!window.dbAPI || !configId) {
      setError("Set the planning horizon and storage under Terminal first.");
      return;
    }
    const tanks = parseInt(tankCount, 10);
    if (isNaN(tanks) || tanks < 1 || !Number.isInteger(tanks)) {
      setError("Number of tanks must be an integer ≥ 1");
      return;
    }
    setBusy(true);
    try {
      const configs = (await window.dbAPI.getSimulationConfigs()) as Array<
        Record<string, unknown> & { id: string }
      >;
      const c = configs[0];
      if (!c) {
        setError("No terminal configuration found.");
        return;
      }
      const impliedPerTank = Math.max(1, Math.round(totalStorageCapacity / tanks));
      await window.dbAPI.updateSimulationConfig(configId, {
        startDate: c.startDate instanceof Date ? c.startDate : new Date(String(c.startDate)),
        endDate: c.endDate instanceof Date ? c.endDate : new Date(String(c.endDate)),
        pipelineFlowRate: Number(c.pipelineFlowRate ?? 0),
        pipelineDirection: (c.pipelineDirection === "outbound" ? "outbound" : "inbound") as
          | "inbound"
          | "outbound",
        totalStorageCapacity: Number(c.totalStorageCapacity ?? 100000),
        storageMode: (c.storageMode as string) ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: Number(
          c.sharedInventoryCustomerDeficitLimitTonnes ?? 0
        ),
        pacerRoundingDirection: c.pacerRoundingDirection === "down" ? "down" : "up",
        pacerRoundAtDecile: Number(c.pacerRoundAtDecile ?? 1),
        optimizerRelativeDocMultiplier: Number(c.optimizerRelativeDocMultiplier ?? 0),
        minSlotIntervalHours: Number(c.minSlotIntervalHours ?? 0),
        preOpsHours: Number(c.preOpsHours ?? 0),
        postOpsHours: Number(c.postOpsHours ?? 0),
        tankCount: tanks,
        tankCapacity: impliedPerTank
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-title">Storage tanks (visual)</div>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
        Number of tanks drawn on the Simulation schematic. Total storage capacity used by the scheduler
        is set under <strong>Terminal</strong> — not here.
      </p>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <form onSubmit={handleSave} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, maxWidth: 200 }}>
          <label className="form-label">Number of tanks</label>
          <input
            type="number"
            min={1}
            step={1}
            className="form-input"
            value={tankCount}
            onChange={(e) => setTankCount(e.target.value)}
            disabled={busy || !configId}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !configId}>
          Save
        </button>
        {saved && (
          <span style={{ color: "#15803d", fontSize: 14, fontWeight: 500 }}>✓ Saved</span>
        )}
      </form>
      {!configId && (
        <p className="form-helper" style={{ marginTop: 10, marginBottom: 0 }}>
          Open Terminal configuration and save once to enable tank settings.
        </p>
      )}
    </div>
  );
}
