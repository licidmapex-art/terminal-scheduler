import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import type { StorageMode } from "../../types";
import { FormLabelWithHelp, HelpPopover } from "./HelpPopover";

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

const STORAGE_MODE_HELP: Record<StorageMode, string> = {
  fixed_band:
    "Each customer has a dedicated capacity band (storage share × total). Tank-full and inventory gates apply per customer.",
  shared_shipping:
    "One terminal-wide pool for constraints. Reported inventory is split by storage share (proportional allocation of flows).",
  time_shared_storage:
    "Same scheduling as fixed band. Per-customer triangle overlay (x, y on the customer) shows dynamic entitlement over the slot; optional Gantt “TS” layer.",
  shared_inventory:
    "Terminal-wide gates like shared shipping, but berth moves attribute 100% of volume to the booking customer (not proportional). Inbound berth pace is pooled across customers by transport mode so early-year slots rotate fairly."
};

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

function StorageModeCard({
  mode,
  title,
  selected,
  onSelect
}: {
  mode: StorageMode;
  title: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`storage-mode-card${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <div className="storage-mode-card-title-row">
        <div className="storage-mode-card-title">{title}</div>
        <span className="storage-mode-card-help" onClick={(e) => e.stopPropagation()}>
          <HelpPopover content={STORAGE_MODE_HELP[mode]} label={`${title} help`} />
        </span>
      </div>
    </button>
  );
}

export default function SimulationConfigForm({ onSaved }: SimulationConfigFormProps) {
  const location = useLocation();
  const defaults = getDefaultDates();
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [pipelineDirection, setPipelineDirection] = useState<"inbound" | "outbound">("inbound");
  const [storageMode, setStorageMode] = useState<StorageMode>("fixed_band");
  const [sharedInventoryCustomerDeficitLimitTonnes, setSharedInventoryCustomerDeficitLimitTonnes] =
    useState("0");
  const [pacerInboundRoundAtDecile, setPacerInboundRoundAtDecile] = useState("1");
  const [pacerInboundAllowance, setPacerInboundAllowance] = useState("0.5");
  const [pacerOutboundRoundAtDecile, setPacerOutboundRoundAtDecile] = useState("1");
  const [pacerOutboundAllowance, setPacerOutboundAllowance] = useState("0");
  const [optimizerRelativeDocMultiplier, setOptimizerRelativeDocMultiplier] = useState("0");
  const [optimizerRelativeFulfillmentMultiplier, setOptimizerRelativeFulfillmentMultiplier] = useState("0");
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
          const normDecile = (v: unknown, fallback: number) =>
            typeof v === "number" && Number.isFinite(v)
              ? Math.min(9, Math.max(1, Math.round(v)))
              : fallback;
          const normAllowance = (v: unknown, fallback: number) =>
            typeof v === "number" && Number.isFinite(v) ? v : fallback;
          const legacyDecile = normDecile(c.pacerRoundAtDecile, 1);
          setPacerInboundRoundAtDecile(
            String(normDecile(c.pacerInboundRoundAtDecile, legacyDecile))
          );
          setPacerInboundAllowance(String(normAllowance(c.pacerInboundAllowance, 0.5)));
          setPacerOutboundRoundAtDecile(
            String(normDecile(c.pacerOutboundRoundAtDecile, legacyDecile))
          );
          setPacerOutboundAllowance(String(normAllowance(c.pacerOutboundAllowance, 0.5)));
          const optimizerRaw = c.optimizerRelativeDocMultiplier;
          const optimizerNorm =
            typeof optimizerRaw === "number" && Number.isFinite(optimizerRaw)
              ? Math.max(0, optimizerRaw)
              : 0;
          setOptimizerRelativeDocMultiplier(String(optimizerNorm));
          const fulfillmentRaw = c.optimizerRelativeFulfillmentMultiplier;
          const fulfillmentNorm =
            typeof fulfillmentRaw === "number" && Number.isFinite(fulfillmentRaw)
              ? Math.max(0, fulfillmentRaw)
              : 0;
          setOptimizerRelativeFulfillmentMultiplier(String(fulfillmentNorm));
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
    const minInterval = parseFloat(minSlotIntervalHours);
    const inboundDecile = parseInt(pacerInboundRoundAtDecile, 10);
    const outboundDecile = parseInt(pacerOutboundRoundAtDecile, 10);
    const inboundAllowance = parseFloat(pacerInboundAllowance);
    const outboundAllowance = parseFloat(pacerOutboundAllowance);
    const optimizerMult = parseFloat(optimizerRelativeDocMultiplier);
    const fulfillmentOptimizerMult = parseFloat(optimizerRelativeFulfillmentMultiplier);
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
    if (isNaN(minInterval) || minInterval < 0 || minInterval > 48) {
      setError("Minimum interval must be between 0 and 48 hours");
      return;
    }
    if (
      isNaN(inboundDecile) ||
      !Number.isInteger(inboundDecile) ||
      inboundDecile < 1 ||
      inboundDecile > 9
    ) {
      setError("Inbound pacer decile must be an integer between 1 and 9");
      return;
    }
    if (
      isNaN(outboundDecile) ||
      !Number.isInteger(outboundDecile) ||
      outboundDecile < 1 ||
      outboundDecile > 9
    ) {
      setError("Outbound pacer decile must be an integer between 1 and 9");
      return;
    }
    if (isNaN(inboundAllowance) || !Number.isFinite(inboundAllowance)) {
      setError("Inbound pacer allowance must be a number");
      return;
    }
    if (isNaN(outboundAllowance) || !Number.isFinite(outboundAllowance)) {
      setError("Outbound pacer allowance must be a number");
      return;
    }
    if (isNaN(optimizerMult) || optimizerMult < 0) {
      setError("Relative DoC optimizer multiplier must be a non-negative number");
      return;
    }
    if (isNaN(fulfillmentOptimizerMult) || fulfillmentOptimizerMult < 0) {
      setError("Relative fulfilment optimizer multiplier must be a non-negative number");
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
    let perTankCapacity = 7000;
    let totalCap = 100_000;
    let preservedBargeBerthAllocation: string | undefined;
    if (window.dbAPI?.getSimulationConfigs) {
      const existing = (await window.dbAPI.getSimulationConfigs()) as Array<{
        tankCount?: number;
        tankCapacity?: number;
        totalStorageCapacity?: number;
        bargeBerthAllocation?: string;
      }>;
      const tc = existing[0]?.tankCount;
      const cap = existing[0]?.tankCapacity;
      const total = existing[0]?.totalStorageCapacity;
      if (typeof tc === "number" && tc >= 1) tanks = tc;
      if (typeof cap === "number" && cap > 0) perTankCapacity = cap;
      if (typeof total === "number" && total > 0) totalCap = total;
      preservedBargeBerthAllocation = existing[0]?.bargeBerthAllocation;
    }
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
        pacerInboundRoundAtDecile: inboundDecile,
        pacerInboundAllowance: inboundAllowance,
        pacerOutboundRoundAtDecile: outboundDecile,
        pacerOutboundAllowance: outboundAllowance,
        optimizerRelativeDocMultiplier: Math.max(0, optimizerMult),
        optimizerRelativeFulfillmentMultiplier: Math.max(0, fulfillmentOptimizerMult),
        minSlotIntervalHours: minInterval,
        preOpsHours: preOps,
        postOpsHours: postOps,
        tankCount: tanks,
        tankCapacity: perTankCapacity,
        bargeBerthAllocation:
          preservedBargeBerthAllocation === "small_only" ||
          preservedBargeBerthAllocation === "prefer_small"
            ? preservedBargeBerthAllocation
            : "alternate"
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
            <div className="config-section-title-row">
              <div className="config-section-title">Simulation horizon</div>
              <HelpPopover
                label="Simulation horizon help"
                content={
                  <>
                    Defines the period the scheduler simulates hour-by-hour. Per-customer inbound and outbound pipeline
                    flows (t/h) are set on each customer profile. Berth occupancy is evaluated inside this window.
                  </>
                }
              />
            </div>
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
            <div className="config-section-title-row">
              <div className="config-section-title">Storage model</div>
              <HelpPopover
                label="Storage model help"
                content={
                  <>
                    Choose how berth inventory gates and accounting interact with terminal storage capacity. Set total
                    and per-tank capacity under <strong>Resources</strong>.
                  </>
                }
              />
            </div>
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Allocation mode</label>
          <div className="storage-mode-cards">
            <StorageModeCard
              mode="fixed_band"
              title="Fixed band"
              selected={storageMode === "fixed_band"}
              onSelect={() => setStorageMode("fixed_band")}
            />
            <StorageModeCard
              mode="shared_shipping"
              title="Shared shipping"
              selected={storageMode === "shared_shipping"}
              onSelect={() => setStorageMode("shared_shipping")}
            />
            <StorageModeCard
              mode="time_shared_storage"
              title="Time-shared storage"
              selected={storageMode === "time_shared_storage"}
              onSelect={() => setStorageMode("time_shared_storage")}
            />
            <StorageModeCard
              mode="shared_inventory"
              title="Shared inventory"
              selected={storageMode === "shared_inventory"}
              onSelect={() => setStorageMode("shared_inventory")}
            />
          </div>
        </div>
        {storageMode === "shared_inventory" && (
          <div className="form-group" style={{ marginTop: 16, maxWidth: 420 }}>
            <FormLabelWithHelp
              help={
                <>
                  For the booking customer only: attributed inventory may not go below −x after an outbound
                  parcel (full MEPS) or outbound pipeline hour. Borrowing still requires terminal physical stock
                  (sum of attributions &gt; 0). x = 0 disables the customer-floor check. Terminal total must still
                  cover MEPS for berth moves.
                </>
              }
            >
              Max. customer deficit x (tonnes)
            </FormLabelWithHelp>
            <input
              type="number"
              min={0}
              step={1}
              className="form-input"
              value={sharedInventoryCustomerDeficitLimitTonnes}
              onChange={(e) => setSharedInventoryCustomerDeficitLimitTonnes(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">3</span>
          <div>
            <div className="config-section-title-row">
              <div className="config-section-title">Operational laytime</div>
              <HelpPopover
                label="Operational laytime help"
                content={
                  <>
                    Minimum gap between consecutive bookings on the same resource, plus optional pre-ops and post-ops
                    time alongside without cargo transfer. Pre/post extend each slot&apos;s occupation (Gantt width and
                    berth blocking); inventory moves only during the cargo window between them.
                  </>
                }
              />
            </div>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Alongside before pumping (e.g. mooring, hook-up). No inventory flow.">
              Pre-ops (hours)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={preOpsHours}
              onChange={(e) => setPreOpsHours(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="0–48 h. Cleared time after berth release before the next visit starts.">
              Minimum gap between slots (hours)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={minSlotIntervalHours}
              onChange={(e) => setMinSlotIntervalHours(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Alongside after pumping (e.g. flush, unmoor). No inventory flow.">
              Post-ops (hours)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={0}
              max={48}
              step={1}
              value={postOpsHours}
              onChange={(e) => setPostOpsHours(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">4</span>
          <div>
            <div className="config-section-title-row">
              <div className="config-section-title">Pacing behavior</div>
              <HelpPopover
                label="Pacing behavior help"
                content={
                  <>
                    Each hour the scheduler compares slot starts so far to a linear pace target:{" "}
                    <strong>(hour ÷ period) × target slots + allowance</strong>, rounded up when the
                    fractional part reaches <strong>decile ÷ 10</strong>. Inbound and outbound can differ —
                    higher inbound allowance starts fills sooner; lower outbound allowance keeps stock in the
                    tank longer.
                  </>
                }
              />
            </div>
          </div>
        </div>
        <div className="form-grid">
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Inbound: round up to the next allowed slot when fractional pace reaches decile ÷ 10 (e.g. 1 → 0.1).">
              Inbound round decile (1–9)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={1}
              max={9}
              step={1}
              value={pacerInboundRoundAtDecile}
              onChange={(e) => setPacerInboundRoundAtDecile(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Added to the inbound pace line before rounding. Positive brings starts forward; negative delays them.">
              Inbound allowance (slots)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              step={0.1}
              value={pacerInboundAllowance}
              onChange={(e) => setPacerInboundAllowance(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Outbound: round up when fractional pace reaches decile ÷ 10.">
              Outbound round decile (1–9)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={1}
              max={9}
              step={1}
              value={pacerOutboundRoundAtDecile}
              onChange={(e) => setPacerOutboundRoundAtDecile(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp help="Added to the outbound pace line. Negative values delay outbound lifts and help preserve tank stock.">
              Outbound allowance (slots)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              step={0.1}
              value={pacerOutboundAllowance}
              onChange={(e) => setPacerOutboundAllowance(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp
              help={
                <>
                  When a leg&apos;s days-of-cover exceeds this multiple of the cross-customer average at that hour,
                  that customer yields the slot attempt (others may still book). Set 0 to disable.
                </>
              }
            >
              Relative optimizer (× average DoC)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={0}
              step={0.1}
              value={optimizerRelativeDocMultiplier}
              onChange={(e) => setOptimizerRelativeDocMultiplier(e.target.value)}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 320 }}>
            <FormLabelWithHelp
              help={
                <>
                  In shared shipping (all legs) and shared inventory (inbound only): yield when this leg&apos;s annual
                  fulfilment % exceeds this multiple of the direction+mode pool average — reduces streaks when a customer
                  is ahead on ship quota. Set 0 to disable.
                </>
              }
            >
              Relative optimizer (× pool fulfilment)
            </FormLabelWithHelp>
            <input
              type="number"
              className="form-input"
              min={0}
              step={0.1}
              value={optimizerRelativeFulfillmentMultiplier}
              onChange={(e) => setOptimizerRelativeFulfillmentMultiplier(e.target.value)}
            />
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
