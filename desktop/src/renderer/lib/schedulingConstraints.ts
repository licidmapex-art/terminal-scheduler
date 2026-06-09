import type { LucideIcon } from "lucide-react";
import {
  Anchor,
  Brain,
  CheckCircle2,
  Lock,
  PauseCircle,
  Percent,
  ShieldAlert,
  TrendingDown,
  TrendingUp
} from "lucide-react";
import type { TransportModeStatus } from "../../engine/simulationLog";

export type BlockingConstraintKey = NonNullable<TransportModeStatus["blockingConstraint"]>;

export interface SchedulingConstraintDef {
  key: BlockingConstraintKey;
  label: string;
  /** Short text for plain-text tooltips and checklists. */
  icon: string;
  IconComponent: LucideIcon;
  color: string;
}

/** Scheduler blocking constraints in display order (matches Simulation Log icons). */
export const SCHEDULING_CONSTRAINTS: SchedulingConstraintDef[] = [
  {
    key: "pace_ahead",
    label: "Pace ahead",
    icon: "pace",
    IconComponent: PauseCircle,
    color: "#8b5cf6"
  },
  {
    key: "annual_target_met",
    label: "Annual target met",
    icon: "target",
    IconComponent: CheckCircle2,
    color: "#22c55e"
  },
  {
    key: "optimizer_days_of_cover",
    label: "Relative optimizer (DoC)",
    icon: "optimizer",
    IconComponent: Brain,
    color: "#06b6d4"
  },
  {
    key: "optimizer_fulfillment",
    label: "Relative optimizer (fulfilment)",
    icon: "fulfillment",
    IconComponent: Percent,
    color: "#a855f7"
  },
  {
    key: "roundtrip",
    label: "Roundtrip",
    icon: "roundtrip",
    IconComponent: Anchor,
    color: "#6366f1"
  },
  {
    key: "resource_occupied",
    label: "Resource occupied",
    icon: "resource",
    IconComponent: Lock,
    color: "#f59e0b"
  },
  {
    key: "insufficient_inventory",
    label: "Insufficient inventory",
    icon: "stock",
    IconComponent: TrendingDown,
    color: "#ef4444"
  },
  {
    key: "customer_inventory_floor",
    label: "Customer inventory floor",
    icon: "floor",
    IconComponent: ShieldAlert,
    color: "#64748b"
  },
  {
    key: "tank_full",
    label: "Tank full",
    icon: "tank",
    IconComponent: TrendingUp,
    color: "#ec4899"
  }
];

const defByKey = new Map(SCHEDULING_CONSTRAINTS.map((d) => [d.key, d]));

export function constraintDef(key: BlockingConstraintKey): SchedulingConstraintDef {
  return defByKey.get(key)!;
}

export function constraintDataKey(key: BlockingConstraintKey): string {
  return `constraint_${key}`;
}
