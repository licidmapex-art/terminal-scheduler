import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { HelpPopover } from "./HelpPopover";

export default function TankFarmPanel() {
  const location = useLocation();
  const [totalStorageCapacity, setTotalStorageCapacity] = useState("100000");
  const [configId, setConfigId] = useState<string | null>(null);
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
    setTotalStorageCapacity(String(Number(c.totalStorageCapacity ?? 100000)));
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load, location.pathname]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!window.dbAPI || !configId) {
      setError("Set the planning horizon under Terminal first.");
      return;
    }
    const totalCap = parseFloat(totalStorageCapacity);
    if (isNaN(totalCap) || totalCap <= 0) {
      setError("Total storage capacity must be a positive number");
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
      await window.dbAPI.updateSimulationConfig(configId, {
        startDate: c.startDate instanceof Date ? c.startDate : new Date(String(c.startDate)),
        endDate: c.endDate instanceof Date ? c.endDate : new Date(String(c.endDate)),
        pipelineFlowRate: Number(c.pipelineFlowRate ?? 0),
        pipelineDirection: (c.pipelineDirection === "outbound" ? "outbound" : "inbound") as
          | "inbound"
          | "outbound",
        totalStorageCapacity: totalCap,
        storageMode: (c.storageMode as string) ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: Number(
          c.sharedInventoryCustomerDeficitLimitTonnes ?? 0
        ),
        pacerInboundRoundAtDecile: Number(c.pacerInboundRoundAtDecile ?? c.pacerRoundAtDecile ?? 1),
        pacerInboundAllowance: Number(c.pacerInboundAllowance ?? 0.5),
        pacerOutboundRoundAtDecile: Number(c.pacerOutboundRoundAtDecile ?? c.pacerRoundAtDecile ?? 1),
        pacerOutboundAllowance: Number(c.pacerOutboundAllowance ?? 0.5),
        optimizerRelativeDocMultiplier: Number(c.optimizerRelativeDocMultiplier ?? 0),
        optimizerRelativeFulfillmentMultiplier: Number(c.optimizerRelativeFulfillmentMultiplier ?? 0),
        minSlotIntervalHours: Number(c.minSlotIntervalHours ?? 0),
        preOpsHours: Number(c.preOpsHours ?? 0),
        postOpsHours: Number(c.postOpsHours ?? 0),
        tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? c.tankCount : 4,
        tankCapacity:
          typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
        bargeBerthAllocation: c.bargeBerthAllocation ?? "alternate"
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
    <div className="card mb-24">
      <div className="card-title-row">
        <div className="card-title" style={{ margin: 0 }}>Storage</div>
        <HelpPopover
          label="Storage help"
          content="Terminal-wide capacity used for scheduling, inventory gates, and feasibility checks."
        />
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <form onSubmit={handleSave} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, maxWidth: 280 }}>
          <label className="form-label">Total storage capacity (tonnes)</label>
          <input
            type="number"
            min={1}
            step={1}
            className="form-input"
            value={totalStorageCapacity}
            onChange={(e) => setTotalStorageCapacity(e.target.value)}
            disabled={busy || !configId}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy || !configId}>
          Save
        </button>
        {saved && <span className="form-saved-hint">✓ Saved</span>}
      </form>
      {!configId && (
        <p className="text-muted-sm" style={{ marginTop: 12, marginBottom: 0 }}>
          Configure the planning horizon under Terminal before setting storage capacity.
        </p>
      )}
    </div>
  );
}
