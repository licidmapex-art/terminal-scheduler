/**
 * SQLite database connection and setup.
 */

import Database from "better-sqlite3";
import path from "path";
import { runMigrations } from "./migrations";

let db: Database.Database | null = null;

function getDbPath(): string {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "terminal-scheduler.db");
  } catch {
    return path.join(process.cwd(), "terminal-scheduler.db");
  }
}

export function getDatabase(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
