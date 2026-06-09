import { useState, useEffect, useRef, useCallback } from "react";
import CustomerForm, { type CustomerFormHandle } from "../components/CustomerForm";
import CustomerThroughputOverviewPanel from "../components/CustomerThroughputOverview";
import UnsavedChangesDialog from "../components/UnsavedChangesDialog";
import { PageTitleWithHelp, HelpPopover } from "../components/HelpPopover";
import { resolveCustomerChartColor } from "../lib/customerChartColor";
import { buildCustomerThroughputOverview } from "../lib/customerThroughputOverview";
import type { Customer as EngineCustomer, SimulationConfig as EngineSimulationConfig } from "../../types";

interface Customer {
  id: string;
  name: string;
  declaredInboundThroughput: number;
  currentInventory: number;
  storageShare: number;
  pipelineFlowPerHour: number;
  inboundTransports?: Array<{ mode: "ship" | "barge" | "train"; sharePct: number; meps: number; roundtripHours: number }>;
  outboundTransports?: Array<{ mode: "ship" | "barge" | "train"; sharePct: number; meps: number; roundtripHours: number }>;
  inboundMEPS?: number;
  inboundMode?: string;
  outboundMEPS?: number;
  outboundMode?: string;
  chartColor?: string | null;
}

interface SimulationConfig {
  startDate: string;
  endDate: string;
  pipelineFlowRate: number;
  pipelineDirection: "inbound" | "outbound";
  storageMode?: string;
  totalStorageCapacity?: number;
}

type PendingEditorAction = { type: "edit"; customer: Customer } | { type: "add" };

