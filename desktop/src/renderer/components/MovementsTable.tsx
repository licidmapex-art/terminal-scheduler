import { CalendarDays } from "lucide-react";

export interface MovementSlot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
}

interface MovementsTableProps {
  slots: MovementSlot[];
  customerNameById: Map<string, string>;
  resourceNameById: Map<string, string>;
  /** When set and greater than zero while `slots` is empty, show a filter-empty message. */
  unfilteredCount?: number;
}

export default function MovementsTable({
  slots,
  customerNameById,
  resourceNameById,
  unfilteredCount = 0
}: MovementsTableProps) {
  if (slots.length === 0) {
    const filteredEmpty = unfilteredCount > 0;
    return (
      <div className="empty-state" style={{ padding: 40 }}>
        <div className="empty-state-icon">
          <CalendarDays size={48} strokeWidth={1.5} />
        </div>
        <div className="empty-state-title">
          {filteredEmpty ? "No movements match filters" : "No movements yet"}
        </div>
        <div className="empty-state-text">
          {filteredEmpty
            ? "Turn on at least one customer, move type, and resource to see rows."
            : "Run the scheduler on the Schedule page after setting customers, resources, and terminal dates."}
        </div>
      </div>
    );
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Customer</th>
          <th>Move</th>
          <th style={{ textAlign: "right" }}>t</th>
          <th>Resource</th>
          <th>Start</th>
        </tr>
      </thead>
      <tbody>
        {slots.map((sl) => (
          <tr key={sl.id}>
            <td>{customerNameById.get(sl.customerId) ?? sl.customerId}</td>
            <td>
              <span className={`badge ${sl.direction === "outbound" ? "badge-amber" : "badge-blue"}`}>
                {sl.direction} · {sl.mode}
              </span>
            </td>
            <td style={{ textAlign: "right" }}>{sl.volume.toLocaleString()}</td>
            <td>{resourceNameById.get(sl.resourceId) ?? sl.resourceId}</td>
            <td style={{ fontSize: 13, color: "#64748b" }}>
              {new Date(sl.start).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
