import { useState, useEffect, useMemo, useCallback } from "react";
import { useStore } from "../store";
import { resolveCustomerChartColor } from "../lib/customerChartColor";

const HOUR_MS = 3_600_000;
const APPROACH_WINDOW_MS = 4 * HOUR_MS;

export interface SimCustomer {
  id: string;
  name: string;
  storageShare: number;
  pipelineFlowPerHour: number;
}

export interface SimResource {
  id: string;
  name: string;
  type: string;
  flowRate: number;
}

export interface SimSlot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
  end: string;
}

export interface SimConfig {
  startDate: string;
  endDate: string;
  pipelineFlowRate?: number;
  pipelineDirection?: string;
  totalStorageCapacity?: number;
  preOpsHours?: number;
  postOpsHours?: number;
  tankCount?: number;
  tankCapacity?: number;
}

export type VesselPhase = "idle" | "approach" | "pump" | "depart";

export interface VesselVisual {
  phase: VesselPhase;
  legT: number;
  pumpProgress: number;
}

export function getVesselVisual(
  slot: SimSlot,
  resource: SimResource,
  simStartMs: number,
  currentHour: number,
  preOpsHours = 0,
  postOpsHours = 0,
): VesselVisual {
  const tNow = simStartMs + currentHour * HOUR_MS;
  const startMs = new Date(slot.start).getTime();
  const endMs = new Date(slot.end).getTime();
  const preMs = Math.max(0, preOpsHours) * HOUR_MS;
  const postMs = Math.max(0, postOpsHours) * HOUR_MS;
  const cargoStartMs = startMs + preMs;
  const cargoEndMs = endMs - postMs;
  const W = APPROACH_WINDOW_MS;

  if (tNow < startMs - W || tNow >= endMs + W)
    return { phase: "idle", legT: 0, pumpProgress: 0 };

  const flow = resource.flowRate || 0;
  const loadingHours = (cargoEndMs - cargoStartMs) / HOUR_MS;
  let pumped = 0;
  if (loadingHours > 0 && flow > 0) {
    if (tNow > cargoStartMs) {
      const tEff = Math.min(tNow, cargoEndMs);
      pumped = Math.min(slot.volume, Math.max(0, ((tEff - cargoStartMs) / HOUR_MS) * flow));
    }
  }
  const pumpProgress = slot.volume > 0 ? Math.min(1, pumped / slot.volume) : 0;

  if (tNow < startMs) {
    const u = Math.min(1, Math.max(0, (tNow - (startMs - W)) / W));
    return { phase: "approach", legT: u, pumpProgress: 0 };
  }
  if (tNow < endMs) return { phase: "pump", legT: 0, pumpProgress };

  const u = Math.min(1, Math.max(0, (tNow - endMs) / W));
  return { phase: "depart", legT: u, pumpProgress: 1 };
}

export function sortResources(resources: SimResource[]): SimResource[] {
  const berths = resources
    .filter((r) => r?.type?.startsWith?.("berth"))
    .sort((a, b) =>
      a.type === "berth_large" && b.type !== "berth_large"
        ? -1
        : a.type !== "berth_large" && b.type === "berth_large"
          ? 1
          : 0,
    );
  const rails = resources.filter((r) => r?.type === "rail_siding");
  return [...berths, ...rails];
}

export function isAnyOperationActive(
  slots: SimSlot[],
  resourceRows: SimResource[],
  simStartMs: number,
  currentHour: number,
  preOpsHours = 0,
  postOpsHours = 0,
): boolean {
  for (const resource of resourceRows) {
    const slot = slots.find((s) => s.resourceId === resource.id);
    if (!slot) continue;
    if (
      getVesselVisual(slot, resource, simStartMs, currentHour, preOpsHours, postOpsHours).phase !==
      "idle"
    )
      return true;
  }
  return false;
}

