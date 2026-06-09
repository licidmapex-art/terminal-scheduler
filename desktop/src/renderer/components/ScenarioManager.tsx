import { useState, useEffect, useCallback } from "react";
import { setLastSchedulerRun } from "../store";
import { HelpPopover } from "./HelpPopover";

interface ScenarioRow {
  id: string;
  name: string;
  created_at: string;
}

interface ScenarioManagerProps {
  onScenarioLoaded?: () => void;
}

export default function ScenarioManager({ onScenarioLoaded }: ScenarioManagerProps) {
  const [rows, setRows] = useState<ScenarioRow[]>([]);
  const [saveName, setSaveName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [overwrittenId, setOverwrittenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const refresh = useCallback(async () => {
    if (!window.scenarioAPI) return;
    const list = await window.scenarioAPI.list();
    setRows(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => {
    refresh().catch(() => setRows([]));
  }, [refresh]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!window.scenarioAPI) return;
    const name = saveName.trim();
    if (!name) {
      setError("Enter a scenario name");
      return;
    }
    setBusy(true);
    try {
      await window.scenarioAPI.save(name);
      setSaveName("");
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLoad = async (id: string) => {
    if (!window.scenarioAPI) return;
    setError(null);
    setBusy(true);
    try {
      await window.scenarioAPI.load(id);
      setLastSchedulerRun();
      onScenarioLoaded?.();
      setLoaded(true);
      setTimeout(() => setLoaded(false), 2500);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOverwrite = async (id: string, label: string) => {
    if (!window.scenarioAPI?.overwrite) return;
    if (!confirm(`Overwrite "${label}" with the current setup?`)) return;
    setError(null);
    setBusy(true);
    try {
      await window.scenarioAPI.overwrite(id);
      setOverwrittenId(id);
      setTimeout(() => setOverwrittenId(null), 2500);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string, label: string) => {
    if (!window.scenarioAPI) return;
    if (!confirm(`Delete scenario "${label}"? This cannot be undone.`)) return;
    setError(null);
    setBusy(true);
    try {
      await window.scenarioAPI.delete(id);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const startRename = (r: ScenarioRow) => {
    setEditingId(r.id);
    setEditName(r.name);
  };

  const commitRename = async (id: string) => {
    if (!window.scenarioAPI) return;
    const name = editName.trim();
    if (!name) {
      setError("Name cannot be empty");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await window.scenarioAPI.rename(id, name);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card config-section" style={{ marginBottom: 24 }}>
      <div className="config-section-header">
        <span className="config-section-num">0</span>
        <div>
          <div className="config-section-title-row">
            <div className="config-section-title">Scenarios</div>
            <HelpPopover
              label="Scenarios help"
              content={
                <>
                  Save a snapshot of customers, resources, and terminal configuration. Loading replaces all of those
                  in the database (scheduled slots and run results are cleared); run the scheduler again after loading.
                </>
              }
            />
          </div>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <form onSubmit={handleSave} style={{ marginBottom: 20, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <div className="form-group" style={{ marginBottom: 0, flex: "1 1 200px", minWidth: 160 }}>
          <label className="form-label">New scenario name</label>
          <input
            type="text"
            className="form-input"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="e.g. Base case Q1"
            disabled={busy}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save current setup
        </button>
        {loaded && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#15803d",
              fontSize: 14,
              fontWeight: 500
            }}
          >
            <span style={{ fontSize: 18 }}>✓</span> Loaded
          </span>
        )}
      </form>

      <div className="card-title" style={{ marginBottom: 12, fontSize: 14 }}>
        Saved scenarios ({rows.length})
      </div>
      {rows.length === 0 ? (
        <p style={{ color: "#94a3b8", fontSize: 14 }}>No scenarios saved yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Saved</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {editingId === r.id ? (
                    <input
                      type="text"
                      className="form-input"
                      style={{ maxWidth: 280 }}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => commitRename(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(r.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRename(r)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        font: "inherit",
                        color: "#1d4ed8",
                        textAlign: "left"
                      }}
                      title="Click to rename"
                    >
                      {r.name}
                    </button>
                  )}
                </td>
                <td style={{ fontSize: 13, color: "#64748b" }}>
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ padding: "6px 12px", fontSize: 13 }}
                    disabled={busy}
                    onClick={() => handleOverwrite(r.id, r.name)}
                    title="Replace this scenario with the current customers, resources, and terminal config"
                  >
                    {overwrittenId === r.id ? "Saved ✓" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: "6px 12px", fontSize: 13, marginLeft: 8 }}
                    disabled={busy}
                    onClick={() => handleLoad(r.id)}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    style={{ padding: "6px 12px", fontSize: 13, marginLeft: 8 }}
                    disabled={busy}
                    onClick={() => handleDelete(r.id, r.name)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
