import { getDatabase } from "./database";
import type { Resource, Blackout } from "../types";

function rowToResource(
  r: { id: string; name: string; type: string; flow_rate: number },
  blackouts: Blackout[]
): Resource {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Resource["type"],
    flowRate: r.flow_rate,
    blackouts
  };
}

export function createResource(resource: Resource): Resource {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO resources (id, name, type, flow_rate)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(resource.id, resource.name, resource.type, resource.flowRate);
  for (const b of resource.blackouts) {
    db.prepare(`
      INSERT INTO blackouts (id, resource_id, start, end)
      VALUES (?, ?, ?, ?)
    `).run(b.id, b.resourceId, b.start.toISOString(), b.end.toISOString());
  }
  return resource;
}

export function getAllResources(): Resource[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM resources").all() as Array<{
    id: string;
    name: string;
    type: string;
    flow_rate: number;
  }>;
  return rows.map((r) => {
    const blackoutRows = db.prepare("SELECT * FROM blackouts WHERE resource_id = ?").all(r.id) as Array<{
      id: string;
      resource_id: string;
      start: string;
      end: string;
    }>;
    const blackouts: Blackout[] = blackoutRows.map((b) => ({
      id: b.id,
      resourceId: b.resource_id,
      start: new Date(b.start),
      end: new Date(b.end)
    }));
    return rowToResource(r, blackouts);
  });
}

export function getResourceById(id: string): Resource | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM resources WHERE id = ?").get(id) as {
    id: string;
    name: string;
    type: string;
    flow_rate: number;
  } | undefined;
  if (!row) return null;
  const blackoutRows = db.prepare("SELECT * FROM blackouts WHERE resource_id = ?").all(id) as Array<{
    id: string;
    resource_id: string;
    start: string;
    end: string;
  }>;
  const blackouts: Blackout[] = blackoutRows.map((b) => ({
    id: b.id,
    resourceId: b.resource_id,
    start: new Date(b.start),
    end: new Date(b.end)
  }));
  return rowToResource(row, blackouts);
}

export function updateResource(resource: Resource): Resource {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE resources SET name = ?, type = ?, flow_rate = ?
    WHERE id = ?
  `);
  stmt.run(resource.name, resource.type, resource.flowRate, resource.id);
  db.prepare("DELETE FROM blackouts WHERE resource_id = ?").run(resource.id);
  for (const b of resource.blackouts) {
    db.prepare(`
      INSERT INTO blackouts (id, resource_id, start, end)
      VALUES (?, ?, ?, ?)
    `).run(b.id, b.resourceId, b.start.toISOString(), b.end.toISOString());
  }
  return resource;
}

export function deleteResource(id: string): void {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare("DELETE FROM blackouts WHERE resource_id = ?").run(id);
    db.prepare("DELETE FROM scheduled_slots WHERE resource_id = ?").run(id);
    db.prepare("DELETE FROM resources WHERE id = ?").run(id);
  })();
}
