import { useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceArea
} from "recharts";

type Direction = "inbound" | "outbound";
type TransportMode = "ship" | "barge" | "pipeline" | "train";
type PeriodPreset = "next_7_days" | "next_30_days" | "next_90_days" | "custom";
type RequestWindowMode = "terminal_period" | "custom";

interface TimeWindow {
  earliest: string;
  latest: string;
}

interface TransportRequestInput {
  id: string;
  direction: Direction;
  mode: TransportMode;
  productId: string;
  customerId: string;
  volume: number;
  requestedWindow: TimeWindow;
  estimatedDurationHours: number;
  priority: number;
}

interface ScheduledEvent {
  id: string;
  requestId: string;
  customerId: string;
  direction?: Direction;
  mode: TransportMode;
  volume?: number;
  start: string;
  end: string;
  resourceIds: string[];
}

function getTransportSymbols(direction?: Direction, mode?: TransportMode): string {
  const dirSym = direction === "inbound" ? "↓" : direction === "outbound" ? "↑" : "";
  const modeSym =
    mode === "ship"
      ? "🚢"
      : mode === "barge"
        ? "🚤"
        : mode === "train"
          ? "🚂"
          : mode === "pipeline"
            ? "⛽"
            : "";
  return [dirSym, modeSym].filter(Boolean).join(" ");
}

interface ScheduleResponse {
  events: ScheduledEvent[];
  unscheduledRequestIds: string[];
  unscheduled?: Array<{ requestId: string; reason: string }>;
}

interface TerminalProductConfig {
  id: string;
  name: string;
  storageCapacity: number;
  unit: "m3" | "tons";
}

interface TerminalConfigResponseConfigured {
  configured: true;
  periodStart: string;
  periodEnd: string;
  numberOfCustomers: number;
  borrowingEnabled: boolean;
  customers: CustomerConfig[];
  products: TerminalProductConfig[];
  fullParcelPercent?: number;
  minHoursBetweenSlots?: number;
  minHoursBetweenSlotsScope?: "all" | "per_mode";
  minSpacingHoursPerCustomer?: number;
  slotAllocationRuleInbound?: "lowest_inventory" | "round_robin";
  slotAllocationRuleOutbound?: "highest_inventory" | "round_robin";
  slotAllocationRuleConflict?: "inbound_first" | "outbound_first" | "round_robin";
  slotAllocationRule?: "highest_inventory" | "round_robin";
}

interface TerminalConfigResponseNotConfigured {
  configured: false;
}

type TerminalConfigResponse = TerminalConfigResponseConfigured | TerminalConfigResponseNotConfigured;

type TransportModeUnit = "none" | "ship" | "barge" | "train";

interface CustomerFlowConfig {
  desiredThroughputPerHour: number;
  pipelineRatePerHour: number;
  transportMode: TransportModeUnit;
  transportUnitSize: number;
  loadRatePerHour: number;
}

interface CustomerConfig {
  id: string;
  name: string;
  initialInventory: number;
  inbound: CustomerFlowConfig;
  outbound: CustomerFlowConfig;
}

