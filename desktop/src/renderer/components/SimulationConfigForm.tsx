import { useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import type { StorageMode } from "../../types";
import { FormLabelWithHelp, HelpPopover } from "./HelpPopover";
import { normalizeStorageModeToUi, parseStorageMode } from "../../lib/storageMode";
import {
  defaultStochasticConfig,
  normalizeStochasticConfig
} from "../lib/defaultStochasticConfig";
import type { StochasticConfig } from "../../types";

const STORAGE_MODE_HELP: Record<StorageMode, string> = {
  fixed_band:
    "Each customer has a dedicated capacity band (storage share × total). Tank-full and inventory gates apply per customer.",
  shared_shipping:
    "Legacy (deprecated). Use Shared mode instead.",
  time_shared_storage:
    "Legacy (deprecated). Use Individual mode instead.",
  shared_inventory:
    "Terminal-wide inventory gates with a shared pool. Berth moves attribute 100% of volume to the booking customer. Inbound berth pace is pooled across customers by transport mode so early-year slots rotate fairly."
};

const FEASIBILITY_WARNING_DEFS: Array<{
  key: string;
  label: string;
  description: string;
  hasThreshold?: boolean;
  defaultThreshold?: number;
}> = [
  {
    key: "storage_shares_sum",
    label: "Storage shares sum",
    description: "Warn when customer storage shares deviate from 100% (Individual mode only).",
    hasThreshold: true,
    defaultThreshold: 0.2
  },
  {
    key: "pipeline_interrupted",
    label: "Pipeline interrupted",
    description: "Warn when pipeline interruption hours exceed a % of the simulation.",
    hasThreshold: true,
    defaultThreshold: 1
  },
  {
    key: "borrowing_limit_reached",
    label: "Borrowing limit reached",
    description: "Warn when the −x borrowing floor is hit/blocks more than a % of hours.",
    hasThreshold: true,
    defaultThreshold: 1
  },
  {
    key: "terminal_inventory_trending",
    label: "Terminal inventory trending",
    description: "Warn when terminal inventory is materially increasing/decreasing (first-half avg vs second-half avg)."
  },
  {
    key: "customer_inventory_trending",
    label: "Customer inventory trending",
    description: "Warn when a customer's inventory is materially increasing/decreasing (first-half avg vs second-half avg)."
  },
  {
    key: "average_doc_trending",
    label: "Average DoC trending",
    description: "Warn when average days-of-cover is materially trending (first-half avg vs second-half avg)."
  },
  {
    key: "customer_doc_trending",
    label: "Customer DoC trending",
    description: "Warn when a customer's days-of-cover is materially trending (first-half avg vs second-half avg)."
  }
];

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
  const [storageModeUi, setStorageModeUi] = useState<"individual" | "shared">("individual");
  const [sharedInventoryCustomerDeficitLimitTonnes, setSharedInventoryCustomerDeficitLimitTonnes] =
    useState("0");
  const [borrowingGradeScope, setBorrowingGradeScope] = useState<
    "all" | "same_grade" | "selected_grades"
  >("all");
  const [borrowGreen, setBorrowGreen] = useState(true);
  const [borrowBlue, setBorrowBlue] = useState(true);
  const [borrowGrey, setBorrowGrey] = useState(false);
  const [perGradeDeficitGreen, setPerGradeDeficitGreen] = useState("");
  const [perGradeDeficitBlue, setPerGradeDeficitBlue] = useState("");
  const [perGradeDeficitGrey, setPerGradeDeficitGrey] = useState("");
  const [showBorrowingRules, setShowBorrowingRules] = useState(false);
  const [pacerInboundRoundAtDecile, setPacerInboundRoundAtDecile] = useState("1");
  const [pacerInboundAllowance, setPacerInboundAllowance] = useState("0.5");
  const [pacerOutboundRoundAtDecile, setPacerOutboundRoundAtDecile] = useState("1");
  const [pacerOutboundAllowance, setPacerOutboundAllowance] = useState("0");
  const [optimizerRelativeDocMultiplier, setOptimizerRelativeDocMultiplier] = useState("0");
  const [optimizerRelativeFulfillmentMultiplier, setOptimizerRelativeFulfillmentMultiplier] = useState("0");
  const [gradeMassBalancingEnabled, setGradeMassBalancingEnabled] = useState(false);
  const [gradeMassBalanceDeficitMode, setGradeMassBalanceDeficitMode] = useState<"tonnes" | "percent">(
    "tonnes"
  );
  const [gradeMassBalanceDeficitLimitTonnes, setGradeMassBalanceDeficitLimitTonnes] = useState("0");
  const [gradeMassBalanceDeficitLimitPct, setGradeMassBalanceDeficitLimitPct] = useState("0");
  const [minSlotIntervalHours, setMinSlotIntervalHours] = useState("0");
  const [preOpsHours, setPreOpsHours] = useState("0");
  const [postOpsHours, setPostOpsHours] = useState("0");
  const [berthReservationMode, setBerthReservationMode] = useState<
    "none" | "window_of_arrival" | "laycan"
  >("none");
  const [feasibilityWarnings, setFeasibilityWarnings] = useState<
    Record<string, { enabled?: boolean; severity?: "amber" | "red"; threshold?: number }>
  >({});
  const [showFeasibilityWarningSettings, setShowFeasibilityWarningSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configId, setConfigId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preservedStochasticConfig, setPreservedStochasticConfig] = useState<StochasticConfig>(
    defaultStochasticConfig()
  );

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
          const rawMode = parseStorageMode(c.storageMode);
          setStorageMode(rawMode);
          setStorageModeUi(normalizeStorageModeToUi(rawMode));
          const xLim = c.sharedInventoryCustomerDeficitLimitTonnes;
          const legacyMin = c.sharedInventoryMinStockTonnes as number | undefined;
          const parsedX =
            typeof xLim === "number" && xLim >= 0
              ? xLim
              : typeof legacyMin === "number" && legacyMin >= 0
                ? legacyMin
                : 0;
          setSharedInventoryCustomerDeficitLimitTonnes(String(parsedX));
          const scope = c.borrowingGradeScope;
          setBorrowingGradeScope(
            scope === "same_grade" || scope === "selected_grades" ? scope : "all"
          );
          const sel = c.selectedBorrowingGrades;
          setBorrowGreen(!sel?.length || sel.includes("green"));
          setBorrowBlue(!sel?.length || sel.includes("blue"));
          setBorrowGrey(sel?.includes("grey") ?? false);
          const pg = c.perGradeDeficitLimitTonnes;
          setPerGradeDeficitGreen(pg?.green != null ? String(pg.green) : "");
          setPerGradeDeficitBlue(pg?.blue != null ? String(pg.blue) : "");
          setPerGradeDeficitGrey(pg?.grey != null ? String(pg.grey) : "");
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
          setGradeMassBalancingEnabled(!!c.gradeMassBalancingEnabled);
          const deficitMode = c.gradeMassBalanceDeficitMode === "percent" ? "percent" : "tonnes";
          setGradeMassBalanceDeficitMode(deficitMode);
          const gradeDeficit = c.gradeMassBalanceDeficitLimitTonnes;
          setGradeMassBalanceDeficitLimitTonnes(
            String(typeof gradeDeficit === "number" && Number.isFinite(gradeDeficit) ? Math.max(0, gradeDeficit) : 0)
          );
          const gradeDeficitPct = c.gradeMassBalanceDeficitLimitPct;
          setGradeMassBalanceDeficitLimitPct(
            String(
              typeof gradeDeficitPct === "number" && Number.isFinite(gradeDeficitPct)
                ? Math.max(0, gradeDeficitPct)
                : 0
            )
          );
          const pre = c.preOpsHours;
          setPreOpsHours(String(typeof pre === "number" ? pre : 0));
          const post = c.postOpsHours;
          setPostOpsHours(String(typeof post === "number" ? post : 0));
          const brm = c.berthReservationMode;
          setBerthReservationMode(
            brm === "window_of_arrival" || brm === "laycan" ? brm : "none"
          );
          setFeasibilityWarnings(
            (c.feasibilityWarnings && typeof c.feasibilityWarnings === "object"
              ? (c.feasibilityWarnings as Record<string, { enabled?: boolean; severity?: "amber" | "red"; threshold?: number }>)
              : {}) ?? {}
          );
          setPreservedStochasticConfig(normalizeStochasticConfig(c.stochasticConfig));
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
    const gradeDeficitLimit = parseFloat(gradeMassBalanceDeficitLimitTonnes);
    const gradeDeficitLimitPct = parseFloat(gradeMassBalanceDeficitLimitPct);
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
    if (
      gradeMassBalancingEnabled &&
      gradeMassBalanceDeficitMode === "tonnes" &&
      (isNaN(gradeDeficitLimit) || !Number.isFinite(gradeDeficitLimit) || gradeDeficitLimit < 0)
    ) {
      setError("Grade mass-balance deficit limit must be a non-negative number");
      return;
    }
    if (
      gradeMassBalancingEnabled &&
      gradeMassBalanceDeficitMode === "percent" &&
      (isNaN(gradeDeficitLimitPct) ||
        !Number.isFinite(gradeDeficitLimitPct) ||
        gradeDeficitLimitPct < 0 ||
        gradeDeficitLimitPct > 100)
    ) {
      setError("Grade mass-balance deficit limit must be between 0 and 100%");
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
    const storageModeToSave: StorageMode = storageModeUi === "shared" ? "shared_inventory" : "fixed_band";
    if (storageModeToSave === "shared_inventory" && (isNaN(deficitXParsed) || deficitXParsed < 0)) {
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
        storageMode: storageModeToSave,
        sharedInventoryCustomerDeficitLimitTonnes:
          storageModeToSave === "shared_inventory" ? Math.max(0, deficitXParsed) : 0,
        borrowingGradeScope:
          storageModeToSave === "shared_inventory" ? borrowingGradeScope : "all",
        selectedBorrowingGrades:
          storageModeToSave === "shared_inventory" && borrowingGradeScope === "selected_grades"
            ? (["green", "blue", "grey"] as const).filter((g) =>
                g === "green" ? borrowGreen : g === "blue" ? borrowBlue : borrowGrey
              )
            : undefined,
        perGradeDeficitLimitTonnes:
          storageModeToSave === "shared_inventory"
            ? {
                ...(perGradeDeficitGreen.trim() !== "" &&
                Number.isFinite(parseFloat(perGradeDeficitGreen))
                  ? { green: Math.max(0, parseFloat(perGradeDeficitGreen)) }
                  : {}),
                ...(perGradeDeficitBlue.trim() !== "" &&
                Number.isFinite(parseFloat(perGradeDeficitBlue))
                  ? { blue: Math.max(0, parseFloat(perGradeDeficitBlue)) }
                  : {}),
                ...(perGradeDeficitGrey.trim() !== "" &&
                Number.isFinite(parseFloat(perGradeDeficitGrey))
                  ? { grey: Math.max(0, parseFloat(perGradeDeficitGrey)) }
                  : {})
              }
            : undefined,
        pacerInboundRoundAtDecile: inboundDecile,
        pacerInboundAllowance: inboundAllowance,
        pacerOutboundRoundAtDecile: outboundDecile,
        pacerOutboundAllowance: outboundAllowance,
        optimizerRelativeDocMultiplier: Math.max(0, optimizerMult),
        optimizerRelativeFulfillmentMultiplier: Math.max(0, fulfillmentOptimizerMult),
        gradeMassBalancingEnabled,
        gradeMassBalanceDeficitMode: gradeMassBalancingEnabled ? gradeMassBalanceDeficitMode : "tonnes",
        gradeMassBalanceDeficitLimitTonnes:
          gradeMassBalancingEnabled && gradeMassBalanceDeficitMode === "tonnes"
            ? Math.max(0, gradeDeficitLimit)
            : 0,
        gradeMassBalanceDeficitLimitPct:
          gradeMassBalancingEnabled && gradeMassBalanceDeficitMode === "percent"
            ? Math.max(0, gradeDeficitLimitPct)
            : 0,
        minSlotIntervalHours: minInterval,
        preOpsHours: preOps,
        postOpsHours: postOps,
        berthReservationMode,
        feasibilityWarnings,
        tankCount: tanks,
        tankCapacity: perTankCapacity,
        bargeBerthAllocation:
          preservedBargeBerthAllocation === "small_only" ||
          preservedBargeBerthAllocation === "prefer_small"
            ? preservedBargeBerthAllocation
            : "alternate",
        stochasticConfig: preservedStochasticConfig
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
              title="Individual"
              selected={storageModeUi === "individual"}
              onSelect={() => setStorageModeUi("individual")}
            />
            <StorageModeCard
              mode="shared_inventory"
              title="Shared"
              selected={storageModeUi === "shared"}
              onSelect={() => setStorageModeUi("shared")}
            />
          </div>
        </div>
        {storageModeUi === "shared" && (
          <>
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
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowBorrowingRules((v) => !v)}
            >
              {showBorrowingRules ? "Hide borrowing rules" : "Borrowing rules (per grade)"}
            </button>
          </div>
          {showBorrowingRules && (
            <div
              className="card-inset"
              style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div className="form-group" style={{ marginBottom: 0 }}>
                <FormLabelWithHelp
                  help={
                    <>
                      <strong>All grades</strong> — each grade enforces its own −x floor (apportioned from global x
                      unless overridden below). <strong>Same grade only</strong> — deficit allowed only when other
                      customers have surplus in that grade. <strong>Selected grades</strong> — floor applies only to
                      checked grades.
                    </>
                  }
                >
                  Borrowing scope
                </FormLabelWithHelp>
                <select
                  className="form-select"
                  value={borrowingGradeScope}
                  onChange={(e) =>
                    setBorrowingGradeScope(e.target.value as "all" | "same_grade" | "selected_grades")
                  }
                >
                  <option value="all">All grades (default)</option>
                  <option value="same_grade">Same grade only (donor surplus required)</option>
                  <option value="selected_grades">Selected grades only</option>
                </select>
              </div>
              {borrowingGradeScope === "selected_grades" && (
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={borrowGreen} onChange={(e) => setBorrowGreen(e.target.checked)} />
                    Green
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={borrowBlue} onChange={(e) => setBorrowBlue(e.target.checked)} />
                    Blue
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={borrowGrey} onChange={(e) => setBorrowGrey(e.target.checked)} />
                    Grey
                  </label>
                </div>
              )}
              <p className="form-helper" style={{ margin: 0 }}>
                Optional per-grade −x limits (t). Leave blank to apportion the global x by each customer&apos;s grade
                mix.
              </p>
              <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Green −x (t)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={perGradeDeficitGreen}
                    onChange={(e) => setPerGradeDeficitGreen(e.target.value)}
                    placeholder="auto"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Blue −x (t)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={perGradeDeficitBlue}
                    onChange={(e) => setPerGradeDeficitBlue(e.target.value)}
                    placeholder="auto"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Grey −x (t)</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={perGradeDeficitGrey}
                    onChange={(e) => setPerGradeDeficitGrey(e.target.value)}
                    placeholder="auto"
                  />
                </div>
              </div>
            </div>
          )}
          </>
        )}
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">3</span>
          <div>
            <div className="config-section-title-row">
              <div className="config-section-title">Feasibility warnings</div>
              <HelpPopover
                label="Feasibility warnings help"
                content="Configure soft diagnostics shown after scheduling (and on Analytics). You can disable individual warnings, set severity, and adjust thresholds where applicable."
              />
            </div>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowFeasibilityWarningSettings((v) => !v)}
          style={{ marginBottom: 12 }}
        >
          {showFeasibilityWarningSettings ? "Hide warnings settings" : "Show warnings settings"}
        </button>

        {showFeasibilityWarningSettings && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {FEASIBILITY_WARNING_DEFS.map((def) => {
              const cur = feasibilityWarnings[def.key] ?? {};
              const enabled = cur.enabled !== false;
              const severity = (cur.severity === "red" ? "red" : "amber") as "amber" | "red";
              const threshold =
                typeof cur.threshold === "number" && Number.isFinite(cur.threshold)
                  ? cur.threshold
                  : def.defaultThreshold;
              return (
                <div
                  key={def.key}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: 10,
                    padding: 12
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) =>
                          setFeasibilityWarnings((prev) => ({
                            ...prev,
                            [def.key]: { ...prev[def.key], enabled: e.target.checked }
                          }))
                        }
                      />
                      <strong>{def.label}</strong>
                    </label>

                    <span
                      className={`badge ${severity === "red" ? "badge-red" : "badge-amber"}`}
                      style={{ marginLeft: "auto" }}
                      title="Controls display severity only"
                    >
                      {severity.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ marginTop: 6, color: "#64748b", fontSize: 13 }}>{def.description}</div>

                  <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <div className="form-group" style={{ marginBottom: 0, minWidth: 220 }}>
                      <label className="form-label">Severity</label>
                      <select
                        className="form-input"
                        value={severity}
                        onChange={(e) =>
                          setFeasibilityWarnings((prev) => ({
                            ...prev,
                            [def.key]: { ...prev[def.key], severity: e.target.value as "amber" | "red" }
                          }))
                        }
                      >
                        <option value="amber">Amber</option>
                        <option value="red">Red</option>
                      </select>
                    </div>

                    {def.hasThreshold && (
                      <div className="form-group" style={{ marginBottom: 0, minWidth: 220 }}>
                        <label className="form-label">Threshold (%)</label>
                        <input
                          type="number"
                          className="form-input"
                          min={0}
                          step={0.1}
                          value={String(threshold ?? "")}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setFeasibilityWarnings((prev) => ({
                              ...prev,
                              [def.key]: { ...prev[def.key], threshold: Number.isFinite(v) ? v : undefined }
                            }));
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">4</span>
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
          <div className="form-group" style={{ marginBottom: 0, maxWidth: 420 }}>
            <FormLabelWithHelp help="WoA or laycan reserves the berth for a leg before/during operation. Set window length (h) on each transport leg in the customer form.">
              Berth reservation
            </FormLabelWithHelp>
            <select
              className="form-select"
              value={berthReservationMode}
              onChange={(e) =>
                setBerthReservationMode(
                  e.target.value === "window_of_arrival" || e.target.value === "laycan"
                    ? e.target.value
                    : "none"
                )
              }
            >
              <option value="none">None</option>
              <option value="window_of_arrival">Window of arrival</option>
              <option value="laycan">Laycan</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">5</span>
          <div>
            <div className="config-section-title-row">
              <div className="config-section-title">Grade mass balancing</div>
              <HelpPopover
                label="Grade mass balancing help"
                content={
                  <>
                    Optional bookkeeping by calendar quarter for <strong>green</strong>, <strong>blue</strong>, and{" "}
                    <strong>grey</strong> grades. Customer grade shares attribute flows; the terminal keeps one
                    certified ledger per grade (all customers combined). Analytics compares quarters left to right.
                  </>
                }
              />
            </div>
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={gradeMassBalancingEnabled}
              onChange={(e) => setGradeMassBalancingEnabled(e.target.checked)}
            />
            Enable grade mass balancing
          </label>
        </div>
        {gradeMassBalancingEnabled && (
          <div className="form-grid" style={{ maxWidth: 520 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <FormLabelWithHelp help="Limit quarter-end grade deficit as fixed tonnes or as a percentage of that grade's quarter inbound.">
                Deficit limit type
              </FormLabelWithHelp>
              <select
                className="form-select"
                value={gradeMassBalanceDeficitMode}
                onChange={(e) =>
                  setGradeMassBalanceDeficitMode(e.target.value === "percent" ? "percent" : "tonnes")
                }
              >
                <option value="tonnes">Tonnes (absolute)</option>
                <option value="percent">Percent of quarter inbound</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              {gradeMassBalanceDeficitMode === "percent" ? (
                <>
                  <FormLabelWithHelp
                    help={
                      <>
                        Max allowed negative balance as <strong>% of that grade&apos;s inbound</strong> in the
                        quarter. <strong>0</strong> means outbound cannot exceed inbound.
                      </>
                    }
                  >
                    Max grade deficit (%)
                  </FormLabelWithHelp>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    className="form-input"
                    value={gradeMassBalanceDeficitLimitPct}
                    onChange={(e) => setGradeMassBalanceDeficitLimitPct(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <FormLabelWithHelp
                    help={
                      <>
                        Max temporary below-zero allowance per customer-grade inside a quarter.{" "}
                        <strong>0</strong> means outbound claims cannot exceed inbound certified tonnes.
                      </>
                    }
                  >
                    Max grade deficit (tonnes)
                  </FormLabelWithHelp>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="form-input"
                    value={gradeMassBalanceDeficitLimitTonnes}
                    onChange={(e) => setGradeMassBalanceDeficitLimitTonnes(e.target.value)}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card config-section">
        <div className="config-section-header">
          <span className="config-section-num">6</span>
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
                  When a leg&apos;s days-of-cover exceeds this multiple of combined terminal DoC at that hour,
                  that customer yields the slot attempt (others may still book). Set 0 to disable.
                </>
              }
            >
              Relative optimizer (× combined DoC)
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
                  In Shared mode (inbound only): yield when this leg&apos;s mass fulfilment (tonnes delivered ÷ target
                  tonnes) exceeds this multiple of the direction+mode pool average — reduces streaks when a customer is
                  ahead on contracted volume. Set 0 to disable.
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
