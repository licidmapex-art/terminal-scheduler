import type { BlockingConstraintKey } from "../lib/schedulingConstraints";
import { SCHEDULING_CONSTRAINTS } from "../lib/schedulingConstraints";

export interface LegendEntry {
  id: string;
  label: string;
  kind: "color" | "line" | "dashed-line" | "rect" | "triangle" | "constraint";
  color?: string;
  dashArray?: string;
  icon?: string;
}

interface Props {
  entries: LegendEntry[];
}

export default function TimelineChartLegend({ entries }: Props) {
  if (entries.length === 0) return null;

  return (
    <div className="multi-metric-legend-panel" role="list" aria-label="Chart legend">
      {entries.map((entry) => (
        <div key={entry.id} className="multi-metric-legend-item" role="listitem">
          <LegendSwatch entry={entry} />
          <span className="multi-metric-legend-label">{entry.label}</span>
        </div>
      ))}
    </div>
  );
}

function LegendSwatch({ entry }: { entry: LegendEntry }) {
  switch (entry.kind) {
    case "color":
      return (
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 3,
            background: entry.color ?? "#64748b",
            flexShrink: 0
          }}
        />
      );
    case "line":
      return (
        <svg className="multi-metric-legend-swatch" width={40} height={14} aria-hidden>
          <line
            x1={0}
            y1={7}
            x2={40}
            y2={7}
            stroke={entry.color ?? "#0f172a"}
            strokeWidth={2.5}
          />
        </svg>
      );
    case "dashed-line":
      return (
        <svg className="multi-metric-legend-swatch" width={40} height={14} aria-hidden>
          <line
            x1={0}
            y1={7}
            x2={40}
            y2={7}
            stroke={entry.color ?? "#0f172a"}
            strokeWidth={entry.color === "#dc2626" ? 1 : 1.5}
            strokeDasharray={entry.dashArray ?? "6 3"}
          />
        </svg>
      );
    case "rect":
      return (
        <div
          style={{
            width: 20,
            height: 8,
            background: entry.color ?? "#d1d5db",
            borderRadius: 2,
            opacity: entry.color === "#ef4444" ? 1 : 0.85,
            flexShrink: 0
          }}
        />
      );
    case "triangle":
      return (
        <svg width={22} height={12} aria-hidden style={{ flexShrink: 0 }}>
          <polygon
            points="2,10 20,2 20,10"
            fill={entry.color ?? "rgba(59,130,246,0.35)"}
            stroke="rgba(15,23,42,0.25)"
            strokeWidth={0.5}
          />
        </svg>
      );
    case "constraint": {
      const def = SCHEDULING_CONSTRAINTS.find((d) => d.key === (entry.id as BlockingConstraintKey));
      const Icon = def?.IconComponent;
      return (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            flexShrink: 0
          }}
        >
          {Icon ? (
            <Icon size={12} color={def?.color ?? entry.color ?? "#64748b"} strokeWidth={2} aria-hidden />
          ) : null}
          <span
            style={{
              width: 16,
              height: 8,
              background: def?.color ?? entry.color ?? "#64748b",
              borderRadius: 2,
              display: "inline-block"
            }}
          />
        </span>
      );
    }
    default:
      return null;
  }
}
