/**
 * Database migrations - initializes all tables on first run.
 */

import type Database from "better-sqlite3";

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      declared_inbound_throughput REAL NOT NULL DEFAULT 0,
      current_inventory REAL NOT NULL,
      pipeline_share REAL NOT NULL,
      storage_share REAL NOT NULL DEFAULT 100,
      inbound_meps REAL DEFAULT 0,
      inbound_mode TEXT DEFAULT 'ship',
      outbound_meps REAL DEFAULT 0,
      outbound_mode TEXT DEFAULT 'ship',
      inbound_transports_json TEXT,
      outbound_transports_json TEXT
    );

    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('berth_large', 'berth_small', 'rail_siding')),
      flow_rate REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blackouts (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_slots (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      mode TEXT NOT NULL CHECK (mode IN ('ship', 'barge', 'train')),
      leg_key TEXT,
      volume REAL NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'manual_override')),
      conflict_reason TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (resource_id) REFERENCES resources(id)
    );

    CREATE TABLE IF NOT EXISTS simulation_configs (
      id TEXT PRIMARY KEY,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      pipeline_flow_rate REAL NOT NULL,
      pipeline_direction TEXT NOT NULL CHECK (pipeline_direction IN ('inbound', 'outbound')),
      total_storage_capacity REAL NOT NULL DEFAULT 100000,
      storage_mode TEXT NOT NULL DEFAULT 'fixed_band' CHECK (storage_mode IN ('fixed_band', 'shared_shipping', 'time_shared_storage', 'shared_inventory')),
      pacer_rounding_direction TEXT NOT NULL DEFAULT 'up' CHECK (pacer_rounding_direction IN ('up', 'down')),
      pacer_round_at_decile INTEGER NOT NULL DEFAULT 1,
      optimizer_min_days_of_cover REAL NOT NULL DEFAULT 0,
      optimizer_relative_doc_multiplier REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      volume REAL NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('pipeline', 'slot', 'initial')),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_blackouts_resource_id ON blackouts(resource_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_slots_resource_id ON scheduled_slots(resource_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_customer_timestamp ON inventory_snapshots(customer_id, timestamp);
  `);

  // Migration: add new mass-balance customer columns (for existing databases)
  try {
    database.exec("ALTER TABLE customers ADD COLUMN declared_inbound_throughput REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN inbound_meps REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN inbound_mode TEXT NOT NULL DEFAULT 'ship'");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN outbound_meps REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN outbound_mode TEXT NOT NULL DEFAULT 'ship'");
  } catch {
    /* column already exists */
  }
  // Migrate data from old columns if they exist
  try {
    database.exec(`
      UPDATE customers SET
        declared_inbound_throughput = CASE WHEN direction = 'inbound' THEN COALESCE(declared_throughput, 0) ELSE 0 END,
        inbound_meps = CASE WHEN direction = 'inbound' THEN COALESCE(meps, 0) ELSE 0 END,
        inbound_mode = COALESCE(transport_mode, 'ship'),
        outbound_meps = CASE WHEN direction = 'outbound' THEN COALESCE(meps, 0) ELSE 0 END,
        outbound_mode = COALESCE(transport_mode, 'ship')
    `);
  } catch {
    /* old columns may not exist */
  }
  // Remove old columns
  try {
    database.exec("ALTER TABLE customers DROP COLUMN declared_throughput");
  } catch {
    /* column already removed or SQLite < 3.35 */
  }
  try {
    database.exec("ALTER TABLE customers DROP COLUMN meps");
  } catch {
    /* column already removed */
  }
  try {
    database.exec("ALTER TABLE customers DROP COLUMN transport_mode");
  } catch {
    /* column already removed */
  }
  try {
    database.exec("ALTER TABLE customers DROP COLUMN direction");
  } catch {
    /* column already removed */
  }

  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN total_storage_capacity REAL NOT NULL DEFAULT 100000");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'fixed_band'");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN min_slot_interval_hours REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE customers ADD COLUMN storage_share REAL NOT NULL DEFAULT 100");
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      "UPDATE customers SET storage_share = min(100, max_capacity * 100.0 / 100000) WHERE max_capacity IS NOT NULL"
    );
  } catch {
    /* max_capacity may not exist */
  }
  try {
    database.exec("ALTER TABLE customers DROP COLUMN max_capacity");
  } catch {
    /* column already removed or SQLite < 3.35 */
  }

  try {
    database.exec(
      "ALTER TABLE customers ADD COLUMN inbound_roundtrip_hours REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      "ALTER TABLE customers ADD COLUMN outbound_roundtrip_hours REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN tank_count INTEGER NOT NULL DEFAULT 4");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN tank_capacity REAL NOT NULL DEFAULT 7000");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN pre_ops_hours REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE simulation_configs ADD COLUMN post_ops_hours REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("UPDATE simulation_configs SET storage_mode = 'shared_shipping' WHERE storage_mode = 'commingled'");
  } catch {
    /* no table or column */
  }

  try {
    database.exec("ALTER TABLE customers ADD COLUMN time_shared_min_band REAL NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN time_shared_duration REAL NOT NULL DEFAULT 24");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE customers ADD COLUMN chart_color TEXT");
  } catch {
    /* column already exists */
  }

  try {
    database.exec("ALTER TABLE customers ADD COLUMN inbound_transports_json TEXT");
  } catch {
    /* column already exists */
  }
  try {
    database.exec("ALTER TABLE customers ADD COLUMN outbound_transports_json TEXT");
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN shared_inventory_min_stock_tonnes REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN shared_inventory_customer_deficit_limit_tonnes REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN pacer_rounding_direction TEXT NOT NULL DEFAULT 'up'"
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN pacer_round_at_decile INTEGER NOT NULL DEFAULT 1"
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN optimizer_min_days_of_cover REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      "ALTER TABLE simulation_configs ADD COLUMN optimizer_relative_doc_multiplier REAL NOT NULL DEFAULT 0"
    );
  } catch {
    /* column already exists */
  }

  migrateCustomerPipelineFlowPerHour(database);

  migrateCustomerPipelineInboundOutbound(database);

  migrateScheduledSlotsDropRequests(database);

  try {
    database.exec("ALTER TABLE scheduled_slots ADD COLUMN leg_key TEXT");
  } catch {
    /* column already exists */
  }
}

/** Split legacy signed net pipeline into explicit inbound/outbound columns (t/h). */
function migrateCustomerPipelineInboundOutbound(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));

  if (!names.has("pipeline_inbound_per_hour")) {
    try {
      database.exec(
        "ALTER TABLE customers ADD COLUMN pipeline_inbound_per_hour REAL NOT NULL DEFAULT 0"
      );
    } catch {
      return;
    }
  }
  if (!names.has("pipeline_outbound_per_hour")) {
    try {
      database.exec(
        "ALTER TABLE customers ADD COLUMN pipeline_outbound_per_hour REAL NOT NULL DEFAULT 0"
      );
    } catch {
      return;
    }
  }

  try {
    database.exec(`
      UPDATE customers SET
        pipeline_inbound_per_hour = CASE
          WHEN pipeline_flow_per_hour < 0 THEN 0
          WHEN COALESCE(
            (SELECT pipeline_direction FROM simulation_configs ORDER BY rowid LIMIT 1),
            'inbound'
          ) = 'outbound' THEN 0
          ELSE pipeline_flow_per_hour
        END,
        pipeline_outbound_per_hour = CASE
          WHEN pipeline_flow_per_hour < 0 THEN ABS(pipeline_flow_per_hour)
          WHEN COALESCE(
            (SELECT pipeline_direction FROM simulation_configs ORDER BY rowid LIMIT 1),
            'inbound'
          ) = 'outbound' THEN pipeline_flow_per_hour
          ELSE 0
        END
      WHERE pipeline_inbound_per_hour = 0
        AND pipeline_outbound_per_hour = 0
        AND pipeline_flow_per_hour != 0
    `);
  } catch {
    /* ignore */
  }
}

/** Replace pipeline_share + terminal rate with per-customer pipeline_flow_per_hour (t/h). */
function migrateCustomerPipelineFlowPerHour(database: Database.Database): void {
  const cols = database.prepare("PRAGMA table_info(customers)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  const hasShare = names.has("pipeline_share");
  const hasFlow = names.has("pipeline_flow_per_hour");

  if (!hasFlow) {
    try {
      database.exec(
        "ALTER TABLE customers ADD COLUMN pipeline_flow_per_hour REAL NOT NULL DEFAULT 0"
      );
    } catch {
      return;
    }
  }

  if (hasShare) {
    try {
      database.exec(`
        UPDATE customers SET pipeline_flow_per_hour = COALESCE(
          (SELECT pipeline_flow_rate FROM simulation_configs LIMIT 1), 0
        ) * pipeline_share / 100.0
      `);
    } catch {
      /* ignore */
    }
    try {
      database.exec("ALTER TABLE customers DROP COLUMN pipeline_share");
    } catch {
      /* SQLite < 3.35 or already dropped */
    }
  }

  try {
    database.exec("UPDATE simulation_configs SET pipeline_flow_rate = 0");
  } catch {
    /* table missing */
  }
}

/** Rebuild scheduled_slots with direction/mode/volume; drop transport_requests (v3). */
function migrateScheduledSlotsDropRequests(database: Database.Database): void {
  const scheduledSlotsExists = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_slots'"
    )
    .get() as { name: string } | undefined;

  if (!scheduledSlotsExists) {
    return;
  }

  const slotColumns = database.prepare("PRAGMA table_info(scheduled_slots)").all() as Array<{
    name: string;
  }>;
  const slotColNames = new Set(slotColumns.map((c) => c.name));

  if (slotColNames.has("direction") && !slotColNames.has("request_id")) {
    database.exec("DROP TABLE IF EXISTS transport_requests");
    return;
  }

  if (!slotColNames.has("request_id")) {
    return;
  }

  database.exec("BEGIN");
  try {
    database.exec(`
      CREATE TABLE scheduled_slots_v3 (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        mode TEXT NOT NULL CHECK (mode IN ('ship', 'barge', 'train')),
        leg_key TEXT,
        volume REAL NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'confirmed', 'manual_override')),
        conflict_reason TEXT,
        FOREIGN KEY (customer_id) REFERENCES customers(id),
        FOREIGN KEY (resource_id) REFERENCES resources(id)
      );
    `);
    database.exec(`
      INSERT INTO scheduled_slots_v3 (id, customer_id, resource_id, direction, mode, leg_key, volume, start, end, status, conflict_reason)
      SELECT s.id, s.customer_id, s.resource_id,
        COALESCE(tr.direction, 'inbound'),
        COALESCE(tr.mode, 'ship'),
        NULL,
        COALESCE(tr.volume, 0),
        s.start, s.end,
        CASE
          WHEN s.status = 'unschedulable' THEN 'scheduled'
          WHEN s.status IN ('scheduled', 'confirmed', 'manual_override') THEN s.status
          ELSE 'scheduled'
        END,
        s.conflict_reason
      FROM scheduled_slots s
      LEFT JOIN transport_requests tr ON s.request_id = tr.id;
    `);
    database.exec("DROP TABLE scheduled_slots");
    database.exec("ALTER TABLE scheduled_slots_v3 RENAME TO scheduled_slots");
    database.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_slots_resource_id ON scheduled_slots(resource_id)");
    database.exec("DROP TABLE IF EXISTS transport_requests");
    database.exec("COMMIT");
  } catch (e) {
    database.exec("ROLLBACK");
    throw e;
  }
}
