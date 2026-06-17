import { useMemo } from "react";
import { HelpPopover } from "./HelpPopover";
import {
  GRADE_COLORS,
  SUSTAINABILITY_GRADES,
  aggregateGradeMassBalanceByGrade,
  type GradeMassBalanceByGradeRow,
  type QuarterlyGradeMassBalanceRow,
  type SustainabilityGrade
} from "../../engine/gradeMassBalance";
import { resolveCustomerChartColor } from "../lib/customerChartColor";

interface CustomerColorRef {
  id: string;
  name: string;
  chartColor?: string | null;
}

interface GradeMassBalancePanelProps {
  rows: QuarterlyGradeMassBalanceRow[];
  customers: CustomerColorRef[];
  customerOrderIndex: Map<string, number>;
  deficitMode: "tonnes" | "percent";
  deficitLimitTonnes: number;
  deficitLimitPct: number;
}

interface CustomerStackPart {
  customerId: string;
  name: string;
  color: string;
  tonnes: number;
}

function maxCellScale(cells: GradeMassBalanceByGradeRow[]): number {
  let max = 1;
  for (const c of cells) {
    max = Math.max(max, c.inboundTonnes, c.outboundTonnes);
  }
  return max;
}

function sortedCustomerParts(
  parts: GradeMassBalanceByGradeRow["customerParts"],
  direction: "inbound" | "outbound",
  customers: CustomerColorRef[],
  customerOrderIndex: Map<string, number>
): CustomerStackPart[] {
  return parts
    .map((p) => ({
      customerId: p.customerId,
      name: p.customerName,
      color: resolveCustomerChartColor(
        customers.find((c) => c.id === p.customerId)?.chartColor,
        customerOrderIndex.get(p.customerId) ?? 0
      ),
      tonnes: direction === "inbound" ? p.inboundTonnes : p.outboundTonnes
    }))
    .filter((p) => p.tonnes > 0)
    .sort(
      (a, b) =>
        (customerOrderIndex.get(a.customerId) ?? 0) - (customerOrderIndex.get(b.customerId) ?? 0)
    );
}

function StackedBar({
  parts,
  total,
  scale,
  barMax,
  gradeColor,
  faded
}: {
  parts: CustomerStackPart[];
  total: number;
  scale: number;
  barMax: number;
  gradeColor: string;
  faded?: boolean;
}) {
  const totalH = scale > 0 ? Math.max(total > 0 ? 4 : 0, (total / scale) * barMax) : 0;

  if (parts.length === 0 && total <= 0) {
    return (
      <div className="gmb-bar-stack" style={{ height: barMax }}>
        <div className="gmb-bar gmb-bar--empty" style={{ height: 2 }} />
      </div>
    );
  }

  if (parts.length <= 1) {
    const h = scale > 0 ? Math.max(2, (total / scale) * barMax) : 0;
    return (
      <div className="gmb-bar-stack" style={{ height: barMax }}>
        <div
          className="gmb-bar"
          style={{
            height: h,
            background: parts[0]?.color ?? gradeColor,
            opacity: faded ? 0.72 : 1
          }}
          title={parts[0] ? `${parts[0].name}: ${parts[0].tonnes.toLocaleString()} t` : undefined}
        />
      </div>
    );
  }

  return (
    <div className="gmb-bar-stack" style={{ height: barMax }}>
      {parts.map((p) => {
        const h = scale > 0 ? Math.max(1, (p.tonnes / scale) * barMax) : 0;
        return (
          <div
            key={p.customerId}
            className="gmb-bar gmb-bar--segment"
            style={{
              height: h,
              background: p.color,
              opacity: faded ? 0.72 : 1
            }}
            title={`${p.name}: ${p.tonnes.toLocaleString()} t`}
          />
        );
      })}
      {totalH < barMax && <div className="gmb-bar-spacer" style={{ flex: 1, minHeight: 0 }} />}
    </div>
  );
}

