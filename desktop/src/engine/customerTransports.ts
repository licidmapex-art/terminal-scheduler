import type { BerthTransportMode, Customer, CustomerTransportConfig, ScheduledSlot } from "../types";
import { HOUR_MS } from "./slotLaytime";

export type TransportDirection = "inbound" | "outbound";

function clampShare(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

export function isPoolOnlyTransportRow(row: CustomerTransportConfig): boolean {
  return row.mode === "pool";
}

/** Legs that book berths and carry cargo (excludes inventory-only pool membership). */
export function isSchedulableTransportRow(row: CustomerTransportConfig): boolean {
  return !isPoolOnlyTransportRow(row) && (row.meps ?? 0) > 0;
}

function normalizeRows(rows: CustomerTransportConfig[]): CustomerTransportConfig[] {
  const filtered = rows
    .filter((r) => (isPoolOnlyTransportRow(r) ? !!r.poolId : (r.meps ?? 0) > 0))
    .map((r) => {
      if (isPoolOnlyTransportRow(r)) {
        return {
          mode: "pool" as const,
          sharePct: clampShare(r.sharePct),
          shareFixed: !!r.shareFixed,
          meps: 0,
          roundtripHours: 0,
          reservationWindowHours: 0,
          poolId: r.poolId ?? null
        };
      }
      return {
        mode: r.mode as BerthTransportMode,
        sharePct: clampShare(r.sharePct),
        shareFixed: !!r.shareFixed,
        meps: Math.max(0, r.meps ?? 0),
        roundtripHours: Math.max(0, r.roundtripHours ?? 0),
        reservationWindowHours: Math.max(0, r.reservationWindowHours ?? 0),
        poolId: r.poolId ?? null
      };
    });
  if (filtered.length === 0) return [];
  const schedulable = filtered.filter(isSchedulableTransportRow);
  const shareBase = schedulable.length > 0 ? schedulable : filtered;
  const sum = shareBase.reduce((s, r) => s + r.sharePct, 0);
  if (sum <= 0) {
    const equal = 100 / shareBase.length;
    return filtered.map((r) =>
      isSchedulableTransportRow(r) || !schedulable.length ? { ...r, sharePct: equal } : { ...r, sharePct: 0 }
    );
  }
  return filtered.map((r) => {
    if (schedulable.length > 0 && isPoolOnlyTransportRow(r)) {
      return { ...r, sharePct: 0 };
    }
    if (schedulable.length > 0 && !isSchedulableTransportRow(r)) {
      return r;
    }
    return { ...r, sharePct: (r.sharePct * 100) / sum };
  });
}

export function customerDirectionTransports(
  customer: Customer,
  direction: TransportDirection
): CustomerTransportConfig[] {
  const rows =
    direction === "inbound" ? customer.inboundTransports ?? [] : customer.outboundTransports ?? [];
  if (rows.length > 0) return normalizeRows(rows);
  if (direction === "inbound") {
    if ((customer.inboundMEPS ?? 0) <= 0) return [];
    return [
      {
        mode: customer.inboundMode ?? "ship",
        sharePct: 100,
        meps: Math.max(0, customer.inboundMEPS ?? 0),
        roundtripHours: Math.max(0, customer.inboundRoundtripHours ?? 0)
      }
    ];
  }
  if ((customer.outboundMEPS ?? 0) <= 0) return [];
  return [
    {
      mode: customer.outboundMode ?? "ship",
      sharePct: 100,
      meps: Math.max(0, customer.outboundMEPS ?? 0),
      roundtripHours: Math.max(0, customer.outboundRoundtripHours ?? 0)
    }
  ];
}

export function customerSchedulableTransports(
  customer: Customer,
  direction: TransportDirection
): CustomerTransportConfig[] {
  return customerDirectionTransports(customer, direction).filter(isSchedulableTransportRow);
}

export function legacyDirectionTransport(
  customer: Customer,
  direction: TransportDirection
): CustomerTransportConfig {
  const rows = customerSchedulableTransports(customer, direction);
  return (
    rows[0] ?? {
      mode: "ship",
      sharePct: 100,
      meps: 0,
      roundtripHours: 0
    }
  );
}

/** Round-trip hours for a scheduled slot — uses schedulable transport leg index from {@link ScheduledSlot.legKey}. */
export function roundtripHoursForScheduledSlot(
  customer: Customer,
  slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey">
): number {
  const rows = customerSchedulableTransports(customer, slot.direction);
  const lk = slot.legKey;
  if (lk && lk !== "lane0") {
    const m = lk.match(/^(inbound|outbound)-.+?-(\d+)$/);
    if (m && m[1] === slot.direction) {
      const laneIndex = parseInt(m[2]!, 10) - 1;
      if (laneIndex >= 0 && laneIndex < rows.length) return rows[laneIndex]!.roundtripHours;
    }
    const colonLane = lk.match(/:lane(\d+)$/);
    if (colonLane) {
      const laneIndex = parseInt(colonLane[1]!, 10);
      if (laneIndex >= 0 && laneIndex < rows.length) return rows[laneIndex]!.roundtripHours;
    }
  }
  const modeMatches = rows.filter((r) => r.mode === slot.mode);
  if (modeMatches.length === 1) return modeMatches[0]!.roundtripHours;
  if (rows.length === 1) return rows[0]!.roundtripHours;
  return slot.direction === "inbound"
    ? (customer.inboundRoundtripHours ?? 0)
    : (customer.outboundRoundtripHours ?? 0);
}

/**
 * Stable Gantt lane identity for round-trip bars — always customer-scoped.
 * Matches scheduler keys (`inbound-ship-1`) and manual keys (`cust:inbound:ship:lane1`).
 */
export function roundtripLaneKeyForSlot(
  customer: Customer,
  slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey">
): string {
  const customerId = customer.id;
  const dir = slot.direction as TransportDirection;
  const lk = slot.legKey;

  if (lk && lk !== "lane0") {
    if (lk.startsWith(`${customerId}:`)) return lk;
    return `${customerId}:${lk}`;
  }

  const rows = customerSchedulableTransports(customer, dir);
  const meps = mepsForScheduledSlot(customer, slot);
  const rt = roundtripHoursForScheduledSlot(customer, slot);
  const exact = rows
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        r.mode === slot.mode && r.meps === meps && Math.max(0, r.roundtripHours ?? 0) === rt
    );
  if (exact.length === 1) {
    return `${customerId}:${dir}-${slot.mode}-${exact[0]!.i + 1}`;
  }

  const modeRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.mode === slot.mode);
  if (modeRows.length === 1) {
    return `${customerId}:${dir}-${slot.mode}-${modeRows[0]!.i + 1}`;
  }

  const colonLane = lk?.match(/:lane(\d+)$/);
  if (colonLane) {
    return `${customerId}:${dir}:${slot.mode}:lane${colonLane[1]}`;
  }
  return `${customerId}:${dir}:${slot.mode}:lane0`;
}

