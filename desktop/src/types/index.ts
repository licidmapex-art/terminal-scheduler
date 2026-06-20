/**
 * Shared TypeScript types for terminal scheduling and inventory tracking.
 */

export interface Customer {
  id: string;
  name: string;
  /** Starting inventory (tonnes) at simulation start. */
  currentInventory: number;
  storageShare: number; // % of totalStorageCapacity (0-100)
  /** Net pipeline: inbound − outbound (t/h); kept in sync when saving from the customer form. */
  pipelineFlowPerHour: number;
  /** Inbound pipeline fill rate (t/h). */
  pipelineInboundPerHour?: number;
  /** Outbound pipeline drain rate (t/h). */
  pipelineOutboundPerHour?: number;
  // Inbound transport
  declaredInboundThroughput: number; // tonnes of inbound transport units per period (0 if none)
  /** Multi-mode legs: same mode may appear more than once (different cargo sizes). */
  inboundTransports?: CustomerTransportConfig[];
  /** Legacy single-row fields (kept for backward compatibility). */
  inboundMEPS: number; // max expected parcel size inbound (0 if none)
  inboundMode: "ship" | "barge" | "train";
  /** Hours before inbound vessel can return; 0 = space evenly across period */
  inboundRoundtripHours: number;
  // Outbound transport
  /** Multi-mode legs: same mode may appear more than once (different cargo sizes). */
  outboundTransports?: CustomerTransportConfig[];
  /** Legacy single-row fields (kept for backward compatibility). */
  outboundMEPS: number; // max expected parcel size outbound (0 if none)
  outboundMode: "ship" | "barge" | "train";
  /** Hours before outbound vessel can return; 0 = space evenly across period */
  outboundRoundtripHours: number;
  /** Time-shared storage: min band x (tonnes) above inventory; triangle height = cargo (t) */
  timeSharedMinBand: number;
  /** Legacy stored duration (hours); chart uses cargo ÷ pipeline flow instead */
  timeSharedDuration: number;
  /** Optional hex color (#rrggbb) for charts, Gantt, and simulation map; omitted/null uses palette by customer order. */
  chartColor?: string | null;
  /** Grade mass balancing: share of all flows attributed to each grade (must sum to 100 when enabled). */
  gradeGreenPct?: number;
  gradeBluePct?: number;
  gradeGreyPct?: number;
  // outbound throughput is CALCULATED, never declared
}

export type SustainabilityGrade = "green" | "blue" | "grey";

export type PoolInventoryAllocation = "attributed" | "proportional";

export type BerthTransportMode = "ship" | "barge" | "train";

/** Inventory club — name only; physical settings live on customer transport legs. */
export interface TransportPool {
  id: string;
  name: string;
  /** @deprecated Legacy DB columns — not shown in UI. */
  mode?: BerthTransportMode;
  roundtripHours?: number;
  meps?: number;
  inventoryAllocation?: PoolInventoryAllocation;
}

