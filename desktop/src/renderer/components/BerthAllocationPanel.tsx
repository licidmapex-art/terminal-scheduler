import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import type { BargeBerthAllocation } from "../../engine/resourceAllocation";
import { normalizeBargeBerthAllocation } from "../../engine/resourceAllocation";
import { HelpPopover } from "./HelpPopover";

interface BerthAllocationPanelProps {
  hasLargeBerth: boolean;
  hasSmallBerth: boolean;
}

const OPTIONS: Array<{ value: BargeBerthAllocation; label: string; description: string }> = [
  {
    value: "alternate",
    label: "Alternate",
    description: "Balance barge load across large and small berths when both are free."
  },
  {
    value: "small_only",
    label: "Small berths only",
    description: "Barges use small berths only; large berths are reserved for ships."
  },
  {
    value: "prefer_small",
    label: "Prefer small berths",
    description: "Use small berths when available; fall back to large berths when small is occupied."
  }
];

export default function BerthAllocationPanel({
  hasLargeBerth,
  hasSmallBerth
}: BerthAllocationPanelProps) {
  const location = useLocation();
  const [allocation, setAllocation] = useState<BargeBerthAllocation>("alternate");
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
    setAllocation(normalizeBargeBerthAllocation(c.bargeBerthAllocation));
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load, location.pathname]);

  if (!hasLargeBerth || !hasSmallBerth) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!window.dbAPI || !configId) {
      setError("Set the planning horizon under Terminal first.");
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
        totalStorageCapacity: Number(c.totalStorageCapacity ?? 100000),
        storageMode: (c.storageMode as string) ?? "fixed_band",
        sharedInventoryCustomerDeficitLimitTonnes: Number(
          c.sharedInventoryCustomerDeficitLimitTonnes ?? 0
        ),
        pacerRoundingDirection: c.pacerRoundingDirection === "down" ? "down" : "up",
        pacerRoundAtDecile: Number(c.pacerRoundAtDecile ?? 1),
        optimizerRelativeDocMultiplier: Number(c.optimizerRelativeDocMultiplier ?? 0),
        optimizerRelativeFulfillmentMultiplier: Number(c.optimizerRelativeFulfillmentMultiplier ?? 0),
        minSlotIntervalHours: Number(c.minSlotIntervalHours ?? 0),
        preOpsHours: Number(c.preOpsHours ?? 0),
        postOpsHours: Number(c.postOpsHours ?? 0),
        tankCount: typeof c.tankCount === "number" && c.tankCount >= 1 ? c.tankCount : 4,
        tankCapacity: typeof c.tankCapacity === "number" && c.tankCapacity > 0 ? c.tankCapacity : 7000,
        bargeBerthAllocation: allocation
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
      <div className="card-title-row">
        <div className="card-title" style={{ margin: 0 }}>Barge berth allocation</div>
        <HelpPopover
          label="Barge berth allocation help"
          content="When barges can use both large and small berths, choose how the scheduler assigns them."
        />
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <form onSubmit={handleSave}>
        <div className="form-radio-group" style={{ marginBottom: 14 }}>
          {OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`form-radio-option${busy || !configId ? " is-disabled" : ""}`}
            >
              <input
                type="radio"
                name="bargeBerthAllocation"
                value={opt.value}
                checked={allocation === opt.value}
                onChange={() => setAllocation(opt.value)}
                disabled={busy || !configId}
              />
              <span>
                <span className="form-radio-option-title">
                  {opt.label}
                  <span style={{ marginLeft: 6, verticalAlign: "middle" }} onClick={(e) => e.preventDefault()}>
                    <HelpPopover content={opt.description} label={`${opt.label} help`} size={14} />
                  </span>
                </span>
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !configId}>
            Save
          </button>
          {saved && (
            <span style={{ color: "#15803d", fontSize: 14, fontWeight: 500 }}>✓ Saved</span>
          )}
        </div>
      </form>
      {!configId && (
        <p className="form-helper" style={{ marginTop: 10, marginBottom: 0 }}>
          Open Terminal configuration and save once to enable berth allocation settings.
        </p>
      )}
    </div>
  );
}
