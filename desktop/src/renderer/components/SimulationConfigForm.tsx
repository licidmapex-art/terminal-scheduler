import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import type { StorageMode } from "../../types";

function parseStorageMode(raw: unknown): StorageMode {
  if (raw === "commingled") return "shared_shipping";
  if (
    raw === "fixed_band" ||
    raw === "shared_shipping" ||
    raw === "time_shared_storage" ||
    raw === "shared_inventory"
  ) {
    return raw;
  }
  return "fixed_band";
}

interface SimulationConfigFormProps {
  onSaved?: () => void;
}

function getDefaultDates() {
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start: now.toISOString().slice(0, 16), end: week.toISOString().slice(0, 16) };
}

function toDatetimeLocal(value: unknown, fallback: string): string {
  const d =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : new Date(NaN);
  if (isNaN(d.getTime())) return fallback;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SimulationConfigForm({ onSaved }: SimulationConfigFormProps) {
  const location = useLocation();
  const defaults = getDefaultDates();
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [pipelineDirection, setPipelineDirection] = useState<"inbound" | "outbound">("inbound");
  const [totalStorageCapacity, setTotalStorageCapacity] = useState("100000");
  const [storageMode, setStorageMode] = useState<StorageMode>("fixed_band");
  const [sharedInventoryCustomerDeficitLimitTonnes, setSharedInventoryCustomerDeficitLimitTonnes] =
    useState("0");
  const [pacerRoundingDirection, setPacerRoundingDirection] = useState<"up" | "down">("up");
  const [pacerRoundAtDecile, setPacerRoundAtDecile] = useState("1");
  const [optimizerRelativeDocMultiplier, setOptimizerRelativeDocMultiplier] = useState("0");
  const [minSlotIntervalHours, setMinSlotIntervalHours] = useState("0");
  const [preOpsHours, setPreOpsHours] = useState("0");
  const [postOpsHours, setPostOpsHours] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadConfig = useCallback(() => {
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const defaultStart = now.toISOString().slice(0, 16);
    const defaultEnd = week.toISOString().slice(0, 16);

    const applyDefaults = () => {
      setStartDate(defaultStart);
      setEndDate(defaultEnd);
      setTotalStorageCapacity("100000");
    };

    if (!window.dbAPI?.getSimulationConfigs) {
      applyDefaults();
      return;
    }

    window.dbAPI
      .getSimulationConfigs()
      .then((configs: unknown[]) => {
        const c = (Array.isArray(configs) ? configs[0] : undefined) as Record<string, unknown> | undefined;
        if (!c) {
          applyDefaults();
          return;
        }
        try {
          setConfigId(typeof c.id === "string" ? c.id : null);
          setStartDate(toDatetimeLocal(c.startDate, defaultStart));
          setEndDate(toDatetimeLocal(c.endDate, defaultEnd));
          setPipelineDirection((c.pipelineDirection === "outbound" ? "outbound" : "inbound") as "inbound" | "outbound");
          setTotalStorageCapacity(String(c.totalStorageCapacity ?? 100000));
          setStorageMode(parseStorageMode(c.storageMode));
          const xLim = c.sharedInventoryCustomerDeficitLimitTonnes;
          const legacyMin = c.sharedInventoryMinStockTonnes as number | undefined;
          const parsedX =
            typeof xLim === "number" && xLim >= 0
              ? xLim
              : typeof legacyMin === "number" && legacyMin >= 0
                ? legacyMin
                : 0;
          setSharedInventoryCustomerDeficitLimitTonnes(String(parsedX));
          const minI = c.minSlotIntervalHours;
          setMinSlotIntervalHours(String(typeof minI === "number" ? minI : 0));
          const paceDir = c.pacerRoundingDirection;
          setPacerRoundingDirection(paceDir === "down" ? "down" : "up");
          const paceDec = c.pacerRoundAtDecile;
          const paceDecNorm =
            typeof paceDec === "number" && Number.isFinite(paceDec)
              ? Math.min(9, Math.max(1, Math.round(paceDec)))
              : 1;
          setPacerRoundAtDecile(String(paceDecNorm));
          const optimizerRaw = c.optimizerRelativeDocMultiplier;
          const optimizerNorm =
            typeof optimizerRaw === "number" && Number.isFinite(optimizerRaw)
              ? Math.max(0, optimizerRaw)
              : 0;
          setOptimizerRelativeDocMultiplier(String(optimizerNorm));
          const pre = c.preOpsHours;
          setPreOpsHours(String(typeof pre === "number" ? pre : 0));
          const post = c.postOpsHours;
          setPostOpsHours(String(typeof post === "number" ? post : 0));
        } catch {
          applyDefaults();
        }
      })
      .catch(() => {
        applyDefaults();
      });
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig, location.pathname]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const start = new Date(startDate);
    const end = new Date(endDate);
    const totalCap = parseFloat(totalStorageCapacity);
    const minInterval = parseFloat(minSlotIntervalHours);
    const pacerDecile = parseInt(pacerRoundAtDecile, 10);
    const optimizerMult = parseFloat(optimizerRelativeDocMultiplier);
    const preOps = parseFloat(preOpsHours);
    const postOps = parseFloat(postOpsHours);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      setError("Invalid dates");
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setError("End date must be after start date");
      return;
    }
    if (isNaN(totalCap) || totalCap <= 0) {
      setError("Total storage capacity must be a positive number");
      return;
    }
    if (isNaN(minInterval) || minInterval < 0 || minInterval > 48) {
      setError("Minimum interval must be between 0 and 48 hours");
      return;
    }
    if (isNaN(pacerDecile) || !Number.isInteger(pacerDecile) || pacerDecile < 1 || pacerDecile > 9) {
      setError("Pacer rounding decile must be an integer between 1 and 9");
      return;
    }
    if (isNaN(optimizerMult) || optimizerMult < 0) {
      setError("Relative optimizer multiplier must be a non-negative number");
      return;
    }
    if (isNaN(preOps) || preOps < 0 || preOps > 48) {
      setError("Pre-ops must be between 0 and 48 hours");
      return;
    }
    if (isNaN(postOps) || postOps < 0 || postOps > 48) {
      setError("Post-ops must be between 0 and 48 hours");
      return;
    }
    const deficitXParsed = parseFloat(sharedInventoryCustomerDeficitLimitTonnes);
    if (storageMode === "shared_inventory" && (isNaN(deficitXParsed) || deficitXParsed < 0)) {
      setError("Customer deficit limit x must be a non-negative number");
      return;
    }
    let tanks = 4;
    if (window.dbAPI?.getSimulationConfigs) {
      const existing = (await window.dbAPI.getSimulationConfigs()) as Array<{ tankCount?: number }>;
      const tc = existing[0]?.tankCount;
      if (typeof tc === "number" && tc >= 1) tanks = tc;
    }
    const impliedPerTank = Math.max(1, Math.round(totalCap / tanks));
    try {
      const config = {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        pipelineFlowRate: 0,
        pipelineDirection,
        totalStorageCapacity: totalCap,
        storageMode,
        sharedInventoryCustomerDeficitLimitTonnes:
          storageMode === "shared_inventory" ? Math.max(0, deficitXParsed) : 0,
        pacerRoundingDirection,
        pacerRoundAtDecile: pacerDecile,
        optimizerRelativeDocMultiplier: Math.max(0, optimizerMult),
        minSlotIntervalHours: minInterval,
        preOpsHours: preOps,
        postOpsHours: postOps,
        tankCount: tanks,
        tankCapacity: impliedPerTank
      };
      if (configId) {
        await window.dbAPI.updateSimulationConfig(configId, config);
      } else {
        const created = (await window.dbAPI.createSimulationConfig(config)) as { id: string };
        setConfigId(created.id);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="config-layout">
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">1</span>
          <div>
            <div className="config-section-title">Simulation horizon</div>
            <p className="config-section-desc">
              Defines the period the scheduler simulates hour-by-hour. Per-customer inbound and outbound pipeline flows
              (t/h) are set on each customer profile. Berth occupancy is evaluated inside this window.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Start</label>
            <input
              type="datetime-local"
              className="form-input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">End</label>
            <input
              type="datetime-local"
              className="form-input"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
          </div>
        </div>
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">2</span>
          <div>
            <div className="config-section-title">Storage model</div>
            <p className="config-section-desc">
              Total fungible capacity at the terminal. Choose how berth inventory gates and accounting interact with
              the shared capacity.
            </p>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Total storage capacity (tonnes)</label>
          <input
            type="number"
            min="1"
            step="1"
            className="form-input"
            value={totalStorageCapacity}
            onChange={(e) => setTotalStorageCapacity(e.target.value)}
            required
            style={{ maxWidth: 280 }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Allocation mode</label>
          <div className="storage-mode-cards">
            <button
              type="button"
              className={`storage-mode-card${storageMode === "fixed_band" ? " selected" : ""}`}
              onClick={() => setStorageMode("fixed_band")}
            >
              <div className="storage-mode-card-title">Fixed band</div>
              <div className="storage-mode-card-body">
                Each customer has a dedicated capacity band (storage share × total). Tank-full and inventory gates
                apply per customer.
              </div>
            </button>
            <button
              type="button"
              className={`storage-mode-card${storageMode === "shared_shipping" ? " selected" : ""}`}
              onClick={() => setStorageMode("shared_shipping")}
            >
              <div className="storage-mode-card-title">Shared shipping</div>
              <div className="storage-mode-card-body">
                One terminal-wide pool for constraints. Reported inventory is split by storage share (proportional
                allocation of flows).
              </div>
            </button>
            <button
              type="button"
              className={`storage-mode-card${storageMode === "time_shared_storage" ? " selected" : ""}`}
              onClick={() => setStorageMode("time_shared_storage")}
            >
              <div className="storage-mode-card-title">Time-shared storage</div>
              <div className="storage-mode-card-body">
                Same scheduling as fixed band. Per-customer triangle overlay (x, y on the customer) shows dynamic
                entitlement over the slot; optional Gantt “TS” layer.
              </div>
            </button>
            <button
              type="button"
              className={`storage-mode-card${storageMode === "shared_inventory" ? " selected" : ""}`}
              onClick={() => setStorageMode("shared_inventory")}
            >
              <div className="storage-mode-card-title">Shared inventory</div>
              <div className="storage-mode-card-body">
                Terminal-wide gates like shared shipping, but berth moves attribute 100% of volume to the booking
                customer (not proportional).
              </div>
            </button>
          </div>
        </div>
        {storageMode === "shared_inventory" && (
          <div className="form-group" style={{ marginTop: 16, maxWidth: 420 }}>
            <label className="form-label">Max. customer deficit x (tonnes)</label>
            <input
              type="number"
              min={0}
              step={1}
              className="form-input"
              value={sharedInventoryCustomerDeficitLimitTonnes}
              onChange={(e) => setSharedInventoryCustomerDeficitLimitTonnes(e.target.value)}
            />
            <div className="form-helper">
              For the booking customer only: attributed inventory may not go below −x after an outbound parcel
              (full MEPS). x = 0 disables this customer-floor check (pool borrowing/lending allowed). Terminal total
              must still cover MEPS.
            </div>
          </div>
        )}
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">3</span>
          <div>
            <div className="config-section-title">Operational laytime</div>
            <p className="config-section-desc">
              Minimum gap between consecutive bookings on the same resource, plus optional pre-ops and post-ops time
              alongside without cargo transfer. Pre/post extend each slot&apos;s occupation (Gantt width and berth
              blocking); inventory moves only during the cargo window between them.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Pre-ops (hours)</label>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={preOpsHours}
              onChange={(e) => setPreOpsHours(e.target.value)}
            />
            <div className="form-helper">Alongside before pumping (e.g. mooring, hook-up). No inventory flow.</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Minimum gap between slots (hours)</label>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={minSlotIntervalHours}
              onChange={(e) => setMinSlotIntervalHours(e.target.value)}
            />
            <div className="form-helper">0–48 h. Cleared time after berth release before the next visit starts.</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Post-ops (hours)</label>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={postOpsHours}
              onChange={(e) => setPostOpsHours(e.target.value)}
            />
            <div className="form-helper">Alongside after pumping (e.g. flush, unmoor). No inventory flow.</div>
          </div>
        </div>
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">4</span>
          <div>
            <div className="config-section-title">Pacing behavior</div>
            <p className="config-section-desc">
              Controls when the pacer allows the next slot relative to the fractional pace tracker.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Rounding mode</label>
            <select
              className="form-select"
              value={pacerRoundingDirection}
              onChange={(e) => setPacerRoundingDirection(e.target.value as "up" | "down")}
            >
              <option value="up">Round up from decile</option>
              <option value="down">Round down until mirrored decile</option>
            </select>
            <div className="form-helper">
              Up: 1.3 becomes 2 when decile ≤ 3. Down: with decile 3, 1.3 stays 1 until pace exceeds 1.7.
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Round threshold decile (1–9)</label>
            <input
              type="number"
              className="form-input"
              min={1}
              max={9}
              step={1}
              value={pacerRoundAtDecile}
              onChange={(e) => setPacerRoundAtDecile(e.target.value)}
            />
            <div className="form-helper">
              Example: 3 = threshold 0.3. Use higher values to delay extra slots.
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <label className="form-label">Relative optimizer (× average DoC)</label>
            <input
              type="number"
              className="form-input"
              min={0}
              step={0.1}
              value={optimizerRelativeDocMultiplier}
              onChange={(e) => setOptimizerRelativeDocMultiplier(e.target.value)}
            />
            <div className="form-helper">
              When a leg&apos;s days-of-cover exceeds this multiple of the cross-customer average at that hour, that
              customer yields the slot attempt (others may still book). Set 0 to disable.
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" className="btn btn-primary">
          Save configuration
        </button>
        {saved && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#15803d", fontSize: 14, fontWeight: 500 }}>
            <span style={{ fontSize: 18 }}>✓</span> Saved
          </span>
        )}
      </div>
    </form>
  );
}
