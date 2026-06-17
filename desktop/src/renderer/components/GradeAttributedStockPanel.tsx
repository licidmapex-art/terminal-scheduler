import { useMemo } from "react";
import { HelpPopover } from "./HelpPopover";
import {
  GRADE_COLORS,
  SUSTAINABILITY_GRADES,
  type SustainabilityGrade
} from "../../engine/gradeMassBalance";
import type {
  GradeStockSummaryRow,
  QuarterlyGradeStockRow
} from "../../engine/gradeInventoryLedger";
import { resolveCustomerChartColor } from "../lib/customerChartColor";

interface CustomerColorRef {
  id: string;
  name: string;
  chartColor?: string | null;
}

interface GradeAttributedStockPanelProps {
  summaryRows: GradeStockSummaryRow[];
  quarterlyStock: QuarterlyGradeStockRow[];
  customers: CustomerColorRef[];
  customerOrderIndex: Map<string, number>;
  globalDeficitLimitTonnes: number;
}

function gradeLabel(g: SustainabilityGrade): string {
  return g.charAt(0).toUpperCase() + g.slice(1);
}

function formatTonnes(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function GradeAttributedStockPanel({
  summaryRows,
  quarterlyStock,
  customers,
  customerOrderIndex,
  globalDeficitLimitTonnes
}: GradeAttributedStockPanelProps) {
  const customerIds = useMemo(() => {
    const ids = [...new Set(summaryRows.map((r) => r.customerId))];
    ids.sort(
      (a, b) => (customerOrderIndex.get(a) ?? 0) - (customerOrderIndex.get(b) ?? 0)
    );
    return ids;
  }, [summaryRows, customerOrderIndex]);

  const quarters = useMemo(() => {
    const labels: string[] = [];
    for (const r of quarterlyStock) {
      if (!labels.includes(r.quarterLabel)) labels.push(r.quarterLabel);
    }
    return labels;
  }, [quarterlyStock]);

  const quarterlyByGradeQuarter = useMemo(() => {
    const map = new Map<string, QuarterlyGradeStockRow>();
    for (const r of quarterlyStock) {
      map.set(`${r.grade}|${r.quarterLabel}`, r);
    }
    return map;
  }, [quarterlyStock]);

  if (summaryRows.length === 0) {
    return (
      <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>
        No attributed grade stock data — run the scheduler in Shared storage mode with customers that have a grade mix.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <div className="section-heading-row" style={{ marginBottom: 8 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>Per-customer attributed stock</h3>
          <HelpPopover
            label="Attributed grade stock help"
            content={
              <>
                Hourly ledger from the scheduler: opening stock split by each customer&apos;s grade mix, then
                pipeline and berth flows attributed proportionally. Floor is the per-grade −x limit (global x
                apportioned unless overridden). Min headroom is how far above the floor the minimum hourly
                balance stayed.
              </>
            }
          />
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Grade</th>
              <th style={{ textAlign: "right" }}>Opening (t)</th>
              <th style={{ textAlign: "right" }}>Min (t)</th>
              <th style={{ textAlign: "right" }}>Final (t)</th>
              <th style={{ textAlign: "right" }}>Floor −x (t)</th>
              <th style={{ textAlign: "right" }}>Min headroom</th>
            </tr>
          </thead>
          <tbody>
            {customerIds.flatMap((customerId) => {
              const customerRows = SUSTAINABILITY_GRADES.map((grade) =>
                summaryRows.find((r) => r.customerId === customerId && r.grade === grade)
              ).filter((r): r is GradeStockSummaryRow => !!r && (r.opening > 0 || r.final > 0 || r.min !== r.opening));
              if (customerRows.length === 0) return [];
              return customerRows.map((row, idx) => {
                const breached = row.minHeadroom < 0;
                return (
                  <tr key={`${row.customerId}-${row.grade}`}>
                    <td>{idx === 0 ? row.customerName : ""}</td>
                    <td>
                      <span
                        style={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: GRADE_COLORS[row.grade],
                          marginRight: 6,
                          verticalAlign: "middle"
                        }}
                      />
                      {gradeLabel(row.grade)}
                    </td>
                    <td style={{ textAlign: "right" }}>{formatTonnes(row.opening)}</td>
                    <td style={{ textAlign: "right" }}>{formatTonnes(row.min)}</td>
                    <td style={{ textAlign: "right" }}>{formatTonnes(row.final)}</td>
                    <td style={{ textAlign: "right" }}>
                      {row.floorLimit > 0 ? formatTonnes(row.floorLimit) : globalDeficitLimitTonnes > 0 ? "—" : "0"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className={breached ? "badge badge-amber" : undefined}>
                        {formatTonnes(row.minHeadroom)}
                      </span>
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>

      {quarters.length > 0 && (
        <div>
          <div className="section-heading-row" style={{ marginBottom: 8 }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Terminal attributed stock at quarter end</h3>
            <HelpPopover
              label="Quarter-end grade stock help"
              content="Sum of per-customer attributed balances by grade at the last simulation hour inside each calendar quarter."
            />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Grade</th>
                {quarters.map((q) => (
                  <th key={q} style={{ textAlign: "right" }}>
                    {q}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUSTAINABILITY_GRADES.map((grade) => (
                <tr key={grade}>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: GRADE_COLORS[grade],
                        marginRight: 6,
                        verticalAlign: "middle"
                      }}
                    />
                    {gradeLabel(grade)}
                  </td>
                  {quarters.map((q) => {
                    const cell = quarterlyByGradeQuarter.get(`${grade}|${q}`);
                    const total = cell?.terminalStockTonnes ?? 0;
                    const parts = cell?.customerStocks ?? [];
                    return (
                      <td key={q} style={{ textAlign: "right", verticalAlign: "top" }}>
                        <div>{formatTonnes(total)}</div>
                        {parts.length > 1 && (
                          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                            {parts
                              .sort(
                                (a, b) =>
                                  (customerOrderIndex.get(a.customerId) ?? 0) -
                                  (customerOrderIndex.get(b.customerId) ?? 0)
                              )
                              .map((p) => (
                                <div key={p.customerId}>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      width: 6,
                                      height: 6,
                                      borderRadius: 2,
                                      background: resolveCustomerChartColor(
                                        customers.find((c) => c.id === p.customerId)?.chartColor,
                                        customerOrderIndex.get(p.customerId) ?? 0
                                      ),
                                      marginRight: 4
                                    }}
                                  />
                                  {p.customerName}: {formatTonnes(p.tonnes)}
                                </div>
                              ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