export interface CustomerTransportConfig {
  /** `pool` = inventory-only club membership (no berth scheduling). */
  mode: BerthTransportMode | "pool";
  /** 0..100; shares across active rows in a direction should sum to 100. */
  sharePct: number;
  /** When true, share stays fixed while other movable legs are adjusted. */
  shareFixed?: boolean;
  meps: number;
  roundtripHours: number;
  /** References a shared {@link TransportPool}; null = private leg. */
  poolId?: string | null;
  /** WoA / laycan window length (hours) for this leg when terminal reservation mode is enabled. */
  reservationWindowHours?: number;
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
  /** WoA / laycan reservation window (light bar); null when mode is none. */
  reservationStart?: Date | null;
  reservationEnd?: Date | null;
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
  /** Enable grade-aware mass-balance accounting (RED-style bookkeeping by quarter). */
  gradeMassBalancingEnabled?: boolean;
  /** Allowed temporary grade deficit within a quarter (tonnes or % of quarter inbound). */
  gradeMassBalanceDeficitMode?: "tonnes" | "percent";
  /** Deficit limit in tonnes when mode is tonnes. */
  gradeMassBalanceDeficitLimitTonnes?: number;
  /** Deficit limit as % of quarter inbound when mode is percent. */
  gradeMassBalanceDeficitLimitPct?: number;
  /** Inbound: decile (1–9) — round up to next slot once fractional pace reaches decile/10. */
  pacerInboundRoundAtDecile?: number;
  /** Inbound offset (slots) added to the linear pace tracker; may be negative to delay starts. */
  pacerInboundAllowance?: number;
  /** Outbound: decile (1–9) — round up to next slot once fractional pace reaches decile/10. */
  pacerOutboundRoundAtDecile?: number;
  /** Outbound offset (slots) added to the linear pace tracker; may be negative to delay starts. */
  pacerOutboundAllowance?: number;
  /** @deprecated Legacy single decile — migrated to inbound/outbound fields. */
  pacerRoundAtDecile?: number;
  /**
   * Relative optimizer: skip scheduling this leg when its DoC exceeds this multiple of the
   * combined terminal DoC at that hour (others may still book). 0 disables.
   */
  optimizerRelativeDocMultiplier?: number;
  /** Yield when leg fulfilment % exceeds this × pool average (shared shipping / shared inventory inbound). 0 = off. */
  optimizerRelativeFulfillmentMultiplier?: number;
  /**
   * Feasibility warnings configuration (UI filters + thresholds).
   * When omitted, defaults are applied in the engine.
   */
  feasibilityWarnings?: Record<
    string,
    {
      enabled?: boolean;
      severity?: "amber" | "red";
      /** Optional numeric threshold; interpretation depends on warning key (usually percent). */
      threshold?: number;
    }
  >;
  minSlotIntervalHours: number; // minimum hours between consecutive slots on the same resource (default: 0)
  /** Hours alongside before cargo transfer (mooring / line-up). Occupies berth; no inventory flow. */
  preOpsHours: number;
  /** Hours alongside after cargo transfer (flush / unmoor). Occupies berth; no inventory flow. */
  postOpsHours: number;
  /** Visual: number of tanks to draw in the simulation schematic (default: 4) */
  tankCount: number;
  /** Visual: per-tank capacity in tonnes (default: 7000) */
  tankCapacity: number;
  /**
   * When barges can use both berth sizes:
   * - alternate: balance load across compatible berths (default)
   * - small_only: barges only use small berths
   * - prefer_small: use small berths when free; otherwise large
   */
  bargeBerthAllocation?: "alternate" | "small_only" | "prefer_small";
  /** Berth reservation model for scheduled slots: none, window of arrival, or laycan. */
  berthReservationMode?: BerthReservationMode;
  /**
   * Shared mode: which grades enforce the −x borrowing floor on outbound moves.
   * Default `all` matches legacy total-attributed floor behaviour.
   */
  borrowingGradeScope?: "all" | "same_grade" | "selected_grades";
  /** When scope is `selected_grades`, only these grades are floor-checked. */
  selectedBorrowingGrades?: SustainabilityGrade[];
  /** Optional per-grade −x limit (t); omitted grades use global x apportioned by grade share. */
  perGradeDeficitLimitTonnes?: Partial<Record<SustainabilityGrade, number>>;
  /** Optional stochastic scenario parameters (Phase 2+). */
  stochasticConfig?: StochasticConfig;
}

export type BerthReservationMode = "none" | "window_of_arrival" | "laycan";

/** Distribution for stochastic sampling (hours, multipliers, etc.). */
export type DistributionSpec =
  | { kind: "fixed"; value: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "triangular"; min: number; mode: number; max: number };

export type StochasticEventKind =
  | "arrival_delay"
  | "pipeline_reduction"
  | "pipeline_stop"
  | "immobilisation";

