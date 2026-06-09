import { useState } from "react";
import { FormLabelWithHelp } from "./HelpPopover";

type ResourceType = "berth_large" | "berth_small" | "rail_siding";

interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  flowRate: number;
  blackouts: unknown[];
}

interface ResourceFormProps {
  resource?: Resource | null;
  onSaved?: () => void;
  onCancel?: () => void;
}

export default function ResourceForm({ resource, onSaved, onCancel }: ResourceFormProps) {
  const [name, setName] = useState(resource?.name ?? "");
  const [type, setType] = useState<ResourceType>(resource?.type ?? "berth_large");
  const [flowRate, setFlowRate] = useState(String(resource?.flowRate ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const rate = parseFloat(flowRate);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Name is required";
    if (isNaN(rate) || rate <= 0) next.flowRate = "Enter a positive flow rate (t/h)";
    if (Object.keys(next).length > 0) {
      setFieldErrors(next);
      setError("Correct the highlighted fields.");
      return;
    }
    setFieldErrors({});
    try {
      const r = {
        id: resource?.id ?? crypto.randomUUID(),
        name: name.trim(),
        type,
        flowRate: rate,
        blackouts: resource?.blackouts ?? []
      };
      if (resource) {
        await window.dbAPI.updateResource(r);
      } else {
        await window.dbAPI.createResource(r);
      }
      onSaved?.();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="card-title" style={{ marginBottom: 16 }}>{resource ? "Edit Resource" : "Add Resource"}</div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="form-group">
        <label className="form-label">Name</label>
        <input
          type="text"
          className={`form-input${fieldErrors.name ? " form-input-invalid" : ""}`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (fieldErrors.name) setFieldErrors((p) => ({ ...p, name: "" }));
          }}
          required
          aria-invalid={!!fieldErrors.name}
        />
        {fieldErrors.name && <div className="form-error">{fieldErrors.name}</div>}
      </div>
      <div className="form-group">
        <FormLabelWithHelp help="Used with vessel mode to pick compatible berths for each movement.">
          Type
        </FormLabelWithHelp>
        <select
          className="form-select"
          value={type}
          onChange={(e) => setType(e.target.value as ResourceType)}
        >
          <option value="berth_large">Berth (large)</option>
          <option value="berth_small">Berth (small)</option>
          <option value="rail_siding">Rail siding</option>
        </select>
      </div>
      <div className="form-group">
        <FormLabelWithHelp help="Transfer rate while alongside — drives slot duration (volume ÷ flow).">
          Flow rate (t/h)
        </FormLabelWithHelp>
        <input
          type="number"
          min="0.1"
          step="0.1"
          className={`form-input${fieldErrors.flowRate ? " form-input-invalid" : ""}`}
          value={flowRate}
          onChange={(e) => {
            setFlowRate(e.target.value);
            if (fieldErrors.flowRate) setFieldErrors((p) => ({ ...p, flowRate: "" }));
          }}
          required
          aria-invalid={!!fieldErrors.flowRate}
        />
        {fieldErrors.flowRate && <div className="form-error">{fieldErrors.flowRate}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button type="submit" className="btn btn-primary">Save</button>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
