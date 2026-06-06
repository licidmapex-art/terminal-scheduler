import type { TransportModeStatus } from "../../engine/simulationLog";

export type BlockingConstraintKey = NonNullable<TransportModeStatus["blockingConstraint"]>;

export interface SchedulingConstraintDef {
  key: BlockingConstraintKey;
  label: string;
  icon: string;
  color: string;
}

/** Scheduler blocking constraints in display order (matches Simulation Log icons). */
export const SCHEDULING_CONSTRAINTS: SchedulingConstraintDef[] = [
  { key: "pace_ahead", label: "Pace ahead", icon: "⏸", color: "#8b5cf6" },
  { key: "optimizer_days_of_cover", label: "Relative optimizer (DoC)", icon: "🧠", color: "#06b6d4" },
  { key: "roundtrip", label: "Roundtrip", icon: "⚓", color: "#6366f1" },
  { key: "resource_occupied", label: "Resource occupied", icon: "🚧", color: "#f59e0b" },
  { key: "insufficient_inventory", label: "Insufficient inventory", icon: "📉", color: "#ef4444" },
  { key: "customer_inventory_floor", label: "Customer inventory floor", icon: "⛔", color: "#64748b" },
  { key: "tank_full", label: "Tank full", icon: "📈", color: "#ec4899" }
];

const defByKey = new Map(SCHEDULING_CONSTRAINTS.map((d) => [d.key, d]));

export function constraintDef(key: BlockingConstraintKey): SchedulingConstraintDef {
  return defByKey.get(key)!;
}

export function constraintDataKey(key: BlockingConstraintKey): string {
  return `constraint_${key}`;
}
