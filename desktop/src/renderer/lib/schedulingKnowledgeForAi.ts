import type { StorageMode } from "../../types";
import { parseStorageMode } from "../../lib/storageMode";
import { SCHEDULING_CONSTRAINTS, type BlockingConstraintKey } from "./schedulingConstraints";

/** Plain-text remediation hints keyed by constraint (for AI + pre-computed diagnostics). */
export const CONSTRAINT_REMEDIATION: Record<
  BlockingConstraintKey,
  { meaning: string; typicalFixes: string[] }
> = {
  annual_target_met: {
    meaning: "Leg reached its slot target from declared throughput, MEPS, and roundtrip spacing.",
    typicalFixes: [
      "Raise declared inbound/outbound throughput or MEPS if more lifts are needed",
      "Shorten roundtrip hours if visits are too spread out",
      "Extend simulation horizon if targets are annualised over a short window"
    ]
  },
  pace_ahead: {
    meaning: "Pacing spreads slot starts across the horizon — this leg is ahead of its allowed pace curve.",
    typicalFixes: [
      "Relax pacer decile / allowance in Terminal config",
      "Lower declared throughput so pace curve is less aggressive",
      "Accept fewer early slots (expected behaviour if pacing is tight)"
    ]
  },
  optimizer_days_of_cover: {
    meaning: "Relative DoC optimizer skips legs whose days-of-cover exceeds × combined terminal DoC.",
    typicalFixes: [
      "Lower optimizer relative DoC multiplier or set to 0 to disable",
      "Reduce inventory or increase outbound pressure for over-stocked customers",
      "Prioritise under-covered customers via inbound slots / pipeline"
    ]
  },
  optimizer_fulfillment: {
    meaning: "Fulfilment optimizer skips inbound pool legs that are ahead on delivered ÷ target tonnes.",
    typicalFixes: [
      "Lower fulfilment optimizer multiplier or disable",
      "Rebalance declared throughput across customers sharing the inbound pool",
      "Check shared-inventory inbound pooling fairness"
    ]
  },
  roundtrip: {
    meaning: "Minimum hours since the last visit on the same leg have not elapsed.",
    typicalFixes: [
      "Reduce roundtrip hours on the customer transport leg",
      "Add parallel transport legs (mode/share split) or raise MEPS per visit",
      "Fewer slot targets if roundtrip forces wide spacing"
    ]
  },
  insufficient_inventory: {
    meaning: "Outbound move blocked — not enough stock to cover parcel size (MEPS).",
    typicalFixes: [
      "Raise starting inventory or inbound pipeline / inbound slot count",
      "Lower outbound MEPS or outbound throughput target",
      "In shared inventory: terminal pool may be empty — check other customers' draw"
    ]
  },
  customer_inventory_floor: {
    meaning: "Shared inventory: booking customer's attributed balance would fall below −x deficit limit.",
    typicalFixes: [
      "Raise shared-inventory deficit limit (less negative)",
      "Reduce outbound volume for that customer or increase inbound first",
      "Check attributed inventory vs pool borrowing rules"
    ]
  },
  tank_full: {
    meaning: "Inbound move blocked — parcel does not fit available storage (band or terminal pool).",
    typicalFixes: [
      "Increase total storage capacity or customer storage share (individual mode)",
      "Reduce inbound pipeline / inbound slot volume",
      "Increase outbound lifts to drain tanks; check max inventory vs capacity band"
    ]
  },
  resource_occupied: {
    meaning: "No compatible berth/rail free (blackout, min gap, laytime, or horizon end).",
    typicalFixes: [
      "Add berth/rail capacity or extend simulation end date",
      "Remove/blackout conflicts; reduce pre-/post-ops hours",
      "Shorten slot durations (flow rate) or spread visits via roundtrip/pacing"
    ]
  }
};

const SCHEDULER_OVERVIEW = `The scheduler runs one forward pass hour-by-hour. Each hour: (1) pipeline and in-progress berth cargo update inventory; (2) active transport legs are sorted by merit (days-of-cover score; mass fulfilment tie-break in shared inbound pools; then customer name); (3) legs are tried in order — at most one new load start per leg per hour; (4) each attempt must pass all gates below or is skipped with a blocking constraint recorded in the simulation log.`;

