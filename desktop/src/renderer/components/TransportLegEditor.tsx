import { useMemo, useState } from "react";
import { legLabelsForTransports } from "../../engine/transportLegLabels";
import { isPoolOnlyTransportRow, isSchedulableTransportRow } from "../../engine/customerTransports";
import {
  adjustTransportShares,
  sharesAfterRemove
} from "../../engine/transportShareAdjust";
import type { CustomerTransportConfig, TransportPool } from "../../types";
import { HelpPopover } from "./HelpPopover";

export type TransportMode = CustomerTransportConfig["mode"];
export type TransportLegRow = CustomerTransportConfig;

const MAX_LEGS = 12;

interface TransportLegEditorProps {
  direction: "inbound" | "outbound";
  rows: TransportLegRow[];
  onRowsChange: (rows: TransportLegRow[]) => void;
  shareColumnLabel?: string;
  showReservationWindow?: boolean;
  reservationModeLabel?: string;
  transportPools?: TransportPool[];
}

export default function TransportLegEditor({
  direction,
  rows,
  onRowsChange,
  shareColumnLabel,
  showReservationWindow = false,
  reservationModeLabel = "Window",
  transportPools = []
}: TransportLegEditorProps) {
  const [draftMode, setDraftMode] = useState<TransportMode>("ship");
  const [draftMeps, setDraftMeps] = useState("");
  const [draftRoundtrip, setDraftRoundtrip] = useState("");
  const [draftPoolId, setDraftPoolId] = useState<string>("");

  const labels = useMemo(() => legLabelsForTransports(rows), [rows]);
  const schedulableRows = useMemo(() => rows.filter(isSchedulableTransportRow), [rows]);
  const shareSum = schedulableRows.reduce((s, r) => s + r.sharePct, 0);
  const shareOk = schedulableRows.length === 0 || Math.abs(shareSum - 100) <= 0.05;

  const updateRow = (idx: number, patch: Partial<TransportLegRow>) => {
    onRowsChange(
      rows.map((r, i) => {
        if (i !== idx) return r;
        const merged = { ...r, ...patch };
        if (patch.mode === "pool") {
          return {
            mode: "pool" as const,
            sharePct: 0,
            shareFixed: true,
            meps: 0,
            roundtripHours: 0,
            reservationWindowHours: 0,
            poolId: patch.poolId ?? merged.poolId ?? null
          };
        }
        if (merged.mode === "pool") {
          return merged;
        }
        return merged;
      })
    );
  };

  const updateShare = (idx: number, raw: string) => {
    if (isPoolOnlyTransportRow(rows[idx]!)) return;
    const val = parseFloat(raw);
    if (!Number.isFinite(val)) return;
    const schedulable = rows.filter(isSchedulableTransportRow);
    const schedIdx = schedulable.findIndex((r) => r === rows[idx]);
    if (schedIdx < 0) return;
    const adjusted = adjustTransportShares(schedulable, schedIdx, val);
    let j = 0;
    onRowsChange(
      rows.map((r) => {
        if (!isSchedulableTransportRow(r)) return r;
        const next = { ...r, sharePct: adjusted[j]?.sharePct ?? r.sharePct };
        j += 1;
        return next;
      })
    );
  };

  const toggleFixed = (idx: number) => {
    if (isPoolOnlyTransportRow(rows[idx]!)) return;
    updateRow(idx, { shareFixed: !rows[idx]!.shareFixed });
  };

  const removeRow = (idx: number) => {
    const remaining = rows.filter((_, i) => i !== idx);
    const schedulable = rows.filter(isSchedulableTransportRow);
    const schedIdx = schedulable.findIndex((r) => r === rows[idx]);
    const adjusted =
      schedIdx >= 0 ? sharesAfterRemove(schedulable, schedIdx) : schedulable.map((r) => ({ sharePct: r.sharePct }));
    let j = 0;
    onRowsChange(
      remaining.map((r) => {
        if (!isSchedulableTransportRow(r)) return r;
        const next = { ...r, sharePct: adjusted[j]?.sharePct ?? r.sharePct };
        j += 1;
        return next;
      })
    );
  };

  const addLeg = () => {
    if (rows.length >= MAX_LEGS) return;

    if (draftMode === "pool") {
      if (!draftPoolId) return;
      onRowsChange([
        ...rows,
        {
          mode: "pool",
          sharePct: 0,
          shareFixed: true,
          meps: 0,
          roundtripHours: 0,
          poolId: draftPoolId
        }
      ]);
      setDraftPoolId("");
      return;
    }

    const meps = parseFloat(draftMeps);
    const roundtripHours = parseFloat(draftRoundtrip || "0");
    if (!Number.isFinite(meps) || meps <= 0) return;

    const newRow: TransportLegRow = {
      mode: draftMode,
      sharePct: schedulableRows.length === 0 ? 100 : 0,
      shareFixed: false,
      meps,
      roundtripHours: Number.isFinite(roundtripHours) ? Math.max(0, roundtripHours) : 0,
      poolId: draftPoolId || null
    };

    let next = [...rows, newRow];
    if (schedulableRows.length > 0 && newRow.sharePct === 0) {
      const schedulable = next.filter(isSchedulableTransportRow);
      const movableIdx = schedulable.findIndex((r, i) => i < schedulable.length - 1 && !r.shareFixed);
      if (movableIdx >= 0 && schedulable[movableIdx]!.sharePct > 0) {
        const steal = Math.min(10, schedulable[movableIdx]!.sharePct);
        let seenNew = false;
        next = next.map((r) => {
          if (!isSchedulableTransportRow(r)) return r;
          const si = schedulable.indexOf(r);
          if (si === movableIdx) return { ...r, sharePct: r.sharePct - steal };
          if (r === newRow && !seenNew) {
            seenNew = true;
            return { ...r, sharePct: steal };
          }
          return r;
        });
      }
    }

    onRowsChange(next);
    setDraftMeps("");
    setDraftRoundtrip("");
    setDraftPoolId("");
  };

  const canAddPool = draftMode === "pool" && !!draftPoolId && rows.length < MAX_LEGS;
  const canAddSchedulable =
    draftMode !== "pool" &&
    rows.length < MAX_LEGS &&
    Number.isFinite(parseFloat(draftMeps)) &&
    parseFloat(draftMeps) > 0;

  return (
    <div className="transport-leg-editor">
      <div className="transport-leg-add card-inset">
        <div className="transport-leg-add-title">Add transport leg</div>
        <div className="form-grid transport-leg-add-grid">
          <div className="form-group">
            <label className="form-label">Mode</label>
            <select
              className="form-select"
              value={draftMode}
              onChange={(e) => {
                const m = e.target.value as TransportMode;
                setDraftMode(m);
                if (m === "pool") {
                  setDraftMeps("");
                  setDraftRoundtrip("");
                }
              }}
            >
              <option value="ship">Ship</option>
              <option value="barge">Barge</option>
              <option value="train">Train</option>
              <option value="pool">Pool (inventory only)</option>
            </select>
          </div>
          {draftMode === "pool" ? (
            <div className="form-group">
              <label className="form-label">Club</label>
              <select
                className="form-select"
                value={draftPoolId}
                onChange={(e) => setDraftPoolId(e.target.value)}
              >
                <option value="">— Select club —</option>
                {transportPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label">MEPS (t)</label>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  className="form-input"
                  value={draftMeps}
                  onChange={(e) => setDraftMeps(e.target.value)}
                  placeholder="Cargo size"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Roundtrip (h)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="form-input"
                  value={draftRoundtrip}
                  onChange={(e) => setDraftRoundtrip(e.target.value)}
                  placeholder="0 = even spacing"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Club (optional)</label>
                <select
                  className="form-select"
                  value={draftPoolId}
                  onChange={(e) => setDraftPoolId(e.target.value)}
                >
                  <option value="">— Private —</option>
                  {transportPools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="form-group transport-leg-add-action">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!(canAddPool || canAddSchedulable)}
              onClick={addLeg}
            >
              + Add leg
            </button>
          </div>
        </div>
        <p className="form-helper" style={{ margin: "8px 0 0" }}>
          {draftMode === "pool"
            ? "Pool legs share berth inventory with other club members but do not book berths."
            : "Same mode can appear more than once. Optional club shares inventory on that leg's loads."}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="form-helper transport-leg-empty">
          No {direction} transport legs. Inventory moves by pipeline only unless legs are added above.
        </p>
      ) : (
        <>
          <div className="table-wrap transport-leg-table-wrap">
            <table className="table transport-leg-table">
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Mode</th>
                  <th>Club</th>
                  <th>MEPS (t)</th>
                  <th>Roundtrip (h)</th>
                  {showReservationWindow && <th>{reservationModeLabel} (h)</th>}
                  <th>
                    <span className="transport-leg-th-share">
                      {shareColumnLabel ?? "Share (%)"}
                      <HelpPopover
                        label="Share help"
                        content="Share % applies to scheduling legs only (ship/barge/train). Pool legs are inventory-only and excluded from the share total."
                      />
                    </span>
                  </th>
                  <th>Fixed</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const poolOnly = isPoolOnlyTransportRow(row);
                  return (
                    <tr key={`${direction}-leg-${idx}`}>
                      <td className="transport-leg-label">{labels[idx]}</td>
                      <td>
                        {poolOnly ? (
                          <span className="badge badge-gray">Pool</span>
                        ) : (
                          <select
                            className="form-select form-select-compact"
                            value={row.mode}
                            onChange={(e) =>
                              updateRow(idx, {
                                mode: e.target.value as TransportMode,
                                poolId: null
                              })
                            }
                          >
                            <option value="ship">Ship</option>
                            <option value="barge">Barge</option>
                            <option value="train">Train</option>
                          </select>
                        )}
                      </td>
                      <td>
                        <select
                          className="form-select form-select-compact"
                          value={row.poolId ?? ""}
                          onChange={(e) =>
                            updateRow(idx, { poolId: e.target.value || null })
                          }
                        >
                          <option value="">{poolOnly ? "— Select club —" : "—"}</option>
                          {transportPools.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {poolOnly ? (
                          <span className="form-helper">—</span>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            className="form-input form-input-compact"
                            value={row.meps}
                            onChange={(e) =>
                              updateRow(idx, { meps: parseFloat(e.target.value || "0") })
                            }
                          />
                        )}
                      </td>
                      <td>
                        {poolOnly ? (
                          <span className="form-helper">—</span>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            step={1}
                            className="form-input form-input-compact"
                            value={row.roundtripHours}
                            onChange={(e) =>
                              updateRow(idx, {
                                roundtripHours: parseFloat(e.target.value || "0")
                              })
                            }
                          />
                        )}
                      </td>
                      {showReservationWindow && (
                        <td>
                          {poolOnly ? (
                            <span className="form-helper">—</span>
                          ) : (
                            <input
                              type="number"
                              min={0}
                              step={1}
                              className="form-input form-input-compact"
                              value={row.reservationWindowHours ?? 0}
                              onChange={(e) =>
                                updateRow(idx, {
                                  reservationWindowHours: parseFloat(e.target.value || "0")
                                })
                              }
                            />
                          )}
                        </td>
                      )}
                      <td>
                        {poolOnly ? (
                          <span className="form-helper">—</span>
                        ) : (
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            className="form-input form-input-compact transport-leg-share-input"
                            value={Number(row.sharePct.toFixed(1))}
                            onChange={(e) => updateShare(idx, e.target.value)}
                          />
                        )}
                      </td>
                      <td>
                        {poolOnly ? (
                          <span className="form-helper">—</span>
                        ) : (
                          <button
                            type="button"
                            className={`btn btn-sm transport-leg-fixed-btn${row.shareFixed ? " transport-leg-fixed-btn--on" : ""}`}
                            onClick={() => toggleFixed(idx)}
                            title={
                              row.shareFixed
                                ? "Share is fixed"
                                : "Share adjusts with other unlocked legs"
                            }
                          >
                            {row.shareFixed ? "Fixed" : "Float"}
                          </button>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => removeRow(idx)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p
            className={`transport-leg-share-sum${shareOk ? "" : " transport-leg-share-sum--bad"}`}
          >
            {schedulableRows.length > 0 ? (
              <>
                Scheduling share total: {shareSum.toFixed(1)}%
                {!shareOk && " — must equal 100%"}
              </>
            ) : (
              "No scheduling legs — pool-only or pipeline only."
            )}
          </p>
        </>
      )}
    </div>
  );
}
