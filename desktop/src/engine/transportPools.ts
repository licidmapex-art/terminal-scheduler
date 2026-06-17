/**

 * Transport pool resolution — shared physical assets, pool-aware roundtrip, proportional inventory.

 */



import type {
  Customer,
  CustomerTransportConfig,
  PoolInventoryAllocation,
  ScheduledSlot,
  TransportPool
} from "../types";

import type { SchedulingLeg } from "./feasibility";

import { customerDirectionTransports, customerSchedulableTransports, isPoolOnlyTransportRow } from "./customerTransports";



const HOUR_MS = 60 * 60 * 1000;



export function poolsById(pools: TransportPool[]): Map<string, TransportPool> {

  return new Map(pools.map((p) => [p.id, p]));

}



/** Merge pool defaults into a transport row — clubs are name-only; legs keep their own settings. */
export function resolveTransportRow(
  row: CustomerTransportConfig,
  _pools: TransportPool[]
): CustomerTransportConfig {
  return row;
}



export function resolvedCustomerSchedulableTransports(
  customer: Customer,
  direction: "inbound" | "outbound",
  pools: TransportPool[]
): CustomerTransportConfig[] {
  return customerSchedulableTransports(customer, direction).map((r) => resolveTransportRow(r, pools));
}

export function resolvedCustomerDirectionTransports(

  customer: Customer,

  direction: "inbound" | "outbound",

  pools: TransportPool[]

): CustomerTransportConfig[] {

  return customerDirectionTransports(customer, direction).map((r) => resolveTransportRow(r, pools));

}



export function laneIndexFromLegKey(legKey: string | null | undefined): number {

  if (!legKey) return 0;

  const colonLane = legKey.match(/:lane(\d+)$/);

  if (colonLane) {

    const n = parseInt(colonLane[1]!, 10);

    return Number.isFinite(n) && n >= 0 ? n : 0;

  }

  const dash = legKey.match(/^(inbound|outbound)-.+?-(\d+)$/);

  if (dash) {

    const n = parseInt(dash[2]!, 10);

    return Number.isFinite(n) && n > 0 ? n - 1 : 0;

  }

  const m = legKey.match(/-(\d+)$/);

  if (!m) return 0;

  const n = parseInt(m[1]!, 10);

  return Number.isFinite(n) && n > 0 ? n - 1 : 0;

}



export function transportRowForSlot(

  customer: Customer,

  slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey">,

  pools: TransportPool[]

): CustomerTransportConfig | null {

  const rows = resolvedCustomerSchedulableTransports(customer, slot.direction, pools);

  if (rows.length === 0) return null;

  const lk = slot.legKey;

  if (lk && lk !== "lane0") {

    const dash = lk.match(/^(inbound|outbound)-.+?-(\d+)$/);

    if (dash && dash[1] === slot.direction) {

      const idx = parseInt(dash[2]!, 10) - 1;

      if (idx >= 0 && idx < rows.length) return rows[idx]!;

    }

    const colonLane = lk.match(/:lane(\d+)$/);

    if (colonLane) {

      const idx = parseInt(colonLane[1]!, 10);

      if (idx >= 0 && idx < rows.length) return rows[idx]!;

    }

  }

  const idx = laneIndexFromLegKey(lk);

  if (idx >= 0 && idx < rows.length) {

    const row = rows[idx]!;

    if (row.mode === slot.mode) return row;

    if (lk && lk !== "lane0") return row;

  }

  if (!lk || lk === "lane0") {

    const matches = rows.filter((r) => r.mode === slot.mode);

    return matches.length === 1 ? (matches[0] ?? null) : null;

  }

  if (rows.length === 1) return rows[0]!;

  const modeMatches = rows.filter((r) => r.mode === slot.mode);

  return modeMatches.length === 1 ? (modeMatches[0] ?? null) : null;

}