export function App() {
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [terminalConfigured, setTerminalConfigured] = useState(false);
  const [terminalPeriodStart, setTerminalPeriodStart] = useState<string>("");
  const [terminalPeriodEnd, setTerminalPeriodEnd] = useState<string>("");
  const [terminalPeriodPreset, setTerminalPeriodPreset] = useState<PeriodPreset>("next_7_days");
  const [terminalNumberOfCustomers, setTerminalNumberOfCustomers] = useState<number>(5);
  const [terminalBorrowingEnabled, setTerminalBorrowingEnabled] = useState<boolean>(false);
  const [fullParcelPercent, setFullParcelPercent] = useState<number>(100);
  const [minHoursBetweenSlots, setMinHoursBetweenSlots] = useState<number>(0);
  const [minHoursBetweenSlotsScope, setMinHoursBetweenSlotsScope] = useState<"all" | "per_mode">("all");
  const [minSpacingHoursPerCustomer, setMinSpacingHoursPerCustomer] = useState<number>(0);
  const [slotAllocationRuleInbound, setSlotAllocationRuleInbound] = useState<
    "lowest_inventory" | "round_robin"
  >("lowest_inventory");
  const [slotAllocationRuleOutbound, setSlotAllocationRuleOutbound] = useState<
    "highest_inventory" | "round_robin"
  >("highest_inventory");
  const [slotAllocationRuleConflict, setSlotAllocationRuleConflict] = useState<
    "inbound_first" | "outbound_first" | "round_robin"
  >("inbound_first");
  const [terminalCustomers, setTerminalCustomers] = useState<CustomerConfig[]>([]);
  const [customerColorOverrides, setCustomerColorOverrides] = useState<Record<string, string>>({});
  const DEFAULT_CUSTOMER_COLORS = ["#06b6d4", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#22c55e", "#e11d48", "#6366f1"];
  const getCustomerColor = (customerId: string, index: number) =>
    customerColorOverrides[customerId] ?? DEFAULT_CUSTOMER_COLORS[index % DEFAULT_CUSTOMER_COLORS.length];
  const [terminalProducts, setTerminalProducts] = useState<TerminalProductConfig[]>([
    { id: "CO2", name: "CO2", storageCapacity: 10000, unit: "tons" }
  ]);

  const [requestWindowMode, setRequestWindowMode] =
    useState<RequestWindowMode>("terminal_period");

  const [request, setRequest] = useState<TransportRequestInput>({
    id: "req-1",
    direction: "inbound",
    mode: "ship",
    productId: "CO2",
    customerId: "cust-1",
    volume: 1000,
    requestedWindow: {
      earliest: new Date().toISOString(),
      latest: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    },
    estimatedDurationHours: 4,
    priority: 1
  });
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [simulationResult, setSimulationResult] = useState<{
    injection: Array<{
      at: string;
      pipelineInbound: number;
      pipelineOutbound: number;
      transportInbound: number;
      transportOutbound: number;
      customerInbound?: Record<string, number>;
      customerOutbound?: Record<string, number>;
    }>;
    inventory: {
      terminal: Array<{ at: string; value: number }>;
      customers: Record<string, Array<{ at: string; value: number }>>;
    };
    requestsGenerated?: number;
    scheduleSummary?: Record<string, {
      inbound: Array<{ mode: string; count: number; volume: number }>;
      outbound: Array<{ mode: string; count: number; volume: number }>;
    }>;
    violations?: Array<{ at: string; scope: string; id?: string; message: string }>;
    errorReport?: Array<{ likelyIssue: string; details?: string }>;
    hourlySchedulingDiagnostic?: Array<{
      hour: number;
      at: string;
      terminalInv: number;
      customerInv: Record<string, number>;
      eligible: string[];
      slotTriggered: boolean;
      assignedCustomer: string | null;
      loadedUnits: number;
      testResult: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presetChangedByUserRef = useRef(false);
  const [chartZoomDomain, setChartZoomDomain] = useState<[number, number] | null>(null);
  const chartZoomContainerRef = useRef<HTMLDivElement>(null);
  const chartZoomStateRef = useRef({ chartZoomDomain, simulationResult, setChartZoomDomain });
  chartZoomStateRef.current = { chartZoomDomain, simulationResult, setChartZoomDomain };
  useEffect(() => {
    const el = chartZoomContainerRef.current;
    if (!el || !simulationResult?.inventory?.terminal?.length) return;
    const handler = (e: WheelEvent) => {
      const { chartZoomDomain, simulationResult, setChartZoomDomain } = chartZoomStateRef.current;
      if (!simulationResult?.inventory?.terminal?.length) return;
      e.preventDefault();
      e.stopPropagation();
      const N = simulationResult.inventory.terminal.length;
      const rect = el.getBoundingClientRect();
      const fracX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const [minIdx, maxIdx] = chartZoomDomain ?? [0, N - 1];
      const centerIdx = minIdx + fracX * (maxIdx - minIdx);
      const span = maxIdx - minIdx;
      const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
      let newSpan = span * zoomFactor;
      newSpan = Math.max(1, Math.min(N, newSpan));
      let newMin = centerIdx - newSpan / 2;
      let newMax = centerIdx + newSpan / 2;
      if (newMin < 0) {
        newMax -= newMin;
        newMin = 0;
      }
      if (newMax > N - 1) {
        newMin -= newMax - (N - 1);
        newMax = N - 1;
      }
      newMin = Math.max(0, newMin);
      newMax = Math.min(N - 1, newMax);
      if (newMax - newMin >= N - 0.5) {
        setChartZoomDomain(null);
      } else {
        setChartZoomDomain([newMin, newMax]);
      }
    };
    el.addEventListener("wheel", handler, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", handler, { capture: true });
  }, [simulationResult?.inventory?.terminal?.length]);

  function computePeriodFromPreset(preset: PeriodPreset): { startIso: string; endIso: string } {
    const start = new Date();
    const end = new Date(start);
    switch (preset) {
      case "next_7_days":
        end.setDate(end.getDate() + 7);
        break;
      case "next_30_days":
        end.setDate(end.getDate() + 30);
        break;
      case "next_90_days":
        end.setDate(end.getDate() + 90);
        break;
      case "custom":
        end.setDate(end.getDate() + 1);
        break;
    }
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }

  function isoToDatetimeLocal(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  function datetimeLocalToIso(value: string): string {
    // value like "2026-02-23T21:30" interpreted in local time
    const d = new Date(value);
    return d.toISOString();
  }

  const formatLocaleDateTime = (isoOrDate: string | Date) => {
    const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    return d.toLocaleString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  };

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then(async () => {
        setBackendOk(true);
        const cfgRes = await fetch("/api/terminal/config");
        const cfg = (await cfgRes.json()) as TerminalConfigResponse;
        if (cfg.configured) {
          setTerminalConfigured(true);
          if (!presetChangedByUserRef.current) {
            setTerminalPeriodStart(cfg.periodStart);
            setTerminalPeriodEnd(cfg.periodEnd);
            const days = Math.round(
              (new Date(cfg.periodEnd).getTime() - new Date(cfg.periodStart).getTime()) /
                (24 * 60 * 60 * 1000)
            );
            if (days >= 85) setTerminalPeriodPreset("next_90_days");
            else if (days >= 25) setTerminalPeriodPreset("next_30_days");
            else if (days >= 5) setTerminalPeriodPreset("next_7_days");
            else setTerminalPeriodPreset("custom");
          }
          setTerminalNumberOfCustomers(cfg.numberOfCustomers ?? 5);
          setTerminalBorrowingEnabled(Boolean(cfg.borrowingEnabled));
          setFullParcelPercent(cfg.fullParcelPercent ?? 100);
          setMinHoursBetweenSlots(cfg.minHoursBetweenSlots ?? 0);
          setMinHoursBetweenSlotsScope(
            cfg.minHoursBetweenSlotsScope === "per_mode"
              ? "per_mode"
              : (cfg as { overlapRule?: string }).overlapRule === "per_mode"
              ? "per_mode"
              : "all"
          );
          setMinSpacingHoursPerCustomer(cfg.minSpacingHoursPerCustomer ?? 0);
          setSlotAllocationRuleInbound(cfg.slotAllocationRuleInbound ?? "lowest_inventory");
          setSlotAllocationRuleOutbound(cfg.slotAllocationRuleOutbound ?? cfg.slotAllocationRule ?? "highest_inventory");
          setSlotAllocationRuleConflict(cfg.slotAllocationRuleConflict ?? "round_robin");
          setTerminalCustomers(
            (Array.isArray(cfg.customers) ? cfg.customers : []).map((c) => ({
              ...c,
              inbound: { ...c.inbound, loadRatePerHour: c.inbound?.loadRatePerHour ?? 500 },
              outbound: { ...c.outbound, loadRatePerHour: c.outbound?.loadRatePerHour ?? 500 }
            }))
          );
          setTerminalProducts(cfg.products);
          setRequestWindowMode("terminal_period");
          setRequest((prev) => ({
            ...prev,
            productId: cfg.products[0]?.id ?? "CO2",
            requestedWindow: {
              earliest: cfg.periodStart,
              latest: cfg.periodEnd
            }
          }));
        } else {
          const { startIso, endIso } = computePeriodFromPreset(terminalPeriodPreset);
          setTerminalPeriodStart(startIso);
          setTerminalPeriodEnd(endIso);
        }
      })
      .catch(() => setBackendOk(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (terminalPeriodPreset !== "custom") {
      const { startIso, endIso } = computePeriodFromPreset(terminalPeriodPreset);
      setTerminalPeriodStart(startIso);
      setTerminalPeriodEnd(endIso);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalPeriodPreset]);

  useEffect(() => {
    setTerminalCustomers((prev) => {
      const n = terminalNumberOfCustomers;
      if (prev.length === n) return prev;
      if (prev.length < n) {
        const firstNewIdx = prev.length;
        return [
          ...prev,
          ...Array.from({ length: n - prev.length }, (_, i) => {
            const hasOutbound = prev.length + i < Math.min(2, n);
            const hasPipeline = hasOutbound && n >= 2;
            return {
              id: `cust-${prev.length + i + 1}`,
              name: `Customer ${prev.length + i + 1}`,
              initialInventory: 0,
              inbound: {
                desiredThroughputPerHour: 0,
                pipelineRatePerHour: hasPipeline ? 50 : 0,
                transportMode: "none",
                transportUnitSize: 0,
                loadRatePerHour: 500
              },
              outbound: {
                desiredThroughputPerHour: 0,
                pipelineRatePerHour: 0,
                transportMode: hasOutbound ? "ship" : "none",
                transportUnitSize: hasOutbound ? 18000 : 0,
                loadRatePerHour: 500
              }
            };
          })
        ];
      }
      return prev.slice(0, n);
    });
  }, [terminalNumberOfCustomers]);

  async function handleSaveTerminal() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/terminal/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart: terminalPeriodStart,
          periodEnd: terminalPeriodEnd,
          numberOfCustomers: terminalNumberOfCustomers,
          borrowingEnabled: terminalBorrowingEnabled,
          fullParcelPercent: fullParcelPercent,
          minHoursBetweenSlots: minHoursBetweenSlots,
          minHoursBetweenSlotsScope: minHoursBetweenSlotsScope,
          minSpacingHoursPerCustomer: minSpacingHoursPerCustomer,
          slotAllocationRuleInbound: slotAllocationRuleInbound,
          slotAllocationRuleOutbound: slotAllocationRuleOutbound,
          slotAllocationRuleConflict: slotAllocationRuleConflict,
          customers: terminalCustomers,
          products: terminalProducts
        })
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try {
          const json = JSON.parse(text);
          if (json?.error) msg = json.error;
        } catch {
          if (!text.trim()) msg = res.status === 500 ? "Backend may not be running. Start it with: cd backend && npm run dev" : `Save failed with status ${res.status}`;
        }
        throw new Error(msg || `Save failed with status ${res.status}`);
      }
      setTerminalConfigured(true);
      setRequestWindowMode("terminal_period");
      setRequest((prev) => ({
        ...prev,
        productId: terminalProducts[0]?.id ?? prev.productId,
        requestedWindow: {
          earliest: terminalPeriodStart,
          latest: terminalPeriodEnd
        }
      }));
    } catch (e: any) {
      setError(e.message ?? "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  function buildConfigForExport() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      periodStart: terminalPeriodStart,
      periodEnd: terminalPeriodEnd,
      periodPreset: terminalPeriodPreset,
      numberOfCustomers: terminalNumberOfCustomers,
      borrowingEnabled: terminalBorrowingEnabled,
      fullParcelPercent: fullParcelPercent,
      minHoursBetweenSlots: minHoursBetweenSlots,
      minHoursBetweenSlotsScope: minHoursBetweenSlotsScope,
      minSpacingHoursPerCustomer: minSpacingHoursPerCustomer,
      slotAllocationRuleInbound: slotAllocationRuleInbound,
      slotAllocationRuleOutbound: slotAllocationRuleOutbound,
      slotAllocationRuleConflict: slotAllocationRuleConflict,
      customers: terminalCustomers,
      products: terminalProducts,
      customerColorOverrides: customerColorOverrides
    };
  }

  function handleExportConfig() {
    const config = buildConfigForExport();
    const blob = new Blob([JSON.stringify(config, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const importFileInputRef = useRef<HTMLInputElement>(null);

  function handleImportConfig() {
    importFileInputRef.current?.click();
  }

  async function handleImportFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Record<string, unknown>;
      if (!data || typeof data !== "object") {
        throw new Error("Invalid config: expected JSON object");
      }
      const periodStart = typeof data.periodStart === "string" ? data.periodStart : null;
      const periodEnd = typeof data.periodEnd === "string" ? data.periodEnd : null;
      if (!periodStart || !periodEnd) {
        throw new Error("Invalid config: missing periodStart or periodEnd");
      }
      const products = Array.isArray(data.products) ? data.products : null;
      if (!products || products.length === 0) {
        throw new Error("Invalid config: products array required");
      }
      const customers = Array.isArray(data.customers) ? data.customers : null;
      if (!customers || customers.length === 0) {
        throw new Error("Invalid config: customers array required");
      }
      setTerminalPeriodStart(periodStart);
      setTerminalPeriodEnd(periodEnd);
      if (typeof data.periodPreset === "string") {
        setTerminalPeriodPreset(data.periodPreset as PeriodPreset);
      }
      setTerminalNumberOfCustomers(customers.length);
      setTerminalCustomers(
        customers.map((c: any) => ({
          id: c?.id ?? `cust-${customers.indexOf(c) + 1}`,
          name: c?.name ?? `Customer ${customers.indexOf(c) + 1}`,
          initialInventory: Number(c?.initialInventory) || 0,
          inbound: {
            desiredThroughputPerHour: Number(c?.inbound?.desiredThroughputPerHour) || 0,
            pipelineRatePerHour: Number(c?.inbound?.pipelineRatePerHour) || 0,
            transportMode: (c?.inbound?.transportMode ?? "none") as TransportModeUnit,
            transportUnitSize: Number(c?.inbound?.transportUnitSize) || 0,
            loadRatePerHour: Number(c?.inbound?.loadRatePerHour) || 500
          },
          outbound: {
            desiredThroughputPerHour: Number(c?.outbound?.desiredThroughputPerHour) || 0,
            pipelineRatePerHour: Number(c?.outbound?.pipelineRatePerHour) || 0,
            transportMode: (c?.outbound?.transportMode ?? "none") as TransportModeUnit,
            transportUnitSize: Number(c?.outbound?.transportUnitSize) || 0,
            loadRatePerHour: Number(c?.outbound?.loadRatePerHour) || 500
          }
        }))
      );
      setTerminalProducts(
        products.map((p: any, i: number) => ({
          id: p?.id ?? `prod-${i + 1}`,
          name: p?.name ?? p?.id ?? `Product ${i + 1}`,
          storageCapacity: Number(p?.storageCapacity) || 0,
          unit: (p?.unit === "tons" ? "tons" : "m3") as "m3" | "tons"
        }))
      );
      setTerminalBorrowingEnabled(Boolean(data.borrowingEnabled));
      setFullParcelPercent(Math.max(1, Math.min(100, Number(data.fullParcelPercent) || 100)));
      setMinHoursBetweenSlots(Math.max(0, Number(data.minHoursBetweenSlots) || 0));
      setMinHoursBetweenSlotsScope(
        data.minHoursBetweenSlotsScope === "per_mode"
          ? "per_mode"
          : (data as { overlapRule?: string }).overlapRule === "per_mode"
          ? "per_mode"
          : "all"
      );
      setMinSpacingHoursPerCustomer(Math.max(0, Number(data.minSpacingHoursPerCustomer) || 0));
      setSlotAllocationRuleInbound(
        data.slotAllocationRuleInbound === "round_robin" ? "round_robin" : "lowest_inventory"
      );
      setSlotAllocationRuleOutbound(
        data.slotAllocationRuleOutbound === "round_robin" ? "round_robin" : "highest_inventory"
      );
      setSlotAllocationRuleConflict(
        data.slotAllocationRuleConflict === "outbound_first"
          ? "outbound_first"
          : data.slotAllocationRuleConflict === "round_robin"
          ? "round_robin"
          : "inbound_first"
      );
      if (data.customerColorOverrides && typeof data.customerColorOverrides === "object") {
        setCustomerColorOverrides(data.customerColorOverrides as Record<string, string>);
      } else {
        setCustomerColorOverrides({});
      }
      setRequest((prev) => ({
        ...prev,
        productId: products[0]?.id ?? prev.productId,
        requestedWindow: { earliest: periodStart, latest: periodEnd }
      }));
    } catch (e: any) {
      setError(e.message ?? "Failed to load config");
    }
  }

  async function handlePropose() {
    setLoading(true);
    setError(null);
    try {
      if (!terminalConfigured) {
        throw new Error("Please configure the terminal first (period + products).");
      }

      // For this demo, we hard-code a simple resource set that matches the backend expectations
      await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { id: "berth-1", name: "Berth 1", type: "berth" },
          { id: "arm-1", name: "Arm 1", type: "loading_arm" },
          { id: "pipeline-1", name: "Pipeline 1", type: "pipeline" },
          { id: "siding-1", name: "Siding 1", type: "rail_siding" }
        ])
      });

      const requestToSend: TransportRequestInput =
        requestWindowMode === "terminal_period"
          ? {
              ...request,
              requestedWindow: {
                earliest: terminalPeriodStart,
                latest: terminalPeriodEnd
              }
            }
          : request;

      setSimulationResult(null);
      const res = await fetch("/api/schedule/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [requestToSend] })
      });
      if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`);
      }
      const data = (await res.json()) as ScheduleResponse;
      setSchedule(data);
    } catch (e: any) {
      setError(e.message ?? "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  async function handleRunSimulation() {
    setLoading(true);
    setError(null);
    setSchedule(null);
    setSimulationResult(null);
    try {
      if (!terminalConfigured) {
        throw new Error("Please configure the terminal first (period + product + customers).");
      }
      const res = await fetch("/api/simulate/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart: terminalPeriodStart,
          periodEnd: terminalPeriodEnd
        })
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Simulation failed with status ${res.status}`);
      }
      const data = await res.json();
      setSchedule(data.schedule as ScheduleResponse);
      setChartZoomDomain(null);
      setSimulationResult(
        data.inventory && data.schedule
          ? {
              injection: data.injection ?? [],
              inventory: data.inventory,
              requestsGenerated: data.requestsGenerated,
              scheduleSummary: data.scheduleSummary,
              violations: data.violations,
              errorReport: data.errorReport,
              hourlySchedulingDiagnostic: data.hourlySchedulingDiagnostic
            }
          : null
      );
    } catch (e: any) {
      setError(e.message ?? "Unexpected error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Terminal Scheduling Demo</h1>
        <p>Minimal web UI calling the scheduling backend.</p>
        <p>
          Backend status:{" "}
          {backendOk === null ? "checking..." : backendOk ? "connected" : "not reachable"}
        </p>
      </header>

      <main className="layout">
        <section className="card">
          <h2>Terminal Setup</h2>
          <p>
            Set the scheduling period and define products with their storage volume.
          </p>
          <div className="form-grid">
            <label>
              Period preset
              <select
                value={terminalPeriodPreset}
                onChange={(e) => {
                  presetChangedByUserRef.current = true;
                  setTerminalPeriodPreset(e.target.value as PeriodPreset);
                }}
              >
                <option value="next_7_days">Next 7 days</option>
                <option value="next_30_days">Next 30 days</option>
                <option value="next_90_days">Next 90 days</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>
              Period
              <select value="selected" disabled>
                <option value="selected">
                  {terminalPeriodStart && terminalPeriodEnd
                    ? `${formatLocaleDateTime(terminalPeriodStart)} → ${formatLocaleDateTime(
                        terminalPeriodEnd
                      )}`
                    : "Not set"}
                </option>
              </select>
            </label>
            <label>
              Number of customers
              <select
                value={terminalNumberOfCustomers}
                onChange={(e) =>
                  setTerminalNumberOfCustomers(Number(e.target.value))}
              >
                {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-grid">
            <label>
              Borrowing/lending enabled
              <select
                value={terminalBorrowingEnabled ? "yes" : "no"}
                onChange={(e) => setTerminalBorrowingEnabled(e.target.value === "yes")}
              >
                <option value="no">No (each customer must stay ≥ 0)</option>
                <option value="yes">Yes (terminal aggregate must stay ≥ 0)</option>
              </select>
            </label>
          </div>

          <h3>Scheduling constraints</h3>
          <div className="form-grid">
            <label>
              Full parcel size (%)
              <input
                type="number"
                min={1}
                max={100}
                value={fullParcelPercent}
                onChange={(e) => setFullParcelPercent(Math.max(1, Math.min(100, Number(e.target.value) || 100)))}
                title="Outbound: require inventory ≥ vessel size × this %. 100 = full parcel only."
              />
            </label>
            <label>
              Min hours between slots (h)
              <input
                type="number"
                min={0}
                value={minHoursBetweenSlots}
                onChange={(e) => setMinHoursBetweenSlots(Math.max(0, Number(e.target.value) || 0))}
                title="Minimum hours between end of one slot and start of next. 0 = no overlap (slots can touch)."
              />
            </label>
            <label>
              Slot spacing scope
              <select
                value={minHoursBetweenSlotsScope}
                onChange={(e) => setMinHoursBetweenSlotsScope(e.target.value as "all" | "per_mode")}
                title="Apply min gap between all slots, or only between same transport type (ship/train)"
              >
                <option value="all">All slots (one operation at a time across all types)</option>
                <option value="per_mode">Per transport type (ships don't overlap ships, trains don't overlap trains)</option>
              </select>
            </label>
            <label>
              Min spacing per customer (h)
              <input
                type="number"
                min={0}
                value={minSpacingHoursPerCustomer}
                onChange={(e) => setMinSpacingHoursPerCustomer(Math.max(0, Number(e.target.value) || 0))}
                title="Additional minimum hours between slots for same customer (round-trip)"
              />
            </label>
            <label>
              Slot allocation: Inbound
              <select
                value={slotAllocationRuleInbound}
                onChange={(e) =>
                  setSlotAllocationRuleInbound(e.target.value as "lowest_inventory" | "round_robin")
                }
                title="Inbound: who gets the next slot when multiple customers have inbound demand"
              >
                <option value="lowest_inventory">Lowest inventory</option>
                <option value="round_robin">Round-robin</option>
              </select>
            </label>
            <label>
              Slot allocation: Outbound
              <select
                value={slotAllocationRuleOutbound}
                onChange={(e) =>
                  setSlotAllocationRuleOutbound(e.target.value as "highest_inventory" | "round_robin")
                }
                title="Outbound: who gets the next slot when multiple customers are eligible"
              >
                <option value="highest_inventory">Highest inventory</option>
                <option value="round_robin">Round-robin</option>
              </select>
            </label>
            <label>
              Slot allocation: Inbound vs Outbound
              <select
                value={slotAllocationRuleConflict}
                onChange={(e) =>
                  setSlotAllocationRuleConflict(e.target.value as "inbound_first" | "outbound_first" | "round_robin")
                }
                title="Inbound first: schedule inbound from desired throughput, then outbound (needs room at start). Outbound first: drain before fill when terminal starts full."
              >
                <option value="inbound_first">Inbound first (then outbound)</option>
                <option value="outbound_first">Outbound first (drain before fill)</option>
                <option value="round_robin">Round-robin (alternate)</option>
              </select>
            </label>
          </div>

          {terminalPeriodPreset === "custom" && (
            <div className="form-grid">
              <label>
                Period start
                <input
                  type="datetime-local"
                  value={terminalPeriodStart ? isoToDatetimeLocal(terminalPeriodStart) : ""}
                  onChange={(e) => setTerminalPeriodStart(datetimeLocalToIso(e.target.value))}
                />
              </label>
              <label>
                Period end
                <input
                  type="datetime-local"
                  value={terminalPeriodEnd ? isoToDatetimeLocal(terminalPeriodEnd) : ""}
                  onChange={(e) => setTerminalPeriodEnd(datetimeLocalToIso(e.target.value))}
                />
              </label>
            </div>
          )}

          <div className="products">
            <div className="products-header">
              <strong>Terminal product</strong>
            </div>

            {terminalProducts.map((p, idx) => (
              <div className="product-row" key={`${p.id}-${idx}`}>
                <label>
                  Product
                  <select
                    value={p.id}
                    onChange={(e) => {
                      const newId = e.target.value;
                      const defaultUnit = newId === "LNG" ? "m3" : "tons";
                      setTerminalProducts((prev) =>
                        prev.map((x, i) =>
                          i === idx
                            ? { ...x, id: newId, name: newId, unit: defaultUnit }
                            : x
                        )
                      );
                    }}
                  >
                    <option value="CO2">CO₂</option>
                    <option value="LNG">LNG</option>
                    <option value="Ammonia">Ammonia</option>
                  </select>
                </label>
                <label>
                  Storage unit
                  <select
                    value={p.unit}
                    onChange={(e) =>
                      setTerminalProducts((prev) =>
                        prev.map((x, i) =>
                          i === idx
                            ? { ...x, unit: e.target.value === "tons" ? "tons" : "m3" }
                            : x
                        )
                      )
                    }
                  >
                    <option value="m3">m³</option>
                    <option value="tons">tons</option>
                  </select>
                </label>
                <label>
                  Storage volume
                  <input
                    type="number"
                    value={p.storageCapacity}
                    onChange={(e) =>
                      setTerminalProducts((prev) =>
                        prev.map((x, i) =>
                          i === idx
                            ? { ...x, storageCapacity: Number(e.target.value) || 0 }
                            : x
                        )
                      )
                    }
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="customers">
            <div className="products-header">
              <strong>Customers (throughput inputs)</strong>
            </div>

            <div className="customers-horizontal">
            {terminalCustomers.map((c, idx) => (
              <div key={c.id} className="customer-card">
                <div className="customer-title" style={{ borderLeftColor: getCustomerColor(c.id, idx) }}>
                  <input
                    type="text"
                    className="customer-name-input"
                    value={c.name}
                    onChange={(e) =>
                      setTerminalCustomers((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x))
                      )
                    }
                    title="Customer display name"
                  />
                  <span className="customer-id">({c.id})</span>
                  <input
                    type="color"
                    className="customer-color-picker"
                    value={getCustomerColor(c.id, idx)}
                    onChange={(e) =>
                      setCustomerColorOverrides((prev) => ({ ...prev, [c.id]: e.target.value }))
                    }
                    title="Customer color"
                  />
                </div>
                <div className="form-grid customer-initial">
                  <label>
                    Initial inv. ({terminalProducts[0]?.unit === "tons" ? "tons" : "m³"})
                    <input
                      type="number"
                      value={c.initialInventory}
                      onChange={(e) =>
                        setTerminalCustomers((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, initialInventory: Number(e.target.value) || 0 } : x
                          )
                        )
                      }
                    />
                  </label>
                </div>

                <div className="customer-flow-stack">
                  <div className="customer-col">
                    <strong className="flow-label">Inbound</strong>
                    <div className="flow-section flow-section-pipeline">
                      <span className="flow-section-title">Pipeline</span>
                      <label>
                        Pipeline rate ({terminalProducts[0]?.unit === "tons" ? "t/h" : "m³/h"})
                        <input
                          type="number"
                          value={c.inbound.pipelineRatePerHour}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inbound: { ...x.inbound, pipelineRatePerHour: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                        {terminalPeriodStart && terminalPeriodEnd && (
                          <span className="throughput-period-hint">
                            = {(
                              c.inbound.pipelineRatePerHour *
                              ((new Date(terminalPeriodEnd).getTime() - new Date(terminalPeriodStart).getTime()) /
                                (60 * 60 * 1000))
                            ).toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                            {terminalProducts[0]?.unit === "tons" ? "tons" : "m³"} for period
                          </span>
                        )}
                      </label>
                    </div>
                    <div className="flow-section flow-section-transport">
                      <span className="flow-section-title">Transport units (ship, barge, train)</span>
                      <label>
                        Desired throughput ({terminalProducts[0]?.unit === "tons" ? "t/h" : "m³/h"})
                        <input
                          type="number"
                          value={c.inbound.desiredThroughputPerHour}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inbound: {
                                        ...x.inbound,
                                        desiredThroughputPerHour: Number(e.target.value) || 0
                                      }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                        {terminalPeriodStart && terminalPeriodEnd && (
                          <span className="throughput-period-hint">
                            = {(
                              c.inbound.desiredThroughputPerHour *
                              ((new Date(terminalPeriodEnd).getTime() - new Date(terminalPeriodStart).getTime()) /
                                (60 * 60 * 1000))
                            ).toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                            {terminalProducts[0]?.unit === "tons" ? "tons" : "m³"} for period
                          </span>
                        )}
                      </label>
                      <label>
                        Transport unit mode
                        <select
                          value={c.inbound.transportMode}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inbound: {
                                        ...x.inbound,
                                        transportMode: e.target.value as TransportModeUnit
                                      }
                                    }
                                  : x
                              )
                            )
                          }
                        >
                          <option value="none">None</option>
                          <option value="ship">Ship</option>
                          <option value="barge">Barge</option>
                          <option value="train">Train</option>
                        </select>
                      </label>
                      <label>
                        Transport unit size ({terminalProducts[0]?.unit === "tons" ? "tons" : "m³"})
                        <input
                          type="number"
                          value={c.inbound.transportUnitSize}
                          disabled={c.inbound.transportMode === "none"}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inbound: { ...x.inbound, transportUnitSize: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                      </label>
                      <label>
                        Load/unload rate ({terminalProducts[0]?.unit === "tons" ? "t/h" : "m³/h"})
                        <input
                          type="number"
                          value={c.inbound.loadRatePerHour}
                          disabled={c.inbound.transportMode === "none"}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inbound: { ...x.inbound, loadRatePerHour: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                      </label>
                    </div>
                  </div>

                  <div className="customer-col">
                    <strong className="flow-label">Outbound</strong>
                    <div className="flow-section flow-section-pipeline">
                      <span className="flow-section-title">Pipeline</span>
                      <label>
                        Pipeline rate ({terminalProducts[0]?.unit === "tons" ? "t/h" : "m³/h"})
                        <input
                          type="number"
                          value={c.outbound.pipelineRatePerHour}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      outbound: { ...x.outbound, pipelineRatePerHour: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                        {terminalPeriodStart && terminalPeriodEnd && (
                          <span className="throughput-period-hint">
                            = {(
                              c.outbound.pipelineRatePerHour *
                              ((new Date(terminalPeriodEnd).getTime() - new Date(terminalPeriodStart).getTime()) /
                                (60 * 60 * 1000))
                            ).toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                            {terminalProducts[0]?.unit === "tons" ? "tons" : "m³"} for period
                          </span>
                        )}
                      </label>
                    </div>
                    <div className="flow-section flow-section-transport">
                      <span className="flow-section-title">Transport units (ship, barge, train)</span>
                      <label>
                        Transport unit mode
                        <select
                          value={c.outbound.transportMode}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      outbound: {
                                        ...x.outbound,
                                        transportMode: e.target.value as TransportModeUnit
                                      }
                                    }
                                  : x
                              )
                            )
                          }
                        >
                          <option value="none">None</option>
                          <option value="ship">Ship</option>
                          <option value="barge">Barge</option>
                          <option value="train">Train</option>
                        </select>
                      </label>
                      <label>
                        Transport unit size ({terminalProducts[0]?.unit === "tons" ? "tons" : "m³"})
                        <input
                          type="number"
                          value={c.outbound.transportUnitSize}
                          disabled={c.outbound.transportMode === "none"}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      outbound: { ...x.outbound, transportUnitSize: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                      </label>
                      <label>
                        Load/unload rate ({terminalProducts[0]?.unit === "tons" ? "t/h" : "m³/h"})
                        <input
                          type="number"
                          value={c.outbound.loadRatePerHour}
                          disabled={c.outbound.transportMode === "none"}
                          onChange={(e) =>
                            setTerminalCustomers((prev) =>
                              prev.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      outbound: { ...x.outbound, loadRatePerHour: Number(e.target.value) || 0 }
                                    }
                                  : x
                              )
                            )
                          }
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            </div>
          </div>

          <div className="terminal-actions">
            <button onClick={handleSaveTerminal} disabled={loading}>
              {loading ? "Saving..." : terminalConfigured ? "Save Terminal (update)" : "Save Terminal"}
            </button>
            <button type="button" onClick={handleExportConfig} className="btn-secondary">
              Export config
            </button>
            <button type="button" onClick={handleImportConfig} className="btn-secondary">
              Load config
            </button>
            <input
              ref={importFileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFileChange}
              style={{ display: "none" }}
            />
          </div>
          {terminalConfigured && <p className="ok">Terminal configured.</p>}
          {error && <p className="error">Error: {error}</p>}
        </section>

        <section className="card">
            <h2>Deterministic Scheduling</h2>
            <p>
              Ticker-based algorithm: a ticker increments each hour; when it reaches the threshold
              (period ÷ desired slots), a slot is attempted. Constraints (min/max inventory, overlap,
              spacing) are checked before placing. Duration = volume ÷ load rate.
            </p>
            {terminalConfigured && (
              <button onClick={handleRunSimulation} disabled={loading}>
                {loading ? "Running..." : "Run simulation"}
              </button>
            )}
            {!terminalConfigured && (
              <p className="warning">Configure the terminal first.</p>
            )}
            {simulationResult && simulationResult.inventory && (
              <>
              {(simulationResult.violations?.length ?? 0) > 0 && (
                <div className="violations-section">
                  <h3>Constraint violations</h3>
                  <ul>
                    {simulationResult.violations!.map((v, i) => (
                      <li key={i} className="violation-item">
                        <strong>{v.at}</strong> [{v.scope}{v.id ? ` ${v.id}` : ""}]: {v.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(simulationResult.errorReport?.length ?? 0) > 0 && (
                <div className="error-report-section">
                  <h3>Error report (no solution found)</h3>
                  <ul>
                    {simulationResult.errorReport!.map((e, i) => (
                      <li key={i} className="error-report-item">
                        <strong>{e.likelyIssue}</strong>
                        {e.details && <span> — {e.details}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <details className="inventory-table-section">
                <summary>Master log (hourly inventory, injection &amp; scheduling diagnostic)</summary>
                <p className="diagnostic-desc">
                  Per hour: inventory, pipeline/transport flows, accumulated throughput, and slot eligibility (Q1: sufficient inventory? Q2: customer entitled?).
                </p>
                <div className="inventory-table-wrap">
                  <table className="inventory-table diagnostic-table master-log-table">
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>Time</th>
                        {Object.keys(simulationResult.inventory.customers).map((cid) => (
                          <th key={cid}>{cid} inv</th>
                        ))}
                        <th>Terminal</th>
                        <th>Pipe in</th>
                        <th>Pipe out</th>
                        <th>Trans in</th>
                        <th>Trans out</th>
                        {Object.keys(simulationResult.inventory.customers).flatMap((cid) => [
                          <th key={`${cid}-acc-in`}>{cid} acc in</th>,
                          <th key={`${cid}-acc-out`}>{cid} acc out</th>
                        ])}
                        <th>Eligible</th>
                        <th>Slot?</th>
                        <th>Assigned</th>
                        <th>Loaded</th>
                        <th>Test result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const inj = simulationResult.injection ?? [];
                        const customerIds = Object.keys(simulationResult.inventory.customers);
                        const accByCustomer: Record<string, { in: number[]; out: number[] }> = {};
                        for (const cid of customerIds) {
                          accByCustomer[cid] = { in: [], out: [] };
                          let accIn = 0;
                          let accOut = 0;
                          for (let i = 0; i < inj.length; i++) {
                            const ci = inj[i].customerInbound?.[cid] ?? 0;
                            const co = inj[i].customerOutbound?.[cid] ?? 0;
                            accIn += ci;
                            accOut += co;
                            accByCustomer[cid].in.push(accIn);
                            accByCustomer[cid].out.push(accOut);
                          }
                        }
                        const diag = simulationResult.hourlySchedulingDiagnostic ?? [];
                        return simulationResult.inventory.terminal.map((pt, i) => {
                          const d = diag[i];
                          const injRow = inj[i];
                          return (
                            <tr key={i} className={d?.slotTriggered ? "slot-triggered" : ""}>
                              <td>{i}</td>
                              <td>{formatLocaleDateTime(pt.at)}</td>
                              {customerIds.map((cid) => (
                                <td key={cid}>
                                  {Math.round(simulationResult.inventory.customers[cid]?.[i]?.value ?? 0)}
                                </td>
                              ))}
                              <td><strong>{Math.round(pt.value)}</strong></td>
                              <td>{injRow ? injRow.pipelineInbound.toFixed(0) : "—"}</td>
                              <td>{injRow ? injRow.pipelineOutbound.toFixed(0) : "—"}</td>
                              <td>{injRow ? injRow.transportInbound.toFixed(0) : "—"}</td>
                              <td>{injRow ? injRow.transportOutbound.toFixed(0) : "—"}</td>
                              {customerIds.flatMap((cid) => [
                                <td key={`${cid}-acc-in`}>
                                  {accByCustomer[cid]?.in[i] != null ? Math.round(accByCustomer[cid].in[i]) : "—"}
                                </td>,
                                <td key={`${cid}-acc-out`}>
                                  {accByCustomer[cid]?.out[i] != null ? Math.round(accByCustomer[cid].out[i]) : "—"}
                                </td>
                              ])}
                              <td>{d?.eligible?.length ? d.eligible.join(", ") : "—"}</td>
                              <td>{d?.slotTriggered ? "✓" : "—"}</td>
                              <td>{d?.assignedCustomer ?? "—"}</td>
                              <td>{d?.loadedUnits ? Math.round(d.loadedUnits) : "—"}</td>
                              <td className="test-result">{d?.testResult ?? "—"}</td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </details>
              <div className="inventory-chart">
                <div className="inventory-chart-header">
                  <h3>Inventory over time</h3>
                  {chartZoomDomain && (
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setChartZoomDomain(null)}
                    >
                      Reset zoom
                    </button>
                  )}
                  <span className="inventory-chart-hint">Scroll over chart to zoom</span>
                </div>
                <div ref={chartZoomContainerRef} className="chart-zoom-container">
                {schedule && schedule.events.length > 0 && simulationResult.inventory.terminal.length > 0 && (
                  <div className="slot-timeline">
                    <div className="slot-timeline-row">
                      <div className="slot-timeline-spacer" />
                      <div className="slot-timeline-bar-wrap">
                        <div
                          className="slot-timeline-bar"
                          role="img"
                          aria-label="Scheduled slots by customer"
                        >
                      {(() => {
                        const N = simulationResult.inventory.terminal.length;
                        const [zoomMinIdx, zoomMaxIdx] = chartZoomDomain ?? [0, N - 1];
                        const zoomStartMs = new Date(simulationResult.inventory.terminal[Math.floor(zoomMinIdx)]!.at).getTime();
                        const zoomEndMs = new Date(simulationResult.inventory.terminal[Math.min(Math.ceil(zoomMaxIdx), N - 1)]!.at).getTime();
                        const totalMs = zoomEndMs - zoomStartMs || 1;
                        const custColors: Record<string, string> = Object.fromEntries(
                          Object.keys(simulationResult.inventory.customers).map((cid, i) => [
                            cid,
                            getCustomerColor(cid, i)
                          ])
                        );
                        return schedule.events.map((evt) => {
                          const startMs = new Date(evt.start).getTime();
                          const endMs = new Date(evt.end).getTime();
                          const visibleStart = Math.max(startMs, zoomStartMs);
                          const visibleEnd = Math.min(endMs, zoomEndMs);
                          if (visibleStart >= visibleEnd) return null;
                          const left = ((visibleStart - zoomStartMs) / totalMs) * 100;
                          const width = ((visibleEnd - visibleStart) / totalMs) * 100;
                          const color = custColors[evt.customerId] ?? "#64748b";
                          const symbols = getTransportSymbols(evt.direction, evt.mode);
                          return (
                            <div
                              key={evt.id}
                              className="slot-timeline-segment"
                              style={{
                                left: `${left}%`,
                                width: `${width}%`,
                                backgroundColor: color
                              }}
                              title={`${evt.customerId} ${evt.direction ?? ""} ${evt.mode} · ${formatLocaleDateTime(evt.start)} → ${formatLocaleDateTime(evt.end)}`}
                            >
                              {symbols && (
                                <span className="slot-timeline-symbol" title={symbols}>
                                  {symbols}
                                </span>
                              )}
                            </div>
                          );
                        });
                      })()}
                        </div>
                      </div>
                    </div>
                    <div className="slot-timeline-legend">
                      <span className="slot-legend-title">Slots:</span>
                      {Object.keys(simulationResult.inventory.customers).map((cid, i) => {
                        const custName = terminalCustomers.find((c) => c.id === cid)?.name ?? cid;
                        return (
                          <span key={cid} className="slot-legend-item">
                            <span className="slot-legend-dot" style={{ backgroundColor: getCustomerColor(cid, i) }} />
                            {custName}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <ResponsiveContainer width="100%" height={480}>
                  <LineChart
                    data={simulationResult.inventory.terminal.map((pt, i) => {
                      const row: Record<string, string | number> = {
                        at: pt.at,
                        time: formatLocaleDateTime(pt.at),
                        index: i,
                        Terminal: Math.round(pt.value)
                      };
                      for (const [custId, series] of Object.entries(
                        simulationResult.inventory.customers
                      )) {
                        const custPt = series[i];
                        if (custPt) row[custId] = Math.round(custPt.value);
                      }
                      return row;
                    })}
                    margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.3)" />
                    <XAxis
                      dataKey="index"
                      type="number"
                      domain={
                        chartZoomDomain
                          ? chartZoomDomain
                          : [0, Math.max(0, simulationResult.inventory.terminal.length - 1)]
                      }
                      allowDataOverflow
                      stroke="#94a3b8"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                      tickFormatter={(i) => {
                        const pt = simulationResult.inventory.terminal[i];
                        return pt ? formatLocaleDateTime(pt.at) : "";
                      }}
                    />
                    <YAxis width={50} stroke="#94a3b8" tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: "rgba(15,23,42,0.95)",
                        border: "1px solid rgba(148,163,184,0.3)",
                        borderRadius: "0.5rem"
                      }}
                      labelFormatter={(v) => {
                        const pt = simulationResult.inventory.terminal[Number(v)];
                        return pt ? formatLocaleDateTime(pt.at) : String(v);
                      }}
                    />
                    <Legend />
                    {schedule && schedule.events.length > 0 && simulationResult.inventory.terminal.length > 0 && (() => {
                      const periodStart = new Date(simulationResult.inventory.terminal[0]!.at).getTime();
                      const hourMs = 60 * 60 * 1000;
                      const custColors: Record<string, string> = Object.fromEntries(
                        Object.keys(simulationResult.inventory.customers).map((cid, i) => [
                          cid,
                          getCustomerColor(cid, i)
                        ])
                      );
                      return schedule.events.map((evt) => {
                        const startIdx = Math.max(0, (new Date(evt.start).getTime() - periodStart) / hourMs);
                        const endIdx = Math.min(simulationResult.inventory.terminal.length, (new Date(evt.end).getTime() - periodStart) / hourMs);
                        const color = custColors[evt.customerId] ?? "#64748b";
                        return (
                          <ReferenceArea
                            key={evt.id}
                            x1={Math.floor(startIdx)}
                            x2={Math.ceil(endIdx)}
                            fill={color}
                            fillOpacity={0.25}
                            stroke={color}
                            strokeOpacity={0.6}
                          />
                        );
                      });
                    })()}
                    <Line
                      type="monotone"
                      dataKey="Terminal"
                      stroke="#22c55e"
                      strokeWidth={2}
                      dot={false}
                      name="Terminal (sum)"
                    />
                    {Object.keys(simulationResult.inventory.customers).map((custId, i) => {
                      const custName = terminalCustomers.find((c) => c.id === custId)?.name ?? custId;
                      return (
                        <Line
                          key={custId}
                          type="monotone"
                          dataKey={custId}
                          stroke={getCustomerColor(custId, i)}
                          strokeWidth={1.5}
                          dot={false}
                          name={custName}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
                </div>
              </div>
              </>
            )}
          </section>

        <section className="card">
          <h2>Proposed Schedule</h2>
          {!schedule && <p>No schedule yet. Run simulation to see the proposed schedule.</p>}
          {schedule && (
            <>
              {schedule.events.length === 0 && (
                <div className="warning">
                  <p>No events scheduled.</p>
                  {simulationResult?.requestsGenerated === 0 && (
                    <p>
                      No slots were scheduled. Ensure: (1) <strong>Outbound transport</strong> (ship/barge/train) on at least one customer; (2) either <strong>Pipeline inbound</strong> (to supply inventory) or <strong>Inbound transport</strong> with desired throughput &gt; pipeline rate; (3) for outbound ships, either set <strong>Outbound desired throughput</strong> &gt; pipeline rate, or have pipeline inbound &gt; pipeline outbound so ships can load the excess. With 7 days, ensure pipeline rate × 168 h ≥ vessel size (e.g. 100 t/h × 168 = 16,800 &lt; 18,000 → try 30 days).
                    </p>
                  )}
                  {schedule.unscheduledRequestIds.length > 0 && (
                    <p>Unscheduled IDs: {schedule.unscheduledRequestIds.join(", ")}</p>
                  )}
                  {schedule.unscheduled && schedule.unscheduled.length > 0 && (
                    <ul>
                      {schedule.unscheduled.map((u) => (
                        <li key={u.requestId}>
                          <code>{u.requestId}</code>: {u.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {schedule.events.length > 0 && (simulationResult?.scheduleSummary || schedule.events.length > 0) && (
                <div className="schedule-summary" style={{ marginBottom: "1rem", padding: "0.75rem", background: "var(--bg-2)", borderRadius: 6 }}>
                  <strong>Schedule summary</strong>
                  <p style={{ margin: "0.5rem 0 0.25rem 0", fontSize: "0.9rem", color: "rgba(148,163,184,0.9)" }}>
                    Pipeline and transport volumes for the period; transport units scheduled by mode.
                  </p>
                  {(() => {
                    const unit = terminalProducts[0]?.unit ?? "";
                    const unitLabel = unit === "tons" ? "tons" : "m³";
                    const byMode = (dir: "inbound" | "outbound") => {
                      const m = new Map<string, { count: number; volume: number }>();
                      for (const e of schedule.events) {
                        if (e.direction !== dir) continue;
                        const cur = m.get(e.mode) ?? { count: 0, volume: 0 };
                        m.set(e.mode, { count: cur.count + 1, volume: cur.volume + (e.volume ?? 0) });
                      }
                      return Array.from(m.entries()).map(([mode, { count, volume }]) =>
                        `${count} ${mode}${count !== 1 ? "s" : ""} (${volume.toLocaleString()}${unit ? ` ${unit}` : ""})`
                      ).join(", ");
                    };
                    const inTotal = byMode("inbound");
                    const outTotal = byMode("outbound");
                    const inj = simulationResult?.injection ?? [];
                    const pipeInTotal = inj.reduce((s, r) => s + (r.pipelineInbound ?? 0), 0);
                    const pipeOutTotal = inj.reduce((s, r) => s + (r.pipelineOutbound ?? 0), 0);
                    return (
                      <>
                        <div style={{ marginTop: "0.5rem", marginBottom: "0.75rem" }}>
                          <strong style={{ display: "block", marginBottom: "0.25rem" }}>Terminal total</strong>
                          {(pipeInTotal > 0 || inTotal) && (
                            <div>
                              Inbound:{" "}
                              {pipeInTotal > 0 && (
                                <>Pipeline {pipeInTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} {unitLabel}{inTotal ? "; " : ""}</>
                              )}
                              {inTotal}
                            </div>
                          )}
                          {(pipeOutTotal > 0 || outTotal) && (
                            <div>
                              Outbound:{" "}
                              {pipeOutTotal > 0 && (
                                <>Pipeline {pipeOutTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })} {unitLabel}{outTotal ? "; " : ""}</>
                              )}
                              {outTotal}
                            </div>
                          )}
                        </div>
                        {simulationResult?.scheduleSummary && Object.keys(simulationResult.scheduleSummary).length > 0 && (
                          <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0, listStyle: "none" }}>
                            {Object.entries(simulationResult.scheduleSummary).map(([cid, s]) => {
                              const inStr = s.inbound.length > 0
                                ? s.inbound.map((x) =>
                                    `${x.count} ${x.mode}${x.count !== 1 ? "s" : ""} (${(x.volume ?? 0).toLocaleString()}${unit ? ` ${unit}` : ""})`
                                  ).join(", ")
                                : null;
                              const outStr = s.outbound.length > 0
                                ? s.outbound.map((x) =>
                                    `${x.count} ${x.mode}${x.count !== 1 ? "s" : ""} (${(x.volume ?? 0).toLocaleString()}${unit ? ` ${unit}` : ""})`
                                  ).join(", ")
                                : null;
                              if (!inStr && !outStr) return null;
                              return (
                                <li key={cid} style={{ marginBottom: "0.25rem" }}>
                                  <code>{cid}</code>:{" "}
                                  {inStr && <>Inbound: {inStr}</>}
                                  {inStr && outStr && " · "}
                                  {outStr && <>Outbound: {outStr}</>}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
              {schedule.events.length > 0 && (
                <div className="schedule-list">
                  {schedule.events.map((evt) => (
                    <div key={evt.id} className="schedule-item">
                      <div>
                        <strong>{evt.mode.toUpperCase()}</strong> for{" "}
                        <code>{evt.customerId}</code> (req {evt.requestId})
                        {evt.volume != null && (
                          <> · Parcel: {evt.volume.toLocaleString()}{terminalProducts[0]?.unit ? ` ${terminalProducts[0].unit}` : ""}</>
                        )}
                      </div>
                      <div>
                        {formatLocaleDateTime(evt.start)} → {formatLocaleDateTime(evt.end)}
                      </div>
                      <div>Resources: {evt.resourceIds.join(", ")}</div>
                    </div>
                  ))}
                </div>
              )}
              {schedule.unscheduled && schedule.unscheduled.length > 0 && (
                <div className="warning">
                  <strong>Unscheduled</strong>
                  <ul>
                    {schedule.unscheduled.map((u) => (
                      <li key={u.requestId}>
                        <code>{u.requestId}</code>: {u.reason}
                      </li>
                    ))}
                  </ul>
                  <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                    For inbound: vessel size must be ≤ terminal capacity; desired throughput &gt; pipeline rate.
                    Try &quot;Outbound first&quot; if terminal starts full (no room to receive).
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
