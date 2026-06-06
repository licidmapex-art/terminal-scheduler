import {
  useState,
  useEffect,
  useMemo,
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback
} from "react";
import {
  normalizeChartColorHex,
  resolveCustomerChartColor
} from "../lib/customerChartColor";
import { buildCustomerThroughputOverview } from "../lib/customerThroughputOverview";
import CustomerThroughputOverviewPanel from "./CustomerThroughputOverview";
import type { Customer as EngineCustomer, SimulationConfig as EngineSimulationConfig } from "../../types";

interface Customer {
  id: string;
  name: string;
  declaredInboundThroughput: number;
  currentInventory: number;
  storageShare: number;
  pipelineFlowPerHour: number;
  inboundTransports?: TransportRow[];
  outboundTransports?: TransportRow[];
  inboundMEPS?: number;
  inboundMode?: "ship" | "barge" | "train";
  outboundMEPS?: number;
  outboundMode?: "ship" | "barge" | "train";
  inboundRoundtripHours?: number;
  outboundRoundtripHours?: number;
  timeSharedMinBand?: number;
  timeSharedDuration?: number;
  chartColor?: string | null;
}
type TransportMode = "ship" | "barge" | "train";
interface TransportRow {
  mode: TransportMode;
  sharePct: number;
  meps: number;
  roundtripHours: number;
}

interface SimulationConfig {
  startDate: string;
  endDate: string;
  pipelineDirection: "inbound" | "outbound";
}

