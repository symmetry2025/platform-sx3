import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, openDb, persistDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 db status [--db <path>]
  sx3 db migrate [--db <path>]

Notes:
  - По умолчанию БД лежит в XDG state: $XDG_STATE_HOME/smmtryx3/sx3.db
  - Можно переопределить через env: SMMTRYX3_DB=/path/to.db
`);
}

function getAppliedVersions(db) {
  const res = db.exec('SELECT version FROM schema_migrations ORDER BY version ASC;');
  if (!res || res.length === 0) return new Set();
  const rows = res[0]?.values || [];
  const out = new Set();
  for (const r of rows) out.add(Number(r[0]));
  return out;
}

function loadMigrations() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const migrationsDir = path.join(repoRoot, 'packages', 'cli', 'migrations');

  /** @type {{version:number,name:string,sql:string}[]} */
  const migrations = [
    {
      version: 1,
      name: '001_init',
      sql: fs.readFileSync(path.join(migrationsDir, '001_init.sql'), 'utf8'),
    },
  ];
  return migrations;
}

function getCurrentVersion(db) {
  const res = db.exec('SELECT MAX(version) AS v FROM schema_migrations;');
  const v = res?.[0]?.values?.[0]?.[0];
  return v == null ? 0 : Number(v);
}

export async function run(opts, sub, _rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);

  if (sub === 'status') {
    const current = getCurrentVersion(db);
    // eslint-disable-next-line no-console
    console.log(`[sx3 db status] path=${dbPath} version=${current}`);
    return;
  }

  if (sub === 'migrate') {
    const migrations = loadMigrations();
    const applied = getAppliedVersions(db);
    let appliedNow = 0;

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      db.run(m.sql);
      db.run(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, datetime(\'now\'));',
        [m.version, m.name],
      );
      appliedNow++;
    }

    persistDb(db, dbPath);
    const current = getCurrentVersion(db);
    // eslint-disable-next-line no-console
    console.log(`[sx3 db migrate] ok=1 applied=${appliedNow} version=${current} path=${dbPath}`);
    return;
  }

  fail(`sx3 db: неизвестная подкоманда: ${sub}`, 2);
}

