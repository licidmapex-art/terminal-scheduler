import { useState, useEffect } from "react";
import ResourceForm from "../components/ResourceForm";
import TankFarmPanel from "../components/TankFarmPanel";
interface Resource {
  id: string;
  name: string;
  type: string;
  flowRate: number;
  blackouts: unknown[];
}

const TYPE_BADGE: Record<string, string> = {
  berth_large: "badge-blue",
  berth_small: "badge-green",
  rail_siding: "badge-amber"
};

export default function Resources() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => {
    if (window.dbAPI) {
      window.dbAPI.getResources().then((r: unknown[]) => {
        const res = (r as Array<{ id: string; name: string; type: string; flowRate: number; blackouts: unknown[] }>).map((x) => ({
          ...x,
          blackouts: x.blackouts ?? []
        }));
        setResources(res);
      });
    }
  };

  useEffect(() => load(), []);

  const showForm = adding || editing;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Resources</h1>
          <p className="page-subtitle">Manage berths, rail sidings, flow rates, and simulation tank layout</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          Add Resource
        </button>
      </div>

      <TankFarmPanel />

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Flow Rate (t/h)</th>
              <th>Blackouts</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {resources.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <span className={`badge ${TYPE_BADGE[r.type] ?? "badge-gray"}`}>
                    {r.type.replace("_", " ")}
                  </span>
                </td>
                <td>{r.flowRate}</td>
                <td>{Array.isArray(r.blackouts) ? r.blackouts.length : 0}</td>
                <td>
                  <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-danger"
                    style={{ padding: "6px 12px", fontSize: 13, marginLeft: 8 }}
                    onClick={() => {
                      if (!window.dbAPI) return;
                      void window.dbAPI
                        .deleteResource(r.id)
                        .then(() => load())
                        .catch((e) => console.error("deleteResource", e));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 24
          }}
          onClick={(e) => e.target === e.currentTarget && (setAdding(false), setEditing(null))}
        >
          <div
            className="card"
            style={{ maxWidth: 400, width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <ResourceForm
              resource={editing ?? undefined}
              onSaved={() => {
                setAdding(false);
                setEditing(null);
                load();
              }}
              onCancel={() => {
                setAdding(false);
                setEditing(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