interface CustomerFormProps {
  customer?: Customer | null;
  /** Index for palette fallback preview when chart color is automatic (new customer = list length). */
  chartColorPaletteIndex?: number;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export type CustomerFormHandle = {
  save: () => Promise<boolean>;
  isDirty: () => boolean;
};

type SectionKey = "general" | "inbound" | "outbound" | "storage" | "timeShared";

type FormSnapshot = {
  name: string;
  declaredInboundThroughput: string;
  currentInventory: string;
  storageShare: string;
  pipelineFlowPerHour: string;
  inboundRows: TransportRow[];
  outboundRows: TransportRow[];
  timeSharedMinBand: string;
  timeSharedDuration: string;
  useCustomChartColor: boolean;
  chartColorPicker: string;
};

function normalizeRows(rows?: TransportRow[], fallback?: Partial<TransportRow>): TransportRow[] {
  const base =
    rows && rows.length > 0
      ? rows.slice(0, 3)
      : [
          {
            mode: (fallback?.mode ?? "ship") as TransportMode,
            sharePct: 100,
            meps: Math.max(0, fallback?.meps ?? 0),
            roundtripHours: Math.max(0, fallback?.roundtripHours ?? 0)
          }
        ];
  return base.map((r) => ({
    mode: r.mode,
    sharePct: Number.isFinite(r.sharePct) ? r.sharePct : 0,
    meps: Number.isFinite(r.meps) ? r.meps : 0,
    roundtripHours: Number.isFinite(r.roundtripHours) ? r.roundtripHours : 0
  }));
}

function snapshotFromCustomer(
  customer: Customer | null | undefined,
  chartColorPaletteIndex: number
): FormSnapshot {
  const inbound = normalizeRows(customer?.inboundTransports, {
    mode: customer?.inboundMode ?? "ship",
    meps: customer?.inboundMEPS ?? 0,
    roundtripHours: customer?.inboundRoundtripHours ?? 0
  });
  const outbound = normalizeRows(customer?.outboundTransports, {
    mode: customer?.outboundMode ?? "ship",
    meps: customer?.outboundMEPS ?? 0,
    roundtripHours: customer?.outboundRoundtripHours ?? 0
  });
  const custom = normalizeChartColorHex(customer?.chartColor);
  return {
    name: customer?.name ?? "",
    declaredInboundThroughput: String(customer?.declaredInboundThroughput ?? ""),
    currentInventory: String(customer?.currentInventory ?? ""),
    storageShare: String(customer?.storageShare ?? ""),
    pipelineFlowPerHour: String(customer?.pipelineFlowPerHour ?? ""),
    inboundRows: inbound,
    outboundRows: outbound,
    timeSharedMinBand: String(customer?.timeSharedMinBand ?? 0),
    timeSharedDuration: String(customer?.timeSharedDuration ?? 24),
    useCustomChartColor: custom != null,
    chartColorPicker: custom ?? resolveCustomerChartColor(null, chartColorPaletteIndex)
  };
}

function snapshotsEqual(a: FormSnapshot, b: FormSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const CustomerForm = forwardRef<CustomerFormHandle, CustomerFormProps>(function CustomerForm(
  { customer, chartColorPaletteIndex = 0, onSaved, onDirtyChange },
  ref
) {

  const [name, setName] = useState(customer?.name ?? "");
  const [declaredInboundThroughput, setDeclaredInboundThroughput] = useState(
    String(customer?.declaredInboundThroughput ?? "")
  );
  const [currentInventory, setCurrentInventory] = useState(
    String(customer?.currentInventory ?? "")
  );
  const [storageShare, setStorageShare] = useState(
    String(customer?.storageShare ?? "")
  );
  const [pipelineFlowPerHour, setPipelineFlowPerHour] = useState(
    String(customer?.pipelineFlowPerHour ?? "")
  );
  const [inboundRows, setInboundRows] = useState<TransportRow[]>(
    normalizeRows(customer?.inboundTransports, {
      mode: customer?.inboundMode ?? "ship",
      meps: customer?.inboundMEPS ?? 0,
      roundtripHours: customer?.inboundRoundtripHours ?? 0
    })
  );
  const [outboundRows, setOutboundRows] = useState<TransportRow[]>(
    normalizeRows(customer?.outboundTransports, {
      mode: customer?.outboundMode ?? "ship",
      meps: customer?.outboundMEPS ?? 0,
      roundtripHours: customer?.outboundRoundtripHours ?? 0
    })
  );
  const [timeSharedMinBand, setTimeSharedMinBand] = useState(
    String(customer?.timeSharedMinBand ?? 0)
  );
  const [timeSharedDuration, setTimeSharedDuration] = useState(
    String(customer?.timeSharedDuration ?? 24)
  );
  const [useCustomChartColor, setUseCustomChartColor] = useState(
    normalizeChartColorHex(customer?.chartColor) != null
  );
  const [chartColorPicker, setChartColorPicker] = useState(
    () =>
      normalizeChartColorHex(customer?.chartColor) ??
      resolveCustomerChartColor(null, chartColorPaletteIndex)
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<SimulationConfig | null>(null);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    general: true,
    inbound: true,
    outbound: true,
    storage: true,
    timeShared: false
  });

  useEffect(() => {
    if (window.dbAPI) {
      window.dbAPI.getSimulationConfigs().then((configs: unknown[]) => {
        const c = configs[0] as {
          startDate: string;
          endDate: string;
          pipelineDirection: string;
        } | undefined;
        if (c) {
          setConfig({
            startDate: c.startDate,
            endDate: c.endDate,
            pipelineDirection: c.pipelineDirection as "inbound" | "outbound"
          });
        }
      });
    }
  }, []);

  useEffect(() => {
    const normalized = normalizeChartColorHex(customer?.chartColor);
    setUseCustomChartColor(normalized != null);
    setChartColorPicker(
      normalized ?? resolveCustomerChartColor(null, chartColorPaletteIndex)
    );
  }, [customer?.id, customer?.chartColor, chartColorPaletteIndex]);

  const inboundThroughput = parseFloat(declaredInboundThroughput) || 0;
  const pipelineTphVal = parseFloat(pipelineFlowPerHour) || 0;

  const throughputOverview = useMemo(() => {
    if (!config) return null;
    const preview: EngineCustomer = {
      id: customer?.id ?? "preview",
      name: name.trim() || "Preview",
      declaredInboundThroughput: inboundThroughput,
      currentInventory: parseFloat(currentInventory) || 0,
      storageShare: parseFloat(storageShare) || 0,
      pipelineFlowPerHour: pipelineTphVal,
      inboundTransports: inboundRows,
      outboundTransports: outboundRows,
      inboundMEPS: inboundRows[0]?.meps ?? 0,
      inboundMode: inboundRows[0]?.mode ?? "ship",
      outboundMEPS: outboundRows[0]?.meps ?? 0,
      outboundMode: outboundRows[0]?.mode ?? "ship",
      inboundRoundtripHours: inboundRows[0]?.roundtripHours ?? 0,
      outboundRoundtripHours: outboundRows[0]?.roundtripHours ?? 0,
      timeSharedMinBand: parseFloat(timeSharedMinBand) || 0,
      timeSharedDuration: parseFloat(timeSharedDuration) || 24
    };
    const engineConfig: EngineSimulationConfig = {
      startDate: new Date(config.startDate),
      endDate: new Date(config.endDate),
      pipelineFlowRate: 0,
      pipelineDirection: config.pipelineDirection,
      totalStorageCapacity: 100000,
      storageMode: "fixed_band",
      sharedInventoryCustomerDeficitLimitTonnes: 0,
      minSlotIntervalHours: 0,
      preOpsHours: 0,
      postOpsHours: 0,
      tankCount: 4,
      tankCapacity: 7000
    };
    return buildCustomerThroughputOverview(preview, engineConfig);
  }, [
    config,
    customer?.id,
    name,
    inboundThroughput,
    currentInventory,
    storageShare,
    pipelineTphVal,
    inboundRows,
    outboundRows,
    timeSharedMinBand,
    timeSharedDuration
  ]);

  const calculatedOutboundThroughput = throughputOverview?.calculatedOutboundTonnes ?? null;

  const numOutboundShips = (() => {
    if (calculatedOutboundThroughput == null || calculatedOutboundThroughput <= 0) return 0;
    const sumShare = outboundRows.reduce((s, r) => s + Math.max(0, r.sharePct), 0);
    const den = sumShare > 0 ? sumShare : outboundRows.length || 1;
    return outboundRows.reduce((sum, r) => {
      if (r.meps <= 0) return sum;
      const laneTonnes = calculatedOutboundThroughput * ((sumShare > 0 ? Math.max(0, r.sharePct) : 1) / den);
      return sum + Math.ceil(Math.max(0, laneTonnes) / r.meps);
    }, 0);
  })();

  const updateRow = (
    direction: "inbound" | "outbound",
    idx: number,
    patch: Partial<TransportRow>
  ) => {
    const setter = direction === "inbound" ? setInboundRows : setOutboundRows;
    setter((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addRow = (direction: "inbound" | "outbound") => {
    const setter = direction === "inbound" ? setInboundRows : setOutboundRows;
    setter((prev) => {
      if (prev.length >= 3) return prev;
      return [...prev, { mode: "ship", sharePct: 0, meps: 0, roundtripHours: 0 }];
    });
  };

  const removeRow = (direction: "inbound" | "outbound", idx: number) => {
    const setter = direction === "inbound" ? setInboundRows : setOutboundRows;
    setter((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== idx);
    });
  };

  const validateTransportRows = (label: string, rows: TransportRow[]): string | null => {
    if (rows.length === 0) return `${label} requires at least one mode row`;
    const shareSum = rows.reduce((s, r) => s + r.sharePct, 0);
    if (Math.abs(shareSum - 100) > 0.01) {
      return `${label} shares must sum to 100%`;
    }
    for (const r of rows) {
      if (!Number.isFinite(r.sharePct) || r.sharePct < 0) return `${label} shares must be non-negative`;
      if (!Number.isFinite(r.meps) || r.meps < 0) return `${label} MEPS must be non-negative`;
      if (!Number.isFinite(r.roundtripHours) || r.roundtripHours < 0) {
        return `${label} roundtrip hours must be non-negative`;
      }
    }
    return null;
  };

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const formKey = customer?.id ?? "__new__";
  const initialSnapshotRef = useRef<FormSnapshot>(snapshotFromCustomer(customer, chartColorPaletteIndex));

  const buildSnapshot = useCallback(
    (): FormSnapshot => ({
      name,
      declaredInboundThroughput,
      currentInventory,
      storageShare,
      pipelineFlowPerHour,
      inboundRows,
      outboundRows,
      timeSharedMinBand,
      timeSharedDuration,
      useCustomChartColor,
      chartColorPicker
    }),
    [
      name,
      declaredInboundThroughput,
      currentInventory,
      storageShare,
      pipelineFlowPerHour,
      inboundRows,
      outboundRows,
      timeSharedMinBand,
      timeSharedDuration,
      useCustomChartColor,
      chartColorPicker
    ]
  );

  useEffect(() => {
    initialSnapshotRef.current = snapshotFromCustomer(customer, chartColorPaletteIndex);
    onDirtyChange?.(false);
  }, [formKey, chartColorPaletteIndex, customer, onDirtyChange]);

  useEffect(() => {
    const dirty = !snapshotsEqual(initialSnapshotRef.current, buildSnapshot());
    onDirtyChange?.(dirty);
  }, [buildSnapshot, onDirtyChange]);

  const saveCustomer = useCallback(async (): Promise<boolean> => {
    setError(null);
    const throughput = parseFloat(declaredInboundThroughput);
    const inventory = parseFloat(currentInventory);
    const storageShareVal = parseFloat(storageShare);
    const pipelineTphParsed = parseFloat(pipelineFlowPerHour);
    if (!name.trim()) {
      setError("Name is required");
      return false;
    }
    if (isNaN(throughput) || throughput < 0) {
      setError("Inbound transport throughput must be a non-negative number");
      return false;
    }
    if (isNaN(inventory) || inventory < 0) {
      setError("Current inventory must be a non-negative number");
      return false;
    }
    if (isNaN(storageShareVal) || storageShareVal < 0 || storageShareVal > 100) {
      setError("Storage share must be between 0 and 100");
      return false;
    }
    if (isNaN(pipelineTphParsed) || pipelineTphParsed < 0) {
      setError("Pipeline flow must be a non-negative number (t/h)");
      return false;
    }
    const inboundError = validateTransportRows("Inbound", inboundRows);
    if (inboundError) {
      setError(inboundError);
      return false;
    }
    const outboundError = validateTransportRows("Outbound", outboundRows);
    if (outboundError) {
      setError(outboundError);
      return false;
    }
    const tsMin = parseFloat(timeSharedMinBand);
    const tsDur = parseFloat(timeSharedDuration);
    if (isNaN(tsMin) || tsMin < 0) {
      setError("Time-shared min band (x) must be a non-negative number");
      return false;
    }
    if (isNaN(tsDur) || tsDur <= 0) {
      setError("Time-shared triangle duration (y) must be a positive number");
      return false;
    }
    const chartColorSaved = useCustomChartColor ? normalizeChartColorHex(chartColorPicker) : null;
    if (useCustomChartColor && !chartColorSaved) {
      setError("Chart color must be a valid #RGB or #RRGGBB value");
      return false;
    }
    try {
      const inboundPrimary = inboundRows[0] ?? { mode: "ship" as TransportMode, meps: 0, roundtripHours: 0 };
      const outboundPrimary = outboundRows[0] ?? { mode: "ship" as TransportMode, meps: 0, roundtripHours: 0 };
      const c = {
        id: customer?.id ?? crypto.randomUUID(),
        name: name.trim(),
        declaredInboundThroughput: throughput,
        currentInventory: inventory,
        storageShare: storageShareVal,
        pipelineFlowPerHour: pipelineTphParsed,
        inboundTransports: inboundRows,
        outboundTransports: outboundRows,
        inboundMEPS: inboundPrimary.meps,
        inboundMode: inboundPrimary.mode,
        outboundMEPS: outboundPrimary.meps,
        outboundMode: outboundPrimary.mode,
        inboundRoundtripHours: inboundPrimary.roundtripHours,
        outboundRoundtripHours: outboundPrimary.roundtripHours,
        timeSharedMinBand: tsMin,
        timeSharedDuration: tsDur,
        chartColor: chartColorSaved
      };
      if (customer) {
        await window.dbAPI.updateCustomer(c);
      } else {
        await window.dbAPI.createCustomer(c);
      }
      onSaved?.();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    }
  }, [
    customer,
    name,
    declaredInboundThroughput,
    currentInventory,
    storageShare,
    pipelineFlowPerHour,
    inboundRows,
    outboundRows,
    timeSharedMinBand,
    timeSharedDuration,
    useCustomChartColor,
    chartColorPicker,
    onSaved
  ]);

  useImperativeHandle(
    ref,
    () => ({
      save: saveCustomer,
      isDirty: () => !snapshotsEqual(initialSnapshotRef.current, buildSnapshot())
    }),
    [saveCustomer, buildSnapshot]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void saveCustomer();
  };

  return (
    <form onSubmit={handleSubmit} className="customer-form-layout">
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card customer-form-summary">
        <div className="customer-form-summary-title">{customer ? "Editing customer" : "New customer"}</div>
        <div className="customer-form-summary-grid" style={{ marginBottom: 10 }}>
          <div>
            <div className="customer-form-summary-label">Name</div>
            <div className="customer-form-summary-value">{name.trim() || "—"}</div>
          </div>
          <div>
            <div className="customer-form-summary-label">Starting inventory</div>
            <div className="customer-form-summary-value">
              {currentInventory.trim() !== ""
                ? `${Math.round(parseFloat(currentInventory) || 0).toLocaleString()} t`
                : "—"}
            </div>
          </div>
        </div>
        {throughputOverview ? (
          <CustomerThroughputOverviewPanel overview={throughputOverview} />
        ) : (
          <p className="form-helper" style={{ margin: 0 }}>
            Set the simulation window under Terminal to see inbound/outbound throughput breakdown.
          </p>
        )}
        {calculatedOutboundThroughput != null && (
          <div className="customer-form-summary-grid" style={{ marginTop: 12 }}>
            <div>
              <div className="customer-form-summary-label">Estimated outbound movements</div>
              <div className="customer-form-summary-value">{numOutboundShips.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      <section className="customer-form-section card">
        <button
          type="button"
          className="customer-form-section-toggle"
          onClick={() => toggleSection("general")}
        >
          <span>General</span>
          <span>{openSections.general ? "Hide" : "Show"}</span>
        </button>
        {openSections.general && (
          <div className="customer-form-section-content">
            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                type="text"
                className={`form-input${fieldErrors.name ? " form-input-invalid" : ""}`}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (fieldErrors.name) setFieldErrors((p) => ({ ...p, name: "" }));
                }}
                required
                aria-invalid={!!fieldErrors.name}
              />
              {fieldErrors.name && <div className="form-error">{fieldErrors.name}</div>}
            </div>
            <div className="form-group">
              <label className="form-label">Starting inventory (tonnes)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                className={`form-input${fieldErrors.currentInventory ? " form-input-invalid" : ""}`}
                value={currentInventory}
                onChange={(e) => {
                  setCurrentInventory(e.target.value);
                  if (fieldErrors.currentInventory) setFieldErrors((p) => ({ ...p, currentInventory: "" }));
                }}
                required
              />
              <div className="form-helper">Stock at the start of the simulation window (same as Analytics “Starting”).</div>
              {fieldErrors.currentInventory && <div className="form-error">{fieldErrors.currentInventory}</div>}
            </div>
            <div className="form-group">
              <label className="form-label">Chart &amp; map color</label>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14 }}
                >
                  <input
                    type="checkbox"
                    checked={useCustomChartColor}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setUseCustomChartColor(on);
                      if (on)
                        setChartColorPicker((prev) =>
                          normalizeChartColorHex(prev) ??
                          resolveCustomerChartColor(null, chartColorPaletteIndex)
                        );
                    }}
                  />
                  Use fixed color
                </label>
                {useCustomChartColor ? (
                  <input
                    type="color"
                    value={chartColorPicker}
                    onChange={(e) => setChartColorPicker(e.target.value)}
                    aria-label="Chart color"
                    style={{ width: 44, height: 32, padding: 0, border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer" }}
                  />
                ) : (
                  <span
                    title="Preview of automatic palette color"
                    style={{
                      display: "inline-block",
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      border: "1px solid #cbd5e1",
                      background: resolveCustomerChartColor(null, chartColorPaletteIndex),
                      verticalAlign: "middle"
                    }}
                  />
                )}
              </div>
              <div className="form-helper">
                {useCustomChartColor
                  ? "This color is used in the Gantt, simulation map, inventory chart, and Analytics sparklines."
                  : "When off, a color is picked automatically from the default palette based on customer order."}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="customer-form-section card">
        <button
          type="button"
          className="customer-form-section-toggle"
          onClick={() => toggleSection("inbound")}
        >
          <span>Inbound transport</span>
          <span>{openSections.inbound ? "Hide" : "Show"}</span>
        </button>
        {openSections.inbound && (
          <div className="customer-form-section-content">
            <div className="form-group">
              <label className="form-label">Inbound transport throughput (t)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                className={`form-input${fieldErrors.declaredInboundThroughput ? " form-input-invalid" : ""}`}
                value={declaredInboundThroughput}
                onChange={(e) => {
                  setDeclaredInboundThroughput(e.target.value);
                  if (fieldErrors.declaredInboundThroughput) setFieldErrors((p) => ({ ...p, declaredInboundThroughput: "" }));
                }}
              />
              {fieldErrors.declaredInboundThroughput && (
                <div className="form-error">{fieldErrors.declaredInboundThroughput}</div>
              )}
              <div className="form-helper">Exclude pipeline — transport units only</div>
            </div>
            {inboundRows.map((row, idx) => (
              <div key={`in-${idx}`} className="form-grid" style={{ alignItems: "end", marginBottom: 10 }}>
                <div className="form-group">
                  <label className="form-label">Mode</label>
                  <select
                    className="form-select"
                    value={row.mode}
                    onChange={(e) => updateRow("inbound", idx, { mode: e.target.value as TransportMode })}
                  >
                    <option value="ship">Ship</option>
                    <option value="barge">Barge</option>
                    <option value="train">Train</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Share (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    className="form-input"
                    value={row.sharePct}
                    onChange={(e) => updateRow("inbound", idx, { sharePct: parseFloat(e.target.value || "0") })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">MEPS (t)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="form-input"
                    value={row.meps}
                    onChange={(e) => updateRow("inbound", idx, { meps: parseFloat(e.target.value || "0") })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Roundtrip (h)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="form-input"
                    value={row.roundtripHours}
                    onChange={(e) =>
                      updateRow("inbound", idx, { roundtripHours: parseFloat(e.target.value || "0") })
                    }
                  />
                </div>
                <div className="form-group" style={{ alignSelf: "center" }}>
                  <button type="button" className="btn btn-secondary" onClick={() => removeRow("inbound", idx)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-secondary" onClick={() => addRow("inbound")}>
              Add inbound mode
            </button>
            <div className="form-helper">Up to 3 rows; shares must total 100%.</div>
          </div>
        )}
      </section>

      <section className="customer-form-section card">
        <button
          type="button"
          className="customer-form-section-toggle"
          onClick={() => toggleSection("outbound")}
        >
          <span>Outbound transport</span>
          <span>{openSections.outbound ? "Hide" : "Show"}</span>
        </button>
        {openSections.outbound && (
          <div className="customer-form-section-content">
            {calculatedOutboundThroughput != null && config && (
              <p className="form-helper" style={{ marginTop: 0, marginBottom: 12 }}>
                See the summary card above for the full calculated outbound breakdown (including pipeline).
                Estimated outbound movements at current MEPS: <strong>{numOutboundShips}</strong>.
              </p>
            )}
            {outboundRows.map((row, idx) => (
              <div key={`out-${idx}`} className="form-grid" style={{ alignItems: "end", marginBottom: 10 }}>
                <div className="form-group">
                  <label className="form-label">Mode</label>
                  <select
                    className="form-select"
                    value={row.mode}
                    onChange={(e) => updateRow("outbound", idx, { mode: e.target.value as TransportMode })}
                  >
                    <option value="ship">Ship</option>
                    <option value="barge">Barge</option>
                    <option value="train">Train</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Share (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    className="form-input"
                    value={row.sharePct}
                    onChange={(e) => updateRow("outbound", idx, { sharePct: parseFloat(e.target.value || "0") })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">MEPS (t)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="form-input"
                    value={row.meps}
                    onChange={(e) => updateRow("outbound", idx, { meps: parseFloat(e.target.value || "0") })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Roundtrip (h)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className="form-input"
                    value={row.roundtripHours}
                    onChange={(e) =>
                      updateRow("outbound", idx, { roundtripHours: parseFloat(e.target.value || "0") })
                    }
                  />
                </div>
                <div className="form-group" style={{ alignSelf: "center" }}>
                  <button type="button" className="btn btn-secondary" onClick={() => removeRow("outbound", idx)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn-secondary" onClick={() => addRow("outbound")}>
              Add outbound mode
            </button>
            <div className="form-helper">Up to 3 rows; shares must total 100%.</div>
          </div>
        )}
      </section>

      <section className="customer-form-section card">
        <button
          type="button"
          className="customer-form-section-toggle"
          onClick={() => toggleSection("storage")}
        >
          <span>Storage and pipeline</span>
          <span>{openSections.storage ? "Hide" : "Show"}</span>
        </button>
        {openSections.storage && (
          <div className="customer-form-section-content">
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Storage share (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  className={`form-input${fieldErrors.storageShare ? " form-input-invalid" : ""}`}
                  value={storageShare}
                  onChange={(e) => {
                    setStorageShare(e.target.value);
                    if (fieldErrors.storageShare) setFieldErrors((p) => ({ ...p, storageShare: "" }));
                  }}
                  required
                />
                {fieldErrors.storageShare && <div className="form-error">{fieldErrors.storageShare}</div>}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Pipeline flow (t/h)</label>
              <input
                type="number"
                min="0"
                step="0.1"
                className={`form-input${fieldErrors.pipelineFlowPerHour ? " form-input-invalid" : ""}`}
                value={pipelineFlowPerHour}
                onChange={(e) => {
                  setPipelineFlowPerHour(e.target.value);
                  if (fieldErrors.pipelineFlowPerHour)
                    setFieldErrors((p) => ({ ...p, pipelineFlowPerHour: "" }));
                }}
                required
              />
              <div className="form-helper">
                Tonnes per hour for this customer. Terminal net direction is set in Terminal config.
              </div>
              {fieldErrors.pipelineFlowPerHour && (
                <div className="form-error">{fieldErrors.pipelineFlowPerHour}</div>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="customer-form-section card">
        <button
          type="button"
          className="customer-form-section-toggle"
          onClick={() => toggleSection("timeShared")}
        >
          <span>Time-shared storage</span>
          <span>{openSections.timeShared ? "Hide" : "Show"}</span>
        </button>
        {openSections.timeShared && (
          <div className="customer-form-section-content">
            <p className="form-helper" style={{ marginBottom: 12 }}>
              Used in Time-shared mode. x = minimum band (tonnes), y = entitlement triangle duration (hours).
            </p>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Min band x (tonnes)</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="form-input"
                  value={timeSharedMinBand}
                  onChange={(e) => setTimeSharedMinBand(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Triangle duration y (hours)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="form-input"
                  value={timeSharedDuration}
                  onChange={(e) => setTimeSharedDuration(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="customer-form-sticky-actions">
        <button type="submit" className="btn btn-primary">
          Save
        </button>
      </div>
    </form>
  );
});

export default CustomerForm;
