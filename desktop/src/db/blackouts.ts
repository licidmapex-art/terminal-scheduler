import { getDatabase } from "./database";
import type { Blackout } from "../types";

export function createBlackout(blackout: Blackout): Blackout {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO blackouts (id, resource_id, start, end)
    VALUES (?, ?, ?, ?)
  `).run(
    blackout.id,
    blackout.resourceId,
    blackout.start.toISOString(),
    blackout.end.toISOString()
  );
  return blackout;
}

export function getAllBlackouts(): Blackout[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM blackouts").all() as Array<{
    id: string;
    resource_id: string;
    start: string;
    end: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    resourceId: r.resource_id,
    start: new Date(r.start),
    end: new Date(r.end)
  }));
}

export function getBlackoutById(id: string): Blackout | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM blackouts WHERE id = ?").get(id) as {
    id: string;
    resource_id: string;
    start: string;
    end: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    resourceId: row.resource_id,
    start: new Date(row.start),
    end: new Date(row.end)
  };
}

export function getBlackoutsByResourceId(resourceId: string): Blackout[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM blackouts WHERE resource_id = ?").all(resourceId) as Array<{
    id: string;
    resource_id: string;
    start: string;
    end: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    resourceId: r.resource_id,
    start: new Date(r.start),
    end: new Date(r.end)
  }));
}

export function updateBlackout(blackout: Blackout): Blackout {
  const db = getDatabase();
  db.prepare(`
    UPDATE blackouts SET resource_id = ?, start = ?, end = ?
    WHERE id = ?
  `).run(
    blackout.resourceId,
    blackout.start.toISOString(),
    blackout.end.toISOString(),
    blackout.id
  );
  return blackout;
}

export function deleteBlackout(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM blackouts WHERE id = ?").run(id);
}
