import { useEffect, useState } from "react";

import type { TransportPool } from "../../types";

import TransportPoolForm from "./TransportPoolForm";

import { HelpPopover } from "./HelpPopover";



export default function TransportPoolsPanel() {

  const [pools, setPools] = useState<TransportPool[]>([]);

  const [editing, setEditing] = useState<TransportPool | null>(null);

  const [adding, setAdding] = useState(false);



  const load = () => {

    window.dbAPI?.getTransportPools().then((rows) => setPools(rows as TransportPool[]));

  };



  useEffect(() => load(), []);



  const showForm = adding || editing;



  return (

    <div className="card" style={{ marginBottom: 24 }}>

      <div className="card-title-row">

        <div className="card-title" style={{ margin: 0 }}>

          Transport clubs

        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>

          <HelpPopover

            label="Transport clubs help"

            content="Name a club here. Customers join on the customer tab: assign a club to a ship/barge/train leg, or add a Pool leg for inventory-only membership (no berth booking). Berth inventory on pooled loads splits by live inventory share among club members on that direction."

          />

          <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setAdding(true)}>

            Add club

          </button>

        </div>

      </div>

      <table className="data-table">

        <thead>

          <tr>

            <th>Name</th>

            <th>Actions</th>

          </tr>

        </thead>

        <tbody>

          {pools.length === 0 ? (

            <tr>

              <td colSpan={2} style={{ textAlign: "center", color: "#94a3b8", padding: 16 }}>

                No transport clubs — add one to let customers share berth inventory

              </td>

            </tr>

          ) : (

            pools.map((p) => (

              <tr key={p.id}>

                <td>{p.name}</td>

                <td>

                  <button

                    className="btn btn-secondary"

                    style={{ padding: "6px 12px", fontSize: 13 }}

                    onClick={() => setEditing(p)}

                  >

                    Edit

                  </button>

                  <button

                    className="btn btn-danger"

                    style={{ padding: "6px 12px", fontSize: 13, marginLeft: 8 }}

                    onClick={() => {

                      if (!window.dbAPI) return;

                      void window.dbAPI.deleteTransportPool(p.id).then(load);

                    }}

                  >

                    Delete

                  </button>

                </td>

              </tr>

            ))

          )}

        </tbody>

      </table>



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

          <div className="card" style={{ maxWidth: 440, width: "100%" }} onClick={(e) => e.stopPropagation()}>

            <TransportPoolForm

              pool={editing ?? undefined}

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