/** Pool on the booking customer's transport leg for this slot (if any). */
export function poolIdForCustomerSlot(
  customer: Customer,
  slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey">,
  pools: TransportPool[]
): string | null {
  const row = transportRowForSlot(customer, slot, pools);
  if (row?.poolId) return row.poolId;

  const rows = customerDirectionTransports(customer, slot.direction);
  if (rows.length === 0) return null;

  const idx = laneIndexFromLegKey(slot.legKey);
  if (idx >= 0 && idx < rows.length) return rows[idx]?.poolId ?? null;

  if (!slot.legKey || slot.legKey === "lane0") {
    const matches = rows.filter((r) => r.mode === slot.mode);
    if (matches.length === 1) return matches[0]?.poolId ?? null;
  }

  if (rows.length === 1) return rows[0]?.poolId ?? null;
  return null;
}



export function poolTerminalKey(poolId: string, direction: "inbound" | "outbound"): string {
  return `${poolId}:${direction}`;
}

/** True when any customer leg references a transport pool. */
export function hasActiveTransportPoolLegs(
  customers: Customer[],
  pools: TransportPool[]
): boolean {
  return pools.some((pool) => customersInPool(pool.id, customers).length > 0);
}

/** @deprecated Use {@link customersInPoolForBerthFlow} for inventory splits. */
export function hasActiveProportionalTransportPools(
  customers: Customer[],
  pools: TransportPool[]
): boolean {
  for (const pool of pools) {
    for (const direction of ["inbound", "outbound"] as const) {
      for (const c of customers) {
        for (const r of customerDirectionTransports(c, direction)) {
          if (r.poolId !== pool.id || isPoolOnlyTransportRow(r)) continue;
          if (roundtripSharingForBerthMode(r.mode as "ship" | "barge" | "train") === "proportional") {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** Roundtrip sharing for a pooled berth leg — train = one shared asset; ship/barge = per member. */
export function roundtripSharingForBerthMode(
  mode: "ship" | "barge" | "train"
): PoolInventoryAllocation {
  return mode === "train" ? "attributed" : "proportional";
}

/** Customers with pool membership for a berth flow (scheduling legs + inventory-only pool rows). */
export function customersInPoolForBerthFlow(
  poolId: string,
  direction: "inbound" | "outbound",
  berthMode: "ship" | "barge" | "train",
  customers: Customer[]
): Customer[] {
  return customers.filter((c) =>
    customerDirectionTransports(c, direction).some((r) => {
      if (r.poolId !== poolId) return false;
      if (isPoolOnlyTransportRow(r)) return true;
      return r.mode === berthMode;
    })
  );
}

/** Customers with any leg or pool membership on this pool in the given direction. */
export function customersInPoolForDirection(
  poolId: string,
  direction: "inbound" | "outbound",
  customers: Customer[]
): Customer[] {
  return customers.filter((c) =>
    customerDirectionTransports(c, direction).some((r) => r.poolId === poolId)
  );
}

/** Customers with any leg referencing this pool (either direction). */
export function customersInPool(poolId: string, customers: Customer[]): Customer[] {
  const seen = new Set<string>();
  const out: Customer[] = [];
  for (const direction of ["inbound", "outbound"] as const) {
    for (const c of customersInPoolForDirection(poolId, direction, customers)) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
  }
  return out;
}



export function poolShareFrac(customer: Customer, poolMembers: Customer[]): number {

  const total = poolMembers.reduce((s, c) => s + c.storageShare, 0) || 100;

  return total > 0 ? customer.storageShare / total : 1 / Math.max(poolMembers.length, 1);

}



/** Share of pool members' attributed inventory at the moment of a berth flow. */
export function poolInventoryShareFrac(
  customerId: string,
  poolMembers: Customer[],
  invById: Record<string, number>
): number {
  if (poolMembers.length === 0) return 0;
  if (poolMembers.length === 1) return 1;
  const weights = poolMembers.map((m) => Math.max(0, invById[m.id] ?? 0));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 1 / poolMembers.length;
  const idx = poolMembers.findIndex((m) => m.id === customerId);
  return idx >= 0 ? weights[idx]! / total : 0;
}



export function isProportionalPoolLeg(leg: Pick<SchedulingLeg, "poolId" | "inventoryAllocation" | "mode">): boolean {
  if (!leg.poolId) return false;
  const alloc = leg.inventoryAllocation ?? roundtripSharingForBerthMode(leg.mode);
  return alloc === "proportional";
}

/** Single shared physical asset (e.g. one train) — roundtrip blocks across all pool members. */
export function poolUsesSharedRoundtrip(
  leg: Pick<SchedulingLeg, "poolId" | "inventoryAllocation" | "mode">,
  _pools: TransportPool[]
): boolean {
  if (!leg.poolId) return false;
  const alloc = leg.inventoryAllocation ?? roundtripSharingForBerthMode(leg.mode);
  return alloc === "attributed";
}



export function roundtripScopeKey(

  leg: Pick<SchedulingLeg, "customer" | "direction" | "mode" | "laneKey" | "poolId" | "inventoryAllocation">,

  pools: TransportPool[] = []

): string {

  if (leg.poolId && poolUsesSharedRoundtrip(leg, pools)) return `pool:${leg.poolId}:${leg.direction}`;

  return `${leg.customer.id}:${leg.direction}:${leg.mode}:${leg.laneKey ?? "lane0"}`;

}



export function slotMatchesRoundtripScope(

  slot: ScheduledSlot,

  leg: Pick<SchedulingLeg, "customer" | "direction" | "mode" | "laneKey" | "poolId" | "inventoryAllocation">,

  customers: Customer[],

  pools: TransportPool[]

): boolean {

  if (slot.direction !== leg.direction || slot.mode !== leg.mode) return false;

  if (leg.poolId && poolUsesSharedRoundtrip(leg, pools)) {

    const row = transportRowForSlot(

      customers.find((c) => c.id === slot.customerId) ?? leg.customer,

      slot,

      pools

    );

    return row?.poolId === leg.poolId;

  }

  if (slot.customerId !== leg.customer.id) return false;

  return (slot.legKey ?? "lane0") === (leg.laneKey ?? "lane0");

}



export function lastCompletedEndHourForLeg(

  leg: SchedulingLeg,

  h: number,

  assignedSlots: ScheduledSlot[],

  simStartMs: number,

  customers: Customer[],

  pools: TransportPool[]

): number | null {

  let bestEndMs: number | null = null;

  for (const s of assignedSlots) {

    if (!slotMatchesRoundtripScope(s, leg, customers, pools)) continue;

    const endMs = new Date(s.end).getTime();

    if (endMs <= simStartMs + h * HOUR_MS) {

      if (bestEndMs === null || endMs > bestEndMs) bestEndMs = endMs;

    }

  }

  if (bestEndMs === null) return null;

  return Math.round((bestEndMs - simStartMs) / HOUR_MS);

}



export function lastLegSlotStartHourForLeg(

  leg: SchedulingLeg,

  assignedSlots: ScheduledSlot[],

  simStartMs: number,

  throughHour: number,

  customers: Customer[],

  pools: TransportPool[]

): number | null {

  let bestStart: number | null = null;

  for (const s of assignedSlots) {

    if (!slotMatchesRoundtripScope(s, leg, customers, pools)) continue;

    const startHour = Math.round((new Date(s.start).getTime() - simStartMs) / HOUR_MS);

    if (startHour > throughHour) continue;

    if (bestStart === null || startHour > bestStart) bestStart = startHour;

  }

  return bestStart;

}



/** Pool commingled stock from pool-leg flows only (opening inventory stays in privateInvById). */

export function initProportionalPoolTerminal(
  customers: Customer[],
  _pools: TransportPool[]
): Map<string, number> {
  const poolTerminal = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of customers) {
    for (const direction of ["inbound", "outbound"] as const) {
      for (const r of customerDirectionTransports(c, direction)) {
        if (!r.poolId || isPoolOnlyTransportRow(r)) continue;
        if (roundtripSharingForBerthMode(r.mode as "ship" | "barge" | "train") !== "proportional") {
          continue;
        }
        const key = poolTerminalKey(r.poolId, direction);
        if (!seen.has(key)) {
          seen.add(key);
          poolTerminal.set(key, 0);
        }
      }
    }
  }
  return poolTerminal;
}



/**

 * Recompute invById: private (non-pool) attributed stock plus each proportional pool's share.

 */

export function syncPoolMemberInventories(

  privateInvById: Record<string, number>,

  poolTerminal: Map<string, number>,

  customers: Customer[],

  pools: TransportPool[],

  invById: Record<string, number>

): void {

  for (const c of customers) {

    invById[c.id] = privateInvById[c.id] ?? 0;

  }

  for (const poolId of new Set(
    customers.flatMap((c) =>
      ["inbound", "outbound"].flatMap((direction) =>
        customerDirectionTransports(c, direction as "inbound" | "outbound")
          .filter((r) => r.poolId && !isPoolOnlyTransportRow(r))
          .map((r) => r.poolId!)
      )
    )
  )) {
    for (const direction of ["inbound", "outbound"] as const) {
      const members = customersInPoolForDirection(poolId, direction, customers);
      if (members.length === 0) continue;
      const hasProportional = members.some((c) =>
        customerDirectionTransports(c, direction).some(
          (r) =>
            r.poolId === poolId &&
            !isPoolOnlyTransportRow(r) &&
            roundtripSharingForBerthMode(r.mode as "ship" | "barge" | "train") === "proportional"
        )
      );
      if (!hasProportional) continue;
      const total = poolTerminal.get(poolTerminalKey(poolId, direction)) ?? 0;
      for (const c of members) {
        invById[c.id] = (invById[c.id] ?? 0) + total * poolShareFrac(c, members);
      }
    }
  }
}



/**
 * Apply berth cargo to customer inventory during loading hours.
 * Non-pool leg: 100% to the booking customer (their ship).
 * Pool leg: split among pool members on this direction by each member's inventory share.
 */
export function attributeSlotTonnesToInventory(
  slot: Pick<ScheduledSlot, "customerId" | "direction" | "mode" | "legKey">,
  tonnes: number,
  customers: Customer[],
  transportPools: TransportPool[],
  invById: Record<string, number>
): void {
  if (tonnes <= 0) return;
  const sign: 1 | -1 = slot.direction === "inbound" ? 1 : -1;
  const delta = sign * tonnes;
  const customer = customers.find((c) => c.id === slot.customerId);
  if (!customer) return;

  const poolId = poolIdForCustomerSlot(customer, slot, transportPools);

  if (poolId) {
    const members = customersInPoolForBerthFlow(poolId, slot.direction, slot.mode, customers);
    if (members.length === 0) {
      invById[slot.customerId] = (invById[slot.customerId] ?? 0) + delta;
      return;
    }
    const shareByMember = new Map(
      members.map((m) => [m.id, poolInventoryShareFrac(m.id, members, invById)] as const)
    );
    for (const m of members) {
      const frac = shareByMember.get(m.id) ?? 0;
      invById[m.id] = (invById[m.id] ?? 0) + delta * frac;
    }
    return;
  }

  invById[slot.customerId] = (invById[slot.customerId] ?? 0) + delta;
}

/** @deprecated Use {@link attributeSlotTonnesToInventory} with a real slot. */
export function applyProportionalPoolFlow(
  poolId: string,
  direction: "inbound" | "outbound",
  tonnes: number,
  _sign: 1 | -1,
  _poolTerminal: Map<string, number>,
  _privateInvById: Record<string, number>,
  customers: Customer[],
  transportPools: TransportPool[],
  invById: Record<string, number>
): void {
  const pool = transportPools.find((p) => p.id === poolId);
  const members = customersInPoolForDirection(poolId, direction, customers);
  const booker = members[0];
  if (!booker) return;
  attributeSlotTonnesToInventory(
    {
      customerId: booker.id,
      direction,
      mode: pool?.mode ?? "ship",
      legKey: `${direction}-${pool?.mode ?? "ship"}-1`
    },
    tonnes,
    customers,
    transportPools,
    invById
  );
}


