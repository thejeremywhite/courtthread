import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase } from "sql.js";
import path from "path";
import fs from "fs";
import { schema } from "./schema";

const DB_PATH =
  process.env.DB_PATH || path.join(process.cwd(), "data", "courtthread.db");

// Persist the handle across Next.js dev module reloads so we don't re-read the
// whole DB file from disk (and re-save it) on every single request. This was the
// main cause of the multi-second lag on a large database.
const g = globalThis as unknown as {
  __courtthread_db?: SqlJsDatabase | null;
  __courtthread_saveTimeout?: ReturnType<typeof setTimeout> | null;
  __courtthread_initPromise?: Promise<SqlJsDatabase> | null;
};

export async function getDb(): Promise<SqlJsDatabase> {
  if (g.__courtthread_db) return g.__courtthread_db;
  if (g.__courtthread_initPromise) return g.__courtthread_initPromise;

  g.__courtthread_initPromise = (async () => {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const SQL = await initSqlJs();

    let database: SqlJsDatabase;
    let isNew = false;
    if (fs.existsSync(DB_PATH)) {
      database = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      database = new SQL.Database();
      isNew = true;
    }

    database.run("PRAGMA foreign_keys = ON");
    database.run(schema); // CREATE TABLE IF NOT EXISTS … — safe to run every boot

    g.__courtthread_db = database;
    g.__courtthread_initPromise = null;
    if (isNew) saveDb(); // only write on first creation, not on every boot
    return database;
  })();

  return g.__courtthread_initPromise;
}

export function saveDb(): void {
  const database = g.__courtthread_db;
  if (!database) return;
  try {
    const buffer = Buffer.from(database.export());
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: temp file then rename, so a crash mid-write can't corrupt the DB.
    const tmp = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error("[db] saveDb failed:", e);
  }
}

export function scheduleSave(): void {
  if (g.__courtthread_saveTimeout) clearTimeout(g.__courtthread_saveTimeout);
  g.__courtthread_saveTimeout = setTimeout(() => {
    saveDb();
    g.__courtthread_saveTimeout = null;
  }, 1500);
}

export function closeDb(): void {
  if (g.__courtthread_saveTimeout) {
    clearTimeout(g.__courtthread_saveTimeout);
    g.__courtthread_saveTimeout = null;
  }
  if (g.__courtthread_db) {
    saveDb();
    g.__courtthread_db.close();
    g.__courtthread_db = null;
  }
}
