/**
 * Shared TypeScript types for terminal scheduling and inventory tracking.
 */

export interface Customer {
  id: string;
  name: string;
  /** Starting inventory (tonnes) at simulation start. */
  currentInventory: number;
  storageShare: number; // % of totalStorageCapacity (0-100)
  /** Net pipeline contribution for this customer, tonnes per hour (sign from terminal pipeline direction). */
  pipelineFlowPerHour: number;
  // Inbound transport
  declaredInboundThroughput: number; // tonnes of inbound transport units per period (0 if none)
  /** Preferred multi-mode model: up to 3 rows with share split. */
  inboundTransports?: CustomerTransportConfig[];
  /** Legacy single-row fields (kept for backward compatibility). */
  inboundMEPS: number; // max expected parcel size inbound (0 if none)
  inboundMode: "ship" | "barge" | "train";
  /** Hours before inbound vessel can return; 0 = space evenly across period */
  inboundRoundtripHours: number;
  // Outbound transport
  /** Preferred multi-mode model: up to 3 rows with share split. */
  outboundTransports?: CustomerTransportConfig[];
  /** Legacy single-row fields (kept for backward compatibility). */
  outboundMEPS: number; // max expected parcel size outbound (0 if none)
  outboundMode: "ship" | "barge" | "train";
  /** Hours before outbound vessel can return; 0 = space evenly across period */
  outboundRoundtripHours: number;
  /** Time-shared storage: min band x (tonnes) — triangle base at slot end (inbound) or start (outbound) */
  timeSharedMinBand: number;
  /** Time-shared storage: triangle duration y (hours) */
  timeSharedDuration: number;
  /** Optional hex color (#rrggbb) for charts, Gantt, and simulation map; omitted/null uses palette by customer order. */
  chartColor?: string | null;
  // outbound throughput is CALCULATED, never declared
}

export interface CustomerTransportConfig {
  mode: "ship" | "barge" | "train";
  /** 0..100; shares across active rows in a direction should sum to 100. */
  sharePct: number;
  meps: number;
  roundtripHours: number;
}

export type StorageMode =
  | "fixed_band"
  | "shared_shipping"
  | "time_shared_storage"
  | "shared_inventory";

export type ResourceType = "berth_large" | "berth_small" | "rail_siding";

export interface Blackout {
  id: string;
  resourceId: string;
  start: Date;
  end: Date;
}

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  flowRate: number; // tonnes per hour
  blackouts: Blackout[];
}

export type ScheduledSlotStatus = "scheduled" | "confirmed" | "manual_override";

export interface ScheduledSlot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  volume: number;
  start: Date;
  end: Date;
  status: ScheduledSlotStatus;
  conflictReason: string | null;
  /** Scheduler leg key; distinguishes multiple lanes with same mode/direction/customer. */
  legKey?: string | null;
}

export interface SimulationConfig {
  startDate: Date;
  endDate: Date;
  /** Legacy DB column; kept at 0. Total pipeline is sum of customers' pipelineFlowPerHour. */
  pipelineFlowRate: number;
  pipelineDirection: "inbound" | "outbound";
  totalStorageCapacity: number; // tonnes, terminal-wide
  storageMode: StorageMode;
  /**
   * Shared inventory only: max allowed deficit x (tonnes) for the booking customer’s attributed stock.
   * Outbound blocked when (attributed inv − MEPS) would be below −x. x = 0 means attributed inv cannot go negative.
   */
  sharedInventoryCustomerDeficitLimitTonnes: number;
  /**
   * Pacer rounding policy:
   * - up: allow the next slot once fractional pace reaches `pacerRoundAtDecile / 10`
   * - down: keep rounding down until fraction exceeds `1 - pacerRoundAtDecile / 10`
   */
  pacerRoundingDirection?: "up" | "down";
  /** Decile (1..9) controlling when pace allowance rounds to the next whole slot. */
  pacerRoundAtDecile?: number;
  /**
   * Relative optimizer: skip scheduling this leg when its DoC exceeds this multiple of the
   * cross-customer average DoC at that hour (others may still book). 0 disables.
   */
  optimizerRelativeDocMultiplier?: number;
  minSlotIntervalHours: number; // minimum hours between consecutive slots on the same resource (default: 0)
  /** Hours alongside before cargo transfer (mooring / line-up). Occupies berth; no inventory flow. */
  preOpsHours: number;
  /** Hours alongside after cargo transfer (flush / unmoor). Occupies berth; no inventory flow. */
  postOpsHours: number;
  /** Visual: number of tanks to draw in the simulation schematic (default: 4) */
  tankCount: number;
  /** Visual: per-tank capacity in tonnes (default: 7000) */
  tankCapacity: number;
}

/** Persisted inventory audit row (database). */
export interface InventorySnapshot {
  customerId: string;
  timestamp: Date;
  volume: number;
  source: "pipeline" | "slot" | "initial";
}
