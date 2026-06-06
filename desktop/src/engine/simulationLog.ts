/**
 * Types for the simulation diagnostic log (built by the hour-by-hour scheduler).
 */

export type TransportModeStatus = {
  customerName: string;
  customerId: string;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  /** Distinguishes parallel lanes with same customer+direction+mode. */
  legKey?: string;
  legLabel?: string;

  action: "loaded" | "loading_in_progress" | "pre_ops" | "post_ops" | "idle";

  blockingConstraint:
    | null
    | "roundtrip"
    | "resource_occupied"
    | "pace_ahead"
    | "optimizer_days_of_cover"
    | "insufficient_inventory"
    | "tank_full"
    | "customer_inventory_floor";

  constraintDetail: string | null;

  /** Leg sort metric at hour start (before new slots); lower = tried earlier — inbound: inv ÷ outbound pressure; outbound: headroom ÷ inbound pressure (or raw headroom if no fill). `null` when infinite. */
  daysOfCover?: number | null;
  /** Optimizer metric at hour start using relevant inventory context (terminal for shared modes, customer otherwise). `null` when infinite. */
  optimizerDaysOfCover?: number | null;

  slotId?: string;
  volume?: number;
  resourceName?: string;
};

export interface SimulationLogRow {
  hour: number;
  datetime: string;
  customerInventories: Record<string, number>;
  terminalTotal: number;
  pipelineFlow: Record<string, number>;
  /** Mean of each customer's tightest leg DoC at this hour (relative optimizer). */
  averageCustomerDaysOfCover?: number | null;
  transportStatus: TransportModeStatus[];
}