function scopeForMode(mode: StorageMode): string {
  switch (mode) {
    case "fixed_band":
      return "Individual storage: each customer has a dedicated capacity band (storage share × terminal total). Inventory gates use that customer's attributed stock. Constraints are per leg (customer × direction × mode).";
    case "shared_inventory":
      return "Shared inventory: one terminal-wide pool for tank-full / insufficient-stock checks; berth volume attributes 100% to the booking customer. Inbound pace and annual targets pool by transport mode; outbound stays per leg. Optional −x deficit floor on outbound.";
    case "shared_shipping":
      return "Shared shipping: similar pooling concepts apply to shipping-side fairness; check storage mode settings in Terminal config.";
    case "time_shared_storage":
      return "Time-shared storage: entitlement overlay on inventory charts; scheduling gates follow the configured storage mode semantics.";
    default:
      return "See Terminal config storage mode.";
  }
}

function gatesForMode(mode: StorageMode): Array<{ key: BlockingConstraintKey; question: string }> {
  const shared = mode === "shared_inventory" || mode === "shared_shipping";
  const gates: Array<{ key: BlockingConstraintKey; question: string }> = [
    { key: "annual_target_met", question: "Under annual slot target?" },
    { key: "pace_ahead", question: "On/behind pace spread?" },
    { key: "optimizer_days_of_cover", question: "Below DoC optimizer cap?" }
  ];
  if (shared) {
    gates.push({ key: "optimizer_fulfillment", question: "Below fulfilment optimizer cap (inbound pool)?" });
  }
  gates.push(
    { key: "roundtrip", question: "Roundtrip gap elapsed?" },
    { key: "insufficient_inventory", question: "Enough stock for outbound MEPS?" }
  );
  if (mode === "shared_inventory") {
    gates.push({ key: "customer_inventory_floor", question: "Above customer −x floor?" });
  }
  gates.push(
    { key: "tank_full", question: "Room for inbound parcel?" },
    { key: "resource_occupied", question: "Compatible berth/rail free?" }
  );
  return gates;
}

/** Reference text from "How scheduling works" (Introduction), tailored to storage mode. */
export function getSchedulingReferenceForAi(storageModeRaw?: string): string {
  const mode = parseStorageMode(storageModeRaw);
  const lines: string[] = [
    SCHEDULER_OVERVIEW,
    "",
    `Active storage mode: ${mode.replace(/_/g, " ")}`,
    scopeForMode(mode),
    "",
    "Merit order (sort only — lower DoC score tried first):",
    "- Inbound leg: inventory ÷ total outbound pressure (outbound pipeline + scheduled outbound lift rate)",
    "- Outbound leg: headroom ÷ total inbound fill (inbound pipeline + scheduled inbound lift rate), or raw headroom if no inbound fill",
    mode === "shared_inventory" || mode === "shared_shipping"
      ? "- Mass fulfilment tie-break: active for pooled inbound legs (delivered ÷ target tonnes)"
      : "- Mass fulfilment tie-break: not used in individual storage mode",
    "- Final tie-break: customer name (alphabetical)",
    "",
    "Decision gates (failed gate → idle hour with constraint icon):"
  ];

  for (const gate of gatesForMode(mode)) {
    const def = SCHEDULING_CONSTRAINTS.find((d) => d.key === gate.key);
    const rem = CONSTRAINT_REMEDIATION[gate.key];
    lines.push(
      `- ${def?.label ?? gate.key}: ${gate.question} ${rem.meaning} Fixes: ${rem.typicalFixes.slice(0, 2).join("; ")}.`
    );
  }

  lines.push(
    "",
    "Simulation log constraintBlockHours counts = idle leg-hours where that constraint was the primary block.",
    "Throughput target inbound = declared inbound transport + pipeline inbound over the period.",
    "Scheduled inbound = berth inbound cargo + pipeline delivered (from log when available)."
  );

  return lines.join("\n");
}

export function remediationForConstraintLabel(label: string): string {
  const def = SCHEDULING_CONSTRAINTS.find((d) => d.label === label);
  if (!def) return "Review simulation log and customer transport/storage settings.";
  const rem = CONSTRAINT_REMEDIATION[def.key];
  return `${rem.meaning} Typical fixes: ${rem.typicalFixes.join("; ")}.`;
}
