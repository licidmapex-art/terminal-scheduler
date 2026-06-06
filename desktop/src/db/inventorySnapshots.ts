import { getDatabase } from "./database";
import type { InventorySnapshot } from "../types";

function rowToSnapshot(r: {
  id: number;
  customer_id: string;
  timestamp: string;
  volume: number;
  source: string;
}): InventorySnapshot & { id: number } {
  return {
    id: r.id,
    customerId: r.customer_id,
    timestamp: new Date(r.timestamp),
    volume: r.volume,
    source: r.source as InventorySnapshot["source"]
  };
}

export function createInventorySnapshot(snapshot: InventorySnapshot): InventorySnapshot & { id: number } {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO inventory_snapshots (customer_id, timestamp, volume, source)
    VALUES (?, ?, ?, ?)
  `).run(
    snapshot.customerId,
    snapshot.timestamp.toISOString(),
    snapshot.volume,
    snapshot.source
  );
  const row = db.prepare("SELECT * FROM inventory_snapshots WHERE id = ?").get(result.lastInsertRowid) as {
    id: number;
    customer_id: string;
    timestamp: string;
    volume: number;
    source: string;
  };
  return rowToSnapshot(row);
}

export function getAllInventorySnapshots(): (InventorySnapshot & { id: number })[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM inventory_snapshots ORDER BY timestamp").all() as Array<{
    id: number;
    customer_id: string;
    timestamp: string;
    volume: number;
    source: string;
  }>;
  return rows.map(rowToSnapshot);
}

export function getInventorySnapshotById(id: number): (InventorySnapshot & { id: number }) | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM inventory_snapshots WHERE id = ?").get(id) as {
    id: number;
    customer_id: string;
    timestamp: string;
    volume: number;
    source: string;
  } | undefined;
  if (!row) return null;
  return rowToSnapshot(row);
}

export function getInventorySnapshotsByCustomerId(customerId: string): (InventorySnapshot & { id: number })[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM inventory_snapshots WHERE customer_id = ? ORDER BY timestamp").all(customerId) as Array<{
    id: number;
    customer_id: string;
    timestamp: string;
    volume: number;
    source: string;
  }>;
  return rows.map(rowToSnapshot);
}

export function updateInventorySnapshot(
  id: number,
  snapshot: Omit<InventorySnapshot, "customerId"> & { customerId?: string }
): InventorySnapshot & { id: number } {
  const db = getDatabase();
  const existing = db.prepare("SELECT * FROM inventory_snapshots WHERE id = ?").get(id) as {
    customer_id: string;
  } | undefined;
  if (!existing) throw new Error(`InventorySnapshot with id ${id} not found`);
  const customerId = snapshot.customerId ?? existing.customer_id;
  db.prepare(`
    UPDATE inventory_snapshots SET
      customer_id = ?,
      timestamp = ?,
      volume = ?,
      source = ?
    WHERE id = ?
  `).run(
    customerId,
    snapshot.timestamp.toISOString(),
    snapshot.volume,
    snapshot.source,
    id
  );
  const row = db.prepare("SELECT * FROM inventory_snapshots WHERE id = ?").get(id) as {
    id: number;
    customer_id: string;
    timestamp: string;
    volume: number;
    source: string;
  };
  return rowToSnapshot(row);
}

export function deleteInventorySnapshot(id: number): void {
  const db = getDatabase();
  db.prepare("DELETE FROM inventory_snapshots WHERE id = ?").run(id);
}