function QuarterCell({
  cell,
  grade,
  scale,
  customers,
  customerOrderIndex,
  deficitMode,
  deficitLimitTonnes,
  deficitLimitPct
}: {
  cell: GradeMassBalanceByGradeRow | undefined;
  grade: SustainabilityGrade;
  scale: number;
  customers: CustomerColorRef[];
  customerOrderIndex: Map<string, number>;
  deficitMode: "tonnes" | "percent";
  deficitLimitTonnes: number;
  deficitLimitPct: number;
}) {
  const barMax = 72;
  const gradeColor = GRADE_COLORS[grade];

  if (!cell) {
    return <td className="gmb-matrix-cell gmb-matrix-cell--empty">—</td>;
  }

  const limit =
    deficitMode === "percent"
      ? (cell.inboundTonnes * deficitLimitPct) / 100
      : deficitLimitTonnes;
  const breach = cell.endBalanceTonnes < -limit - 0.01;
  const inParts = sortedCustomerParts(cell.customerParts, "inbound", customers, customerOrderIndex);
  const outParts = sortedCustomerParts(cell.customerParts, "outbound", customers, customerOrderIndex);

  return (
    <td className={`gmb-matrix-cell${breach ? " gmb-matrix-cell--breach" : ""}`}>
      <div className="gmb-pair-bars">
        <div className="gmb-bar-col">
          <StackedBar
            parts={inParts}
            total={cell.inboundTonnes}
            scale={scale}
            barMax={barMax}
            gradeColor={gradeColor}
          />
          <div className="gmb-bar-caption">In</div>
          <div className="gmb-bar-value">{cell.inboundTonnes.toLocaleString()}</div>
        </div>
        <div className="gmb-bar-col">
          <StackedBar
            parts={outParts}
            total={cell.outboundTonnes}
            scale={scale}
            barMax={barMax}
            gradeColor={gradeColor}
            faded
          />
          <div className="gmb-bar-caption">Out</div>
          <div className="gmb-bar-value">{cell.outboundTonnes.toLocaleString()}</div>
        </div>
      </div>
      <div className={`gmb-balance${breach ? " gmb-balance--breach" : ""}`}>
        Δ {cell.endBalanceTonnes >= 0 ? "+" : ""}
        {cell.endBalanceTonnes.toLocaleString()} t
      </div>
    </td>
  );
}

export default function GradeMassBalancePanel({
  rows,
  customers,
  customerOrderIndex,
  deficitMode,
  deficitLimitTonnes,
  deficitLimitPct
}: GradeMassBalancePanelProps) {
  const byGrade = useMemo(() => aggregateGradeMassBalanceByGrade(rows), [rows]);

  const quarters = useMemo(() => {
    const seen = new Map<string, Date>();
    for (const r of byGrade) {
      if (!seen.has(r.quarterLabel)) {
        seen.set(r.quarterLabel, r.periodStart);
      }
    }
    return [...seen.entries()]
      .sort((a, b) => a[1].getTime() - b[1].getTime())
      .map(([label]) => label);
  }, [byGrade]);

  const cellMap = useMemo(() => {
    const map = new Map<string, GradeMassBalanceByGradeRow>();
    for (const r of byGrade) {
      map.set(`${r.grade}|${r.quarterLabel}`, r);
    }
    return map;
  }, [byGrade]);

  const scale = maxCellScale(byGrade);

  const breachCount = useMemo(() => {
    let n = 0;
    for (const r of byGrade) {
      const limit =
        deficitMode === "percent"
          ? (r.inboundTonnes * deficitLimitPct) / 100
          : deficitLimitTonnes;
      if (r.endBalanceTonnes < -limit - 0.01) n++;
    }
    return n;
  }, [byGrade, deficitMode, deficitLimitTonnes, deficitLimitPct]);

  if (byGrade.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: "#94a3b8", textAlign: "center", padding: 24 }}>
        No graded flow activity in this simulation period.
      </p>
    );
  }

  return (
    <div className="gmb-panel">
      <p style={{ margin: "0 0 14px", fontSize: 13, color: "#64748b" }}>
        One certified credit ledger per grade (all customers combined). Customer colours show each
        customer&apos;s share inside the bars. Allowed quarter-end deficit:{" "}
        <strong>
          {deficitMode === "percent"
            ? `${deficitLimitPct}% of quarter inbound`
            : `−${deficitLimitTonnes.toLocaleString()} t`}
        </strong>
        . Breaches:{" "}
        <span className={`badge ${breachCount > 0 ? "badge-amber" : "badge-blue"}`}>{breachCount}</span>
      </p>

      <div className="gmb-matrix-scroll">
        <table className="gmb-matrix">
          <thead>
            <tr>
              <th className="gmb-matrix-grade-col">Grade</th>
              {quarters.map((q) => (
                <th key={q} className="gmb-matrix-quarter-col">
                  {q}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SUSTAINABILITY_GRADES.map((grade) => (
              <tr key={grade}>
                <th
                  className="gmb-matrix-grade-label"
                  style={{ color: GRADE_COLORS[grade], borderLeftColor: GRADE_COLORS[grade] }}
                >
                  {grade}
                </th>
                {quarters.map((quarterLabel) => (
                  <QuarterCell
                    key={`${grade}-${quarterLabel}`}
                    cell={cellMap.get(`${grade}|${quarterLabel}`)}
                    grade={grade}
                    scale={scale}
                    customers={customers}
                    customerOrderIndex={customerOrderIndex}
                    deficitMode={deficitMode}
                    deficitLimitTonnes={deficitLimitTonnes}
                    deficitLimitPct={deficitLimitPct}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="gmb-legend">
        <HelpPopover
          label="Grade mass balance matrix help"
          content="Rows are grades (top to bottom). Columns are calendar quarters left to right. Each cell compares inbound vs outbound tonnes for that grade; stacked bar segments use customer chart colours."
        />
        <span>Bar segments = customer contribution within that grade</span>
      </div>
    </div>
  );
}