export function useSimulationData() {
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);

  const [customers, setCustomers] = useState<SimCustomer[]>([]);
  const [resources, setResources] = useState<SimResource[]>([]);
  const [slots, setSlots] = useState<SimSlot[]>([]);
  const [timeline, setTimeline] = useState<Record<string, number[]>>({});
  const [timelineStart, setTimelineStart] = useState<string | null>(null);
  const [config, setConfig] = useState<SimConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      setLoadError(null);
      try {
        const [custs, res, cfgRaw, inv, slotList] = await Promise.all([
          window.dbAPI.getCustomers() as Promise<SimCustomer[]>,
          window.dbAPI.getResources() as Promise<SimResource[]>,
          window.dbAPI.getSimulationConfigs() as Promise<SimConfig[]>,
          window.schedulerAPI.getInventoryTimeline(),
          window.schedulerAPI.getSlots() as Promise<SimSlot[]>,
        ]);
        if (!mounted) return;
        setCustomers(Array.isArray(custs) ? custs : []);
        setResources(Array.isArray(res) ? res : []);
        const configs = Array.isArray(cfgRaw) ? cfgRaw : [];
        setConfig(configs[0] ?? null);
        const tl =
          inv && typeof inv === "object" && inv.timeline ? inv.timeline : null;
        setTimeline(tl && typeof tl === "object" ? tl : {});
        setTimelineStart(inv && "startDate" in inv ? inv.startDate : null);
        setSlots(Array.isArray(slotList) ? slotList : []);
      } catch (e) {
        if (mounted) setLoadError(String(e));
      }
    }
    load();
    return () => { mounted = false; };
  }, [lastSchedulerRun]);

  const totalHourCount = useMemo(() => {
    if (!config?.startDate || !config?.endDate) return 1;
    const period = Math.floor(
      (new Date(config.endDate).getTime() - new Date(config.startDate).getTime()) / HOUR_MS,
    );
    let longest = 0;
    for (const arr of Object.values(timeline)) {
      if (Array.isArray(arr) && arr.length > longest) longest = arr.length;
    }
    const fromTimeline = longest > 0 ? longest : period;
    if (period <= 0) return Math.max(fromTimeline, 1);
    return Math.max(1, Math.min(period, fromTimeline > 0 ? fromTimeline : period));
  }, [config, timeline]);

  const resourceRows = useMemo(() => sortResources(resources), [resources]);

  const simStartMs = config?.startDate
    ? new Date(config.startDate).getTime()
    : 0;

  const customerColor = useCallback(
    (customerId: string) => {
      const idx = customers.findIndex((c) => c.id === customerId);
      const cust = idx >= 0 ? customers[idx] : undefined;
      return resolveCustomerChartColor(cust?.chartColor, idx >= 0 ? idx : 0);
    },
    [customers],
  );

  const getInventoryAtHour = useCallback(
    (customerId: string, hour: number): number => {
      const arr = timeline[customerId];
      if (!arr || arr.length === 0) return 0;
      const idx = Math.min(hour, arr.length - 1);
      // Shared-inventory attribution may legitimately go negative (borrowing from pool).
      return arr[idx] ?? 0;
    },
    [timeline],
  );

  const customerById = useMemo(
    () => new Map(customers.map((c) => [c.id, c])),
    [customers],
  );

  const hasTimelineData = timeline && Object.keys(timeline).length > 0;

  const tankCount = Math.max(1, Math.floor(config?.tankCount ?? 4));
  const totalCapacity =
    config?.totalStorageCapacity != null && config.totalStorageCapacity > 0
      ? config.totalStorageCapacity
      : 100_000;
  const pipeRate = customers.reduce((s, c) => s + (c.pipelineFlowPerHour ?? 0), 0);
  const pipeInbound = config?.pipelineDirection !== "outbound";

  return {
    customers,
    resources,
    resourceRows,
    slots,
    timeline,
    timelineStart,
    config,
    loadError,
    totalHourCount,
    simStartMs,
    customerColor,
    getInventoryAtHour,
    customerById,
    hasTimelineData,
    tankCount,
    totalCapacity,
    pipeRate,
    pipeInbound,
  };
}
