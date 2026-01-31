import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

export function getDefaultDbPath() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'smmtryx3', 'sx3.db');
}

export function resolveDbPath(opts) {
  const fromEnv = process.env.SMMTRYX3_DB;
  const fromFlag = opts && typeof opts.db === 'string' ? opts.db : null;
  return path.resolve(fromFlag || fromEnv || getDefaultDbPath());
}

export async function openDb(dbPath) {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

  const SQL = await initSqlJs({
    locateFile: () => wasmPath,
  });

  const bytes = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  return { SQL, db };
}

export function ensureSchemaMigrations(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function persistDb(db, dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function hasTable(db, tableName) {
  const t = String(tableName || '').trim();
  if (!t) return false;
  const res = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?;", [t]);
  return Boolean(res?.[0]?.values?.length);
}

