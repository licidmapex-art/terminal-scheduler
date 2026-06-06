import { getDatabase } from "./database";
import type { ScheduledSlot } from "../types";

function rowToSlot(r: {
  id: string;
  customer_id: string;
  resource_id: string;
  direction: string;
  mode: string;
  leg_key?: string | null;
  volume: number;
  start: string;
  end: string;
  status: string;
  conflict_reason: string | null;
}): ScheduledSlot {
  return {
    id: r.id,
    customerId: r.customer_id,
    resourceId: r.resource_id,
    direction: r.direction as ScheduledSlot["direction"],
    mode: r.mode as ScheduledSlot["mode"],
    legKey: r.leg_key ?? null,
    volume: r.volume,
    start: new Date(r.start),
    end: new Date(r.end),
    status: r.status as ScheduledSlot["status"],
    conflictReason: r.conflict_reason
  };
}

export function createScheduledSlot(slot: ScheduledSlot): ScheduledSlot {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO scheduled_slots (id, customer_id, resource_id, direction, mode, leg_key, volume, start, end, status, conflict_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slot.id,
    slot.customerId,
    slot.resourceId,
    slot.direction,
    slot.mode,
    slot.legKey ?? null,
    slot.volume,
    slot.start.toISOString(),
    slot.end.toISOString(),
    slot.status,
    slot.conflictReason
  );
  return slot;
}

export function getAllScheduledSlots(): ScheduledSlot[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM scheduled_slots").all() as Array<{
    id: string;
    customer_id: string;
    resource_id: string;
    direction: string;
    mode: string;
    leg_key?: string | null;
    volume: number;
    start: string;
    end: string;
    status: string;
    conflict_reason: string | null;
  }>;
  return rows.map(rowToSlot);
}

export function getScheduledSlotById(id: string): ScheduledSlot | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM scheduled_slots WHERE id = ?").get(id) as
    | {
        id: string;
        customer_id: string;
        resource_id: string;
        direction: string;
        mode: string;
    leg_key?: string | null;
        volume: number;
        start: string;
        end: string;
        status: string;
        conflict_reason: string | null;
      }
    | undefined;
  if (!row) return null;
  return rowToSlot(row);
}

export function updateScheduledSlot(slot: ScheduledSlot): ScheduledSlot {
  const db = getDatabase();
  db.prepare(`
    UPDATE scheduled_slots SET
      customer_id = ?,
      resource_id = ?,
      direction = ?,
      mode = ?,
      leg_key = ?,
      volume = ?,
      start = ?,
      end = ?,
      status = ?,
      conflict_reason = ?
    WHERE id = ?
  `).run(
    slot.customerId,
    slot.resourceId,
    slot.direction,
    slot.mode,
    slot.legKey ?? null,
    slot.volume,
    slot.start.toISOString(),
    slot.end.toISOString(),
    slot.status,
    slot.conflictReason,
    slot.id
  );
  return slot;
}

export function deleteScheduledSlot(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM scheduled_slots WHERE id = ?").run(id);
}

export function deleteAllScheduledSlots(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM scheduled_slots").run();
}
