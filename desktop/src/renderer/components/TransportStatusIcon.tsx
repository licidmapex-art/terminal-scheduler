import {
  CheckCircle2,
  Clock,
  FlagTriangleRight,
  Minus,
  RotateCw
} from "lucide-react";
import type { TransportModeStatus } from "../../engine/simulationLog";
import { ConstraintIcon } from "./ConstraintIcon";
import { constraintDef } from "../lib/schedulingConstraints";

const ICON_SIZE = 16;
const STROKE = 2;

/** Inline status glyph for Simulation Log grid cells. */
export default function TransportStatusIcon({
  status,
  size = ICON_SIZE
}: {
  status: TransportModeStatus | undefined;
  size?: number;
}) {
  if (!status) {
    return (
      <span style={{ color: "#94a3b8", fontSize: size, lineHeight: 1 }} aria-hidden>
        —
      </span>
    );
  }

  if (status.action === "loaded") {
    return <CheckCircle2 size={size} color="#22c55e" strokeWidth={STROKE} aria-hidden />;
  }
  if (status.action === "loading_in_progress") {
    return <RotateCw size={size} color="#3b82f6" strokeWidth={STROKE} aria-hidden />;
  }
  if (status.action === "pre_ops") {
    return <Clock size={size} color="#94a3b8" strokeWidth={STROKE} aria-hidden />;
  }
  if (status.action === "post_ops") {
    return <FlagTriangleRight size={size} color="#94a3b8" strokeWidth={STROKE} aria-hidden />;
  }

  if (status.blockingConstraint) {
    return (
      <ConstraintIcon constraintKey={status.blockingConstraint} size={size} strokeWidth={STROKE} />
    );
  }

  return <Minus size={size} color="#cbd5e1" strokeWidth={STROKE} aria-hidden />;
}

export function WorstConstraintIcon({
  constraint,
  size = 14
}: {
  constraint: TransportModeStatus["blockingConstraint"];
  size?: number;
}) {
  if (!constraint) return null;
  return <ConstraintIcon constraintKey={constraint} size={size} strokeWidth={STROKE} />;
}

/** Plain-text prefix for tooltips (no emoji). */
export function statusTooltipPrefix(status: TransportModeStatus | undefined): string {
  if (!status) return "";
  if (status.action === "loaded") return "Loaded";
  if (status.action === "loading_in_progress") return "Loading in progress";
  if (status.action === "pre_ops") return "Pre-ops";
  if (status.action === "post_ops") return "Post-ops";
  if (status.blockingConstraint) return constraintDef(status.blockingConstraint).label;
  return "Idle";
}
