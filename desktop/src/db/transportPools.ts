import { getDatabase } from "./database";

import type { TransportPool } from "../types";



function rowToPool(r: {

  id: string;

  name: string;

  mode?: string;

  roundtrip_hours?: number;

  meps?: number;

  inventory_allocation?: string;

}): TransportPool {

  return {

    id: r.id,

    name: r.name

  };

}



export function createTransportPool(pool: TransportPool): TransportPool {

  const db = getDatabase();

  db.prepare(`

    INSERT INTO transport_pools (id, name, mode, roundtrip_hours, meps, inventory_allocation)

    VALUES (?, ?, ?, ?, ?, ?)

  `).run(pool.id, pool.name, "ship", 0, 0, "proportional");

  return pool;

}



export function getAllTransportPools(): TransportPool[] {

  const db = getDatabase();

  const rows = db.prepare("SELECT * FROM transport_pools ORDER BY name").all() as Array<{

    id: string;

    name: string;

    mode: string;

    roundtrip_hours: number;

    meps: number;

    inventory_allocation: string;

  }>;

  return rows.map(rowToPool);

}



export function getTransportPoolById(id: string): TransportPool | null {

  const db = getDatabase();

  const row = db.prepare("SELECT * FROM transport_pools WHERE id = ?").get(id) as {

    id: string;

    name: string;

    mode: string;

    roundtrip_hours: number;

    meps: number;

    inventory_allocation: string;

  } | undefined;

  return row ? rowToPool(row) : null;

}



export function updateTransportPool(pool: TransportPool): TransportPool {

  const db = getDatabase();

  db.prepare(`

    UPDATE transport_pools

    SET name = ?

    WHERE id = ?

  `).run(pool.name, pool.id);

  return pool;

}



export function deleteTransportPool(id: string): void {

  const db = getDatabase();

  db.prepare("DELETE FROM transport_pools WHERE id = ?").run(id);

}



export function deleteAllTransportPools(): void {

  const db = getDatabase();

  db.exec("DELETE FROM transport_pools");

}

