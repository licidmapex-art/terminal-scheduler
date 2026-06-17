import { useEffect, useState } from "react";

export interface SlotEditorDraft {
  id?: string;
  customerId: string;
  resourceId: string;
  direction: "inbound" | "outbound";
  mode: "ship" | "barge" | "train";
  volume: number;
  startMs: number;
  endMs: number;
}

interface CustomerOption {
  id: string;
  name: string;
}

interface SlotEditorModalProps {
  open: boolean;
  title: string;
  draft: SlotEditorDraft;
  customers: CustomerOption[];
  onClose: () => void;
  onSave: (draft: SlotEditorDraft) => void;
}

function formatLocalDatetime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalDatetime(s: string): number | null {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

export default function SlotEditorModal({
  open,
  title,
  draft,
  customers,
  onClose,
  onSave
}: SlotEditorModalProps) {
  const [form, setForm] = useState(draft);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(draft);
      setError(null);
    }
  }, [open, draft]);

  if (!open) return null;

  const startLocal = formatLocalDatetime(form.startMs);
  const endLocal = formatLocalDatetime(form.endMs);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const startMs = parseLocalDatetime(startLocal);
    const endMs = parseLocalDatetime(endLocal);
    if (startMs == null || endMs == null) {
      setError("Invalid start or end time");
      return;
    }
    if (endMs <= startMs) {
      setError("End must be after start");
      return;
    }
    if (form.volume <= 0) {
      setError("Volume must be positive");
      return;
    }
    onSave({ ...form, startMs, endMs });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000
      }}
      onMouseDown={onClose}
    >
      <div
        className="card"
        style={{ width: "min(420px, 92vw)", padding: 20, margin: 16 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>{title}</h3>
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Customer</label>
            <select
              className="form-select"
              value={form.customerId}
              onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Direction</label>
              <select
                className="form-select"
                value={form.direction}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    direction: e.target.value as "inbound" | "outbound"
                  }))
                }
              >
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Mode</label>
              <select
                className="form-select"
                value={form.mode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, mode: e.target.value as "ship" | "barge" | "train" }))
                }
              >
                <option value="ship">Ship</option>
                <option value="barge">Barge</option>
                <option value="train">Train</option>
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Volume (t)</label>
            <input
              className="form-input"
              type="number"
              min={1}
              step={1}
              value={form.volume}
              onChange={(e) => setForm((f) => ({ ...f, volume: Number(e.target.value) }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Operation start</label>
            <input
              className="form-input"
              type="datetime-local"
              value={startLocal}
              onChange={(e) => {
                const ms = parseLocalDatetime(e.target.value);
                if (ms != null) setForm((f) => ({ ...f, startMs: ms }));
              }}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Operation end</label>
            <input
              className="form-input"
              type="datetime-local"
              value={endLocal}
              onChange={(e) => {
                const ms = parseLocalDatetime(e.target.value);
                if (ms != null) setForm((f) => ({ ...f, endMs: ms }));
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Save slot
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
