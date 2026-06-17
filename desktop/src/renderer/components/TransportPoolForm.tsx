import { useState } from "react";

import type { TransportPool } from "../../types";



interface TransportPoolFormProps {

  pool?: TransportPool | null;

  onSaved?: () => void;

  onCancel?: () => void;

}



export default function TransportPoolForm({ pool, onSaved, onCancel }: TransportPoolFormProps) {

  const [name, setName] = useState(pool?.name ?? "");

  const [error, setError] = useState<string | null>(null);



  const handleSubmit = async (e: React.FormEvent) => {

    e.preventDefault();

    setError(null);

    if (!name.trim()) {

      setError("Name is required.");

      return;

    }

    const payload: TransportPool = {

      id: pool?.id ?? crypto.randomUUID(),

      name: name.trim()

    };

    try {

      if (pool) {

        await window.dbAPI?.updateTransportPool(payload);

      } else {

        await window.dbAPI?.createTransportPool(payload);

      }

      onSaved?.();

    } catch (err) {

      setError(String(err));

    }

  };



  return (

    <form onSubmit={handleSubmit}>

      <div className="card-title" style={{ marginBottom: 16 }}>

        {pool ? "Edit transport club" : "Add transport club"}

      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="form-group">

        <label className="form-label">Club name</label>

        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} required />

      </div>

      <p className="form-helper" style={{ marginTop: 8 }}>

        Customers join a club on a transport leg (ship/barge/train) or with pool-only membership. Physical

        settings — mode, MEPS, roundtrip — stay on each customer&apos;s scheduling leg.

      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>

        <button type="submit" className="btn btn-primary">

          Save

        </button>

        <button type="button" className="btn btn-secondary" onClick={onCancel}>

          Cancel

        </button>

      </div>

    </form>

  );

}