function parseStorageMode(raw: unknown): EngineSimulationConfig["storageMode"] {
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

function toEngineConfig(config: SimulationConfig): EngineSimulationConfig {
  return {
    startDate: new Date(config.startDate),
    endDate: new Date(config.endDate),
    pipelineFlowRate: config.pipelineFlowRate ?? 0,
    pipelineDirection: config.pipelineDirection,
    totalStorageCapacity: config.totalStorageCapacity ?? 100000,
    storageMode: parseStorageMode(config.storageMode),
    sharedInventoryCustomerDeficitLimitTonnes: 0,
    minSlotIntervalHours: 0,
    preOpsHours: 0,
    postOpsHours: 0,
    tankCount: 4,
    tankCapacity: 7000
  };
}

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [adding, setAdding] = useState(false);
  const [config, setConfig] = useState<SimulationConfig | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingEditorAction | null>(null);
  const formRef = useRef<CustomerFormHandle>(null);

  const load = () => {
    if (window.dbAPI) {
      window.dbAPI.getCustomers().then((c: unknown[]) => setCustomers(c as Customer[]));
      window.dbAPI.getSimulationConfigs().then((cfgs: unknown[]) => {
        const c = cfgs[0] as SimulationConfig | undefined;
        if (c) setConfig(c);
      });
    }
  };

  useEffect(() => load(), []);

  const showForm = adding || editing;
  const formCustomer = adding ? undefined : editing ?? undefined;
  const formSessionKey = adding ? "new" : (editing?.id ?? "none");

  const closeEditor = useCallback(() => {
    setAdding(false);
    setEditing(null);
    setFormDirty(false);
    setPendingAction(null);
  }, []);

  const applyPendingAction = useCallback((action: PendingEditorAction) => {
    if (action.type === "add") {
      setAdding(true);
      setEditing(null);
      setFormDirty(false);
      return;
    }
    setAdding(false);
    setEditing(action.customer);
    setFormDirty(false);
  }, []);

  const requestEditorAction = useCallback(
    (action: PendingEditorAction) => {
      if (!showForm) {
        applyPendingAction(action);
        return;
      }
      if (!formDirty) {
        applyPendingAction(action);
        return;
      }
      const sameEdit =
        action.type === "edit" &&
        editing != null &&
        !adding &&
        action.customer.id === editing.id;
      if (sameEdit) return;
      setPendingAction(action);
    },
    [showForm, formDirty, editing, adding, applyPendingAction]
  );

  const handleSaveAndClose = async () => {
    const ok = await formRef.current?.save();
    if (!ok) {
      setPendingAction(null);
      return;
    }
    load();
    if (pendingAction) {
      applyPendingAction(pendingAction);
    } else {
      closeEditor();
    }
  };

  const handleCloseWithoutSaving = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action) {
      applyPendingAction(action);
    }
  };

  const dialogMessage =
    pendingAction?.type === "edit"
      ? `You have unsaved changes for ${editing?.name ?? "this customer"}. Close without saving and open ${pendingAction.customer.name}?`
      : "You have unsaved changes. Close without saving and add a new customer?";

  return (
    <div>
      <div className="page-header">
        <div>
          <PageTitleWithHelp
            title="Customers"
            help="Manage customer profiles and storage allocations"
          />
        </div>
        <button className="btn btn-primary" onClick={() => requestEditorAction({ type: "add" })}>
          Add Customer
        </button>
      </div>

      <div className="customer-card-grid">
        {customers.map((c, idx) => {
          const overview =
            config != null
              ? buildCustomerThroughputOverview(c as EngineCustomer, toEngineConfig(config))
              : null;
          const chartSwatch = resolveCustomerChartColor(c.chartColor, idx);
          const active = editing?.id === c.id;
          return (
            <div key={c.id} className={`card customer-card${active ? " customer-card-active" : ""}`}>
              <div
                className="card-title"
                style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}
              >
                <span
                  title="Chart / map color"
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 4,
                    flexShrink: 0,
                    background: chartSwatch,
                    border: "1px solid #cbd5e1"
                  }}
                />
                {c.name}
              </div>
              <div className="customer-card-starting-inv">
                <span className="customer-card-starting-inv-label">Starting inventory</span>
                <span className="customer-card-starting-inv-value">
                  {Math.round(c.currentInventory ?? 0).toLocaleString()} t
                </span>
              </div>
              {overview ? (
                <CustomerThroughputOverviewPanel overview={overview} />
              ) : (
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
                  Configure the simulation window under Terminal to see throughput breakdown.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => requestEditorAction({ type: "edit", customer: c })}
                >
                  Edit
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => window.dbAPI?.deleteCustomer(c.id).then(load)}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showForm && (
        <div className="card customer-inline-editor">
          <div className="customer-inline-editor-head">
            <div>
              <div className="card-title-row" style={{ marginBottom: 4 }}>
                <div className="card-title" style={{ margin: 0 }}>
                  {adding ? "Add customer" : `Edit customer: ${editing?.name ?? ""}`}
                </div>
                <HelpPopover
                  label="Customer editor help"
                  content="Configure inbound and outbound behavior in clearly separated sections."
                />
              </div>
            </div>
            <div className="customer-inline-editor-actions">
              <button type="button" className="btn btn-primary" onClick={() => void handleSaveAndClose()}>
                Save and close
              </button>
              <button type="button" className="btn btn-secondary" onClick={closeEditor}>
                Close without saving
              </button>
            </div>
          </div>
          <CustomerForm
            key={formSessionKey}
            ref={formRef}
            customer={formCustomer}
            allCustomers={customers}
            chartColorPaletteIndex={
              adding ? customers.length : editing ? customers.findIndex((x) => x.id === editing.id) : 0
            }
            configPipelineDirection={config?.pipelineDirection}
            onDirtyChange={setFormDirty}
            onSaved={() => {
              closeEditor();
              load();
            }}
          />
        </div>
      )}

      <UnsavedChangesDialog
        open={pendingAction != null}
        message={dialogMessage}
        onSaveAndClose={() => void handleSaveAndClose()}
        onCloseWithoutSaving={handleCloseWithoutSaving}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
