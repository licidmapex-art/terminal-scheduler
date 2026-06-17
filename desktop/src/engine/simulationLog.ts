/**
 * Types for the simulation diagnostic log (built by the hour-by-hour scheduler).
 */

import type { StochasticEvent } from "../types";
import type { GradeLedgerSnapshot } from "./gradeInventoryLedger";

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
    | "annual_target_met"
    | "optimizer_days_of_cover"
    | "optimizer_fulfillment"
    | "insufficient_inventory"
    | "tank_full"
    | "customer_inventory_floor";

  constraintDetail: string | null;

  /** Leg sort metric at hour start (before new slots); lower = tried earlier — inbound: inv ÷ outbound pressure; outbound: headroom ÷ inbound pressure (or raw headroom if no fill). `null` when infinite. */
  daysOfCover?: number | null;
  /** Optimizer metric at hour start using relevant inventory context (terminal for shared modes, customer otherwise). `null` when infinite. */
  optimizerDaysOfCover?: number | null;
  /** Mass fulfilment ratio (tonnes delivered ÷ leg target tonnes) at hour start; lower = tried earlier in pooled legs. */
  fulfillmentRatio?: number | null;
  /** Hours since this leg's last slot start (sim start if none yet); higher = tried earlier when other metrics tie. */
  hoursSinceLastSlot?: number | null;
  /** Direction+mode pool average mass fulfilment at hour start (shared pools only). */
  poolFulfillmentAvg?: number | null;

  slotId?: string;
  volume?: number;
  resourceName?: string;
};

export interface SimulationLogRow {
  hour: number;
  datetime: string;
  customerInventories: Record<string, number>;
  /** Per-customer attributed green/blue/grey stock (shared mode grade ledger). */
  customerGradeInventories?: GradeLedgerSnapshot;
  terminalTotal: number;
  pipelineFlow: Record<string, number>;
  /** Mean of each customer's tightest leg DoC at this hour (relative optimizer). */
  averageCustomerDaysOfCover?: number | null;
  /** Terminal inventory ÷ summed outbound pressure and headroom ÷ summed inbound pressure (min when both). */
  combinedTerminalDaysOfCover?: number | null;
  transportStatus: TransportModeStatus[];
  /** Stochastic events active during this hour (when replay uses overrides). */
  stochasticEvents?: StochasticEvent[];
}