/** Assign vertical lanes — one band per leg; overlapping windows on the same leg stack below. */
export function assignRoundtripBarLanes<
  T extends { legKey: string; anchorStartMs: number; hours: number }
>(entries: T[]): Array<T & { lane: number }> {
  if (entries.length === 0) return [];

  const uniqLegKeys = [...new Set(entries.map((e) => e.legKey))].sort((a, b) => a.localeCompare(b));
  const byLeg = new Map<string, T[]>();
  for (const e of entries) {
    const list = byLeg.get(e.legKey) ?? [];
    list.push(e);
    byLeg.set(e.legKey, list);
  }

  const out: Array<T & { lane: number }> = [];
  let laneOffset = 0;

  for (const legKey of uniqLegKeys) {
    const items = [...(byLeg.get(legKey) ?? [])].sort((a, b) => a.anchorStartMs - b.anchorStartMs);
    const subEnds: number[] = [];
    const staged: Array<T & { sub: number }> = [];

    for (const item of items) {
      const endMs = item.anchorStartMs + item.hours * HOUR_MS;
      let sub = 0;
      for (; sub < subEnds.length; sub++) {
        if (item.anchorStartMs >= subEnds[sub]!) break;
      }
      if (sub === subEnds.length) subEnds.push(endMs);
      else subEnds[sub] = endMs;
      staged.push({ ...item, sub });
    }

    for (const item of staged) {
      out.push({ ...item, lane: laneOffset + item.sub });
    }
    laneOffset += subEnds.length;
  }

  return out;
}

/**
 * Simulation hour when a visit starts (pre-ops) — matches scheduler round-trip anchor.
 * Round-trip blocks hours `startHour` … `startHour + roundtripHours - 1` (start-to-start).
 */
export function roundtripCooldownStartHour(
  slot: Pick<ScheduledSlot, "start">,
  simStartMs: number
): number {
  return Math.round((new Date(slot.start).getTime() - simStartMs) / HOUR_MS);
}

/** MEPS for a scheduled slot — uses schedulable transport leg index from {@link ScheduledSlot.legKey}. */
export function mepsForScheduledSlot(
  customer: Customer,
  slot: Pick<ScheduledSlot, "direction" | "mode" | "legKey">
): number {
  const rows = customerSchedulableTransports(customer, slot.direction);
  const lk = slot.legKey;
  if (lk && lk !== "lane0") {
    const m = lk.match(/^(inbound|outbound)-.+?-(\d+)$/);
    if (m && m[1] === slot.direction) {
      const laneIndex = parseInt(m[2]!, 10) - 1;
      if (laneIndex >= 0 && laneIndex < rows.length) return rows[laneIndex]!.meps;
    }
  }
  const modeMatches = rows.filter((r) => r.mode === slot.mode);
  if (modeMatches.length === 1) return modeMatches[0]!.meps;
  if (rows.length === 1) return rows[0]!.meps;
  return slot.direction === "inbound" ? (customer.inboundMEPS ?? 0) : (customer.outboundMEPS ?? 0);
}

export function splitTonnesByShares(
  totalTonnes: number,
  rows: CustomerTransportConfig[]
): number[] {
  if (rows.length === 0) return [];
  const sumShares = rows.reduce((s, r) => s + clampShare(r.sharePct), 0);
  const denom = sumShares > 0 ? sumShares : rows.length;
  return rows.map((r) => (totalTonnes * (sumShares > 0 ? clampShare(r.sharePct) : 1)) / denom);
}
