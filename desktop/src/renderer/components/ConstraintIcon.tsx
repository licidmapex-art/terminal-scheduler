import { Minus } from "lucide-react";
import {
  constraintDef,
  type BlockingConstraintKey
} from "../lib/schedulingConstraints";

/** Monochrome line icon for constraint chips and legend (uses constraint color). */
export function ConstraintIcon({
  constraintKey,
  size = 14,
  color,
  strokeWidth = 2
}: {
  constraintKey: BlockingConstraintKey;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const def = constraintDef(constraintKey);
  const Icon = def.IconComponent;
  return <Icon size={size} color={color ?? def.color} strokeWidth={strokeWidth} aria-hidden />;
}

export function UncategorisedConstraintIcon({
  size = 14,
  color = "#94a3b8"
}: {
  size?: number;
  color?: string;
}) {
  return <Minus size={size} color={color} strokeWidth={2} aria-hidden />;
}
