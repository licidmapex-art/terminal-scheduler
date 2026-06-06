import type { Customer, CustomerTransportConfig } from "../types";

export type TransportDirection = "inbound" | "outbound";

function clampShare(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

function normalizeRows(rows: CustomerTransportConfig[]): CustomerTransportConfig[] {
  const filtered = rows
    .filter((r) => (r.meps ?? 0) > 0)
    .slice(0, 3)
    .map((r) => ({
      mode: r.mode,
      sharePct: clampShare(r.sharePct),
      meps: Math.max(0, r.meps ?? 0),
      roundtripHours: Math.max(0, r.roundtripHours ?? 0)
    }));
  if (filtered.length === 0) return [];
  const sum = filtered.reduce((s, r) => s + r.sharePct, 0);
  if (sum <= 0) {
    const equal = 100 / filtered.length;
    return filtered.map((r) => ({ ...r, sharePct: equal }));
  }
  return filtered.map((r) => ({ ...r, sharePct: (r.sharePct * 100) / sum }));
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

export function legacyDirectionTransport(
  customer: Customer,
  direction: TransportDirection
): CustomerTransportConfig {
  const rows = customerDirectionTransports(customer, direction);
  return (
    rows[0] ?? {
      mode: "ship",
      sharePct: 100,
      meps: 0,
      roundtripHours: 0
    }
  );
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