/** One resolved stochastic event for UI / simulation log. */
export interface StochasticEvent {
  id: string;
  kind: StochasticEventKind;
  hourStart: number;
  hourEnd: number;
  customerId?: string;
  slotId?: string;
  legKey?: string | null;
  resourceId?: string;
  magnitude?: number;
  label: string;
}

export interface StochasticLegDelayConfig {
  customerId: string;
  direction: "inbound" | "outbound";
  legKey?: string | null;
  /** Fraction of matching slots that receive a delay (0–1). Default 1 when omitted (legacy). */
  delayProbability?: number;
  delayHours: DistributionSpec;
}

export type StochasticDisruptionKind = "terminal" | "pipeline";

export type StochasticDisruptionImpact =
  | { kind: "full_stop" }
  | { kind: "partial"; multiplier: DistributionSpec };

/** Terminal immobilisation or pipeline stop/reduction during the simulation period. */
export interface StochasticDisruptionEvent {
  kind: StochasticDisruptionKind;
  label?: string;
  /** Probability this event occurs once per simulation period (0–1). Default 1 when omitted (legacy). */
  occurrenceProbability?: number;
  durationHours?: DistributionSpec;
  /** Fixed start hour from simulation start (legacy). */
  startHour?: number;
  /** Random start window: sample start hour in [startHourMin, startHourMax). */
  startHourMin?: number;
  startHourMax?: number;
  impact?: StochasticDisruptionImpact;
  /** Terminal only: when omitted, all berth resources are affected. */
  resourceId?: string;
}

/** @deprecated use StochasticDisruptionEvent */
export type StochasticImmobilisationSpec = StochasticDisruptionEvent;

/** User-configured stochastic parameters (scenario / simulation config). */
export interface StochasticConfig {
  enabled: boolean;
  seed?: number;
  legDelays: StochasticLegDelayConfig[];
  pipeline: {
    /** Hourly multiplier on nominal pipeline t/h (triangular / uniform). */
    flowMultiplier: DistributionSpec;
  };
  immobilisation: {
    events: StochasticDisruptionEvent[];
  };
}

export interface SlotTimeAdjustment {
  slotId: string;
  deltaStartMs: number;
  deltaEndMs: number;
  reason: string;
}

export interface ImmobilisationWindow {
  resourceId?: string;
  startMs: number;
  endMs: number;
  label: string;
}

/** Resolved overrides for one stochastic iteration (replay). */
export interface SimulationOverrides {
  slotAdjustments: SlotTimeAdjustment[];
  /** Simulation hour → customerId → pipeline rate multiplier (0 = stop). */
  pipelineMultiplierByHour: Record<number, Record<string, number>>;
  immobilisationWindows: ImmobilisationWindow[];
}

/** Per-hour inventory percentiles across Monte Carlo iterations. */
export interface InventoryPercentileSeries {
  p10: number[];
  p50: number[];
  p90: number[];
}

export interface MonteCarloCustomerSummary {
  customerId: string;
  minInventory: number;
  meanInventory: number;
  maxInventory: number;
  pctHoursBelowZero: number;
  warningRate: number;
}

export interface MonteCarloAggregates {
  terminalInventory: InventoryPercentileSeries;
  customerInventory: Record<string, InventoryPercentileSeries>;
  /** Effective flow multiplier (0–1) per hour across iterations — inbound pipeline row. */
  pipelineInbound: InventoryPercentileSeries;
  /** Effective flow multiplier (0–1) per hour across iterations — outbound pipeline row. */
  pipelineOutbound: InventoryPercentileSeries;
  warningCounts: Record<string, number>;
  eventHistograms: Record<StochasticEventKind, number>;
}

/** Persisted inventory audit row (database). */
export interface InventorySnapshot {
  customerId: string;
  timestamp: Date;
  volume: number;
  source: "pipeline" | "slot" | "initial";
}
