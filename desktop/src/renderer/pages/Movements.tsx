import { useState, useEffect, useMemo } from "react";
import { useStore } from "../store";
import MovementsTable from "../components/MovementsTable";

interface Slot {
  id: string;
  customerId: string;
  resourceId: string;
  direction: string;
  mode: string;
  volume: number;
  start: string;
}

interface Resource {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  name: string;
}

export default function Movements() {
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [s, r, c] = await Promise.all([
        window.schedulerAPI.getSlots(),
        window.dbAPI.getResources(),
        window.dbAPI.getCustomers()
      ]);
      setSlots((s as Slot[]) ?? []);
      setResources((r as Resource[]) ?? []);
      setCustomers((c as Customer[]) ?? []);
    }
    load();
  }, [lastSchedulerRun]);

  const customerById = useMemo(() => new Map(customers.map((cust) => [cust.id, cust.name])), [customers]);
  const resourceById = useMemo(() => new Map(resources.map((res) => [res.id, res.name])), [resources]);

  const orderedSlots = useMemo(
    () => [...slots].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [slots]
  );

  const totalVolume = useMemo(() => slots.reduce((sum, sl) => sum + (sl.volume ?? 0), 0), [slots]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Movements</h1>
          <p className="page-subtitle">
            All scheduled berth movements for the simulation period
            {slots.length > 0 && (
              <>
                {" "}
                · {slots.length} slot{slots.length === 1 ? "" : "s"} · {Math.round(totalVolume).toLocaleString()} t
              </>
            )}
          </p>
        </div>
      </div>

      <div className="card">
        <MovementsTable
          slots={orderedSlots}
          customerNameById={customerById}
          resourceNameById={resourceById}
        />
      </div>
    </div>
  );
}
