import { useState, useEffect, useMemo, useCallback } from "react";
import { formatDirectionModeLabel } from "../../engine/pacing";
import { useStore } from "../store";
import MovementsTable from "../components/MovementsTable";
import { PageTitleWithHelp } from "../components/HelpPopover";

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

function slotMoveKey(slot: Pick<Slot, "direction" | "mode">): string {
  return `${slot.direction}:${slot.mode}`;
}

export default function Movements() {
  const lastSchedulerRun = useStore((s) => s.lastSchedulerRun);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [activeCustomers, setActiveCustomers] = useState<Set<string>>(() => new Set());
  const [activeMoves, setActiveMoves] = useState<Set<string>>(() => new Set());
  const [activeResources, setActiveResources] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    async function load() {
      if (!window.dbAPI || !window.schedulerAPI) return;
      const [s, r, c] = await Promise.all([
        window.schedulerAPI.getSlots(),
        window.dbAPI.getResources(),
        window.dbAPI.getCustomers()
      ]);
      const slotList = (s as Slot[]) ?? [];
      setSlots(slotList);
      setResources((r as Resource[]) ?? []);
      setCustomers((c as Customer[]) ?? []);
      if (slotList.length > 0) {
        setActiveCustomers(new Set(slotList.map((sl) => sl.customerId)));
        setActiveMoves(new Set(slotList.map(slotMoveKey)));
        setActiveResources(new Set(slotList.map((sl) => sl.resourceId)));
      } else {
        setActiveCustomers(new Set());
        setActiveMoves(new Set());
        setActiveResources(new Set());
      }
    }
    load();
  }, [lastSchedulerRun]);

  const customerById = useMemo(() => new Map(customers.map((cust) => [cust.id, cust.name])), [customers]);
  const resourceById = useMemo(() => new Map(resources.map((res) => [res.id, res.name])), [resources]);

  const orderedSlots = useMemo(
    () => [...slots].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
    [slots]
  );

  const availableMoves = useMemo(() => {
    const keys = new Set(orderedSlots.map(slotMoveKey));
    return [...keys].sort();
  }, [orderedSlots]);

  const availableResources = useMemo(() => {
    const ids = new Set(orderedSlots.map((sl) => sl.resourceId));
    return resources
      .filter((res) => ids.has(res.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orderedSlots, resources]);

  const filterCustomers = useMemo(() => {
    const ids = new Set(orderedSlots.map((sl) => sl.customerId));
    return customers
      .filter((cust) => ids.has(cust.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orderedSlots, customers]);

  const filteredSlots = useMemo(
    () =>
      orderedSlots.filter(
        (sl) =>
          activeCustomers.has(sl.customerId) &&
          activeMoves.has(slotMoveKey(sl)) &&
          activeResources.has(sl.resourceId)
      ),
    [orderedSlots, activeCustomers, activeMoves, activeResources]
  );

  const totalVolume = useMemo(() => slots.reduce((sum, sl) => sum + (sl.volume ?? 0), 0), [slots]);
  const filteredVolume = useMemo(
    () => filteredSlots.reduce((sum, sl) => sum + (sl.volume ?? 0), 0),
    [filteredSlots]
  );

  const toggleCustomer = useCallback((id: string) => {
    setActiveCustomers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleMove = useCallback((key: string) => {
    setActiveMoves((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleResource = useCallback((id: string) => {
    setActiveResources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtersActive =
    slots.length > 0 &&
    (filteredSlots.length !== slots.length ||
      activeCustomers.size < filterCustomers.length ||
      activeMoves.size < availableMoves.length ||
      activeResources.size < availableResources.length);

  return (
    <div>
      <div className="page-header">
        <div>
          <PageTitleWithHelp
            title="Movements"
            help="All scheduled berth movements for the simulation period"
          />
          {slots.length > 0 && (
            <p className="page-subtitle" style={{ marginTop: 4 }}>
              {filtersActive ? `${filteredSlots.length} of ${slots.length}` : slots.length} slot
              {slots.length === 1 ? "" : "s"} · {Math.round(filtersActive ? filteredVolume : totalVolume).toLocaleString()} t
            </p>
          )}
        </div>
      </div>

      <div className="card">
        {slots.length > 0 && (
          <div className="filter-toolbar">
            <div className="filter-toolbar-group">
              <span className="filter-toolbar-label">Customers</span>
              <div className="filter-toolbar-toggles">
                {filterCustomers.map((cust) => (
                  <button
                    key={cust.id}
                    type="button"
                    className={`metric-toggle${activeCustomers.has(cust.id) ? " metric-toggle--on" : ""}`}
                    onClick={() => toggleCustomer(cust.id)}
                  >
                    {cust.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-toolbar-group">
              <span className="filter-toolbar-label">Moves</span>
              <div className="filter-toolbar-toggles">
                {availableMoves.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`metric-toggle${activeMoves.has(key) ? " metric-toggle--on" : ""}`}
                    onClick={() => toggleMove(key)}
                  >
                    {formatDirectionModeLabel(key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-toolbar-group">
              <span className="filter-toolbar-label">Resources</span>
              <div className="filter-toolbar-toggles">
                {availableResources.map((res) => (
                  <button
                    key={res.id}
                    type="button"
                    className={`metric-toggle${activeResources.has(res.id) ? " metric-toggle--on" : ""}`}
                    onClick={() => toggleResource(res.id)}
                  >
                    {res.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <MovementsTable
          slots={filteredSlots}
          customerNameById={customerById}
          resourceNameById={resourceById}
          unfilteredCount={slots.length}
        />
      </div>
    </div>
  );
}
