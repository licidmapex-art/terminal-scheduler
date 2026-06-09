import { useState, useEffect, useMemo } from "react";
import { NavLink } from "react-router-dom";
import { CalendarDays, Warehouse } from "lucide-react";
import { useStore } from "../store";
import { slotBerthOccupationHours } from "../../engine/slotLaytime";
import { outboundThroughputTonnes } from "../../engine/customerLegTargets";
import type { Customer as EngineCustomer, SimulationConfig as EngineSimulationConfig } from "../../types";

interface Slot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
  end: string;
  status?: string;
}

interface Resource {
  id: string;
  name: string;
  type: string;
}

interface Customer {
  id: string;
  name: string;
  pipelineFlowPerHour?: number;
  storageShare?: number;
  declaredInboundThroughput?: number;
}

interface SimulationConfig {
  startDate: string;
  endDate: string;
  pipelineFlowRate?: number;
  pipelineDirection?: string;
  totalStorageCapacity?: number;
  preOpsHours?: number;
  postOpsHours?: number;
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "No run yet";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} h ago`;
  const d = Math.floor(hr / 24);
  return `${d} d ago`;
}

function UtilBar({ pct }: { pct: number }) {
  const p = Math.max(0, Math.min(100, pct));
  const tier = p >= 80 ? "high" : p >= 50 ? "mid" : "low";
  return (
    <div className="util-bar-track">
      <div
        className={`util-bar-fill util-bar-fill--${tier}`}
        style={{ width: `${p}%` }}
        title={`${p}%`}
      />
    </div>
  );
}

export default function Dashboard() {
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [config, setConfig] = useState<SimulationConfig | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<Record<string, number[]> | null>(null);

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [s, r, c, cfg, warn, inv] = await Promise.all([
        window.schedulerAPI.getSlots(),
        window.dbAPI.getResources(),
        window.dbAPI.getCustomers(),
        window.dbAPI.getSimulationConfigs(),
        window.schedulerAPI.getFeasibilityWarnings(),
        window.schedulerAPI.getInventoryTimeline()
      ]);
      setSlots((s as Slot[]) ?? []);
      setResources((r as Resource[]) ?? []);
      setCustomers((c as Customer[]) ?? []);
      setConfig((Array.isArray(cfg) ? cfg[0] : null) as SimulationConfig | null);
      setWarnings(Array.isArray(warn) ? warn : []);
      const invPayload = inv as { timeline?: Record<string, number[]> } | null;
      setTimeline(invPayload?.timeline && typeof invPayload.timeline === "object" ? invPayload.timeline : null);
    }
    load();
  }, [lastSchedulerRun]);

  const customerById = useMemo(() => new Map(customers.map((cust) => [cust.id, cust])), [customers]);
  const resourceById = useMemo(() => new Map(resources.map((res) => [res.id, res])), [resources]);

  const periodHours = useMemo(() => {
    if (!config?.startDate || !config?.endDate) return 0;
    return (new Date(config.endDate).getTime() - new Date(config.startDate).getTime()) / (60 * 60 * 1000);
  }, [config]);

  const throughputHealth = useMemo(() => {
    if (!config || periodHours <= 0 || customers.length === 0) {
      return { allPass: true, rows: [] as { name: string; pass: boolean }[] };
    }
    const EPS = 0.5;
    const simCfg = config as EngineSimulationConfig;
    const rows: { name: string; pass: boolean }[] = [];
    for (const c of customers) {
      const expectedOutbound = Math.max(
        0,
        outboundThroughputTonnes(c as EngineCustomer, simCfg, periodHours)
      );
      const scheduledOutbound = slots
        .filter((sl) => sl.customerId === c.id && sl.direction === "outbound")
        .reduce((sum, sl) => sum + sl.volume, 0);
      const pass = expectedOutbound <= EPS ? true : scheduledOutbound + EPS >= expectedOutbound;
      rows.push({ name: c.name, pass });
    }
    return { allPass: rows.length > 0 && rows.every((x) => x.pass), rows };
  }, [customers, config, periodHours, slots]);

  const outboundVolume = useMemo(
    () => slots.reduce((sum, sl) => sum + (sl.direction === "outbound" ? sl.volume : 0), 0),
    [slots]
  );
  const inboundVolume = useMemo(
    () => slots.reduce((sum, sl) => sum + (sl.direction === "inbound" ? sl.volume : 0), 0),
    [slots]
  );
  const totalVolume = useMemo(() => slots.reduce((sum, sl) => sum + (sl.volume ?? 0), 0), [slots]);

  const recentSlots = useMemo(() => {
    return [...slots]
      .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
      .slice(0, 10);
  }, [slots]);

  const resourceUtilization = useMemo(() => {
    const ph =
      config && config.startDate && config.endDate
        ? (new Date(config.endDate).getTime() - new Date(config.startDate).getTime()) / (60 * 60 * 1000)
        : 168;
    return resources.map((res) => {
      const resSlots = slots.filter((sl) => sl.resourceId === res.id);
      const totalHours = resSlots.reduce(
        (acc, sl) => acc + slotBerthOccupationHours(sl, config ?? {}),
        0
      );
      const n = resSlots.length;
      const utilization = ph > 0 ? Math.round((totalHours / ph) * 1000) / 10 : 0;
      const avgHoursPerSlot = n > 0 ? Math.round((totalHours / n) * 10) / 10 : 0;
      return {
        id: res.id,
        name: res.name,
        type: res.type ?? "—",
        slotsCount: n,
        hoursOccupied: totalHours,
        avgHoursPerSlot,
        utilization
      };
    });
  }, [slots, resources, config]);

  const avgUtilizationPct = useMemo(() => {
    if (resourceUtilization.length === 0) return 0;
    return (
      Math.round(
        (resourceUtilization.reduce((sum, u) => sum + u.utilization, 0) / resourceUtilization.length) * 10
      ) / 10
    );
  }, [resourceUtilization]);

  const simulationPeriod = config
    ? `${new Date(config.startDate).toLocaleDateString()} – ${new Date(config.endDate).toLocaleDateString()}`
    : "Configure in Terminal";

  const hasScheduleData = slots.length > 0;
  const inventoryReady = timeline && Object.keys(timeline).length > 0;
  const hasCompletedFirstRun = lastSchedulerRun > 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Live snapshot of the last simulation and berth plan</p>
        </div>
      </div>

      <div className="dashboard-hero">
        <div>
          <div className="dashboard-hero-title">Terminal snapshot</div>
          <div className="dashboard-hero-meta">
            <div>
              <strong style={{ color: "#e2e8f0" }}>Last scheduler run:</strong> {formatRelativeTime(lastSchedulerRun)}
            </div>
            <div>
              Simulation window: <strong style={{ color: "#e2e8f0" }}>{simulationPeriod}</strong>
            </div>
            {hasCompletedFirstRun && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
                <span className={`badge ${warnings.length ? "badge-amber" : "badge-green"}`}>
                  {warnings.length ? `${warnings.length} feasibility warning(s)` : "No feasibility warnings"}
                </span>
                <span className={`badge ${throughputHealth.allPass ? "badge-green" : "badge-amber"}`}>
                  Throughput vs target:{" "}
                  {throughputHealth.rows.length === 0 ? "—" : throughputHealth.allPass ? "On target" : "Check gaps"}
                </span>
                <span className={`badge ${inventoryReady ? "badge-blue" : "badge-gray"}`}>
                  {inventoryReady ? "Inventory timeline loaded" : "Run scheduler for inventory curves"}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="dashboard-hero-actions">
          <NavLink to="/schedule" className="btn btn-primary">
            Schedule
          </NavLink>
          <NavLink to="/analytics" className="btn btn-secondary">
            Analytics
          </NavLink>
          <NavLink to="/config" className="btn btn-secondary">
            Terminal config
          </NavLink>
        </div>
      </div>

      {!hasScheduleData && customers.length > 0 && resources.length > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 24 }}>
          No slots in the current plan. Run the scheduler from the Schedule page to refresh metrics from your
          configuration.
        </div>
      )}

      <div className="kpi-grid--balanced">
        <div className="kpi-card kpi-card--primary">
          <div className="kpi-label">Slots in plan</div>
          <div className="kpi-value">{slots.length}</div>
          <div className="kpi-sub">
            Out {slots.filter((s) => s.direction === "outbound").length} · In{" "}
            {slots.filter((s) => s.direction === "inbound").length}
          </div>
        </div>
        <div className="kpi-card kpi-card--accent">
          <div className="kpi-label">Volume (scheduled)</div>
          <div className="kpi-value">{Math.round(totalVolume).toLocaleString()}</div>
          <div className="kpi-sub">
            Out {Math.round(outboundVolume).toLocaleString()} t · In {Math.round(inboundVolume).toLocaleString()} t
          </div>
        </div>
        <div className="kpi-card kpi-card--warn">
          <div className="kpi-label">Avg berth utilization</div>
          <div className="kpi-value">{avgUtilizationPct}%</div>
          <div className="kpi-sub">{resources.length} resource(s) · window {Math.round(periodHours)} h</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Customers · Resources</div>
          <div className="kpi-value" style={{ fontSize: 24 }}>
            {customers.length} · {resources.length}
          </div>
          <div className="kpi-sub">Master data in Configuration</div>
        </div>
      </div>

      <div className="dashboard-split">
        <div className="card">
          <div className="card-title">Recent movements</div>
          {recentSlots.length === 0 ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <div className="empty-state-icon">
                <CalendarDays size={48} strokeWidth={1.5} />
              </div>
              <div className="empty-state-title">No schedule yet</div>
              <div className="empty-state-text">
                Run the scheduler on the Schedule page after setting customers, resources, and terminal dates.
              </div>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Move</th>
                  <th style={{ textAlign: "right" }}>t</th>
                  <th>Resource</th>
                  <th>Start</th>
                </tr>
              </thead>
              <tbody>
                {recentSlots.map((sl) => (
                  <tr key={sl.id}>
                    <td>{customerById.get(sl.customerId)?.name ?? sl.customerId}</td>
                    <td>
                      <span className={`badge ${sl.direction === "outbound" ? "badge-amber" : "badge-blue"}`}>
                        {sl.direction} · {sl.mode}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>{sl.volume.toLocaleString()}</td>
                    <td>{resourceById.get(sl.resourceId)?.name ?? sl.resourceId}</td>
                    <td style={{ fontSize: 13, color: "#64748b" }}>
                      {new Date(sl.start).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-title">Resource utilization</div>
          {resourceUtilization.length === 0 ? (
            <div className="empty-state" style={{ padding: 40 }}>
              <div className="empty-state-icon">
                <Warehouse size={48} strokeWidth={1.5} />
              </div>
              <div className="empty-state-title">No resources</div>
              <div className="empty-state-text">Add berths or sidings under Resources.</div>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th style={{ textAlign: "right" }}>Slots</th>
                  <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Avg h / slot</th>
                  <th style={{ width: 140 }}>Load</th>
                  <th style={{ textAlign: "right" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {resourceUtilization.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: "#94a3b8" }}>{u.type}</div>
                    </td>
                    <td style={{ textAlign: "right" }}>{u.slotsCount}</td>
                    <td style={{ textAlign: "right" }}>
                      {u.slotsCount > 0 ? u.avgHoursPerSlot.toLocaleString() : "—"}
                    </td>
                    <td>
                      <UtilBar pct={u.utilization} />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span
                        className={`badge ${
                          u.utilization >= 80 ? "badge-amber" : u.utilization >= 50 ? "badge-blue" : "badge-gray"
                        }`}
                      >
                        {u.utilization}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {throughputHealth.rows.some((x) => !x.pass) && (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="card-title">Throughput attention</div>
          <p style={{ fontSize: 14, color: "#64748b", marginBottom: 12 }}>
            Scheduled outbound volume is below the model target for the following customers (see Analytics for
            detail).
          </p>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {throughputHealth.rows
              .filter((x) => !x.pass)
              .map((x) => (
                <li key={x.name} style={{ marginBottom: 4 }}>
                  {x.name}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
