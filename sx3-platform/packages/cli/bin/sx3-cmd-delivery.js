import { fail, inspect } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 delivery list [--db <path>]
  sx3 delivery show <delivery_id> [--db <path>]
`);
}

function ensureDeliveryTables(db) {
  if (!hasTable(db, 'deliveries')) {
    fail('sx3 delivery: таблица deliveries не найдена. Сначала выполни: ./sx3 db migrate', 2);
  }
}

async function cmdList(opts) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureDeliveryTables(db);

  const res = db.exec(
    `SELECT id, attempt_id, status, created_at, patch_uri, patch_sha256, patch_size
     FROM deliveries
     ORDER BY created_at DESC
     LIMIT 50;`,
  );
  const rows = res?.[0]?.values || [];
  // eslint-disable-next-line no-console
  console.log(`[sx3 delivery list] path=${dbPath} count=${rows.length}`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `- id=${r[0]}`,
        `attempt=${r[1]}`,
        `status=${r[2]}`,
        `created_at=${r[3]}`,
        `patch_uri=${r[4]}`,
        `sha256=${r[5]}`,
        `size=${r[6]}`,
      ].join(' '),
    );
  }
}

async function cmdShow(opts, rest) {
  const id = String(rest[0] || '');
  if (!id) fail('sx3 delivery show: требуется <delivery_id>', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureDeliveryTables(db);

  const res = db.exec(`SELECT * FROM deliveries WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 delivery show: delivery не найден: ${id}`, 2);
  const cols = res[0].columns;
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  // eslint-disable-next-line no-console
  console.log(inspect(obj));
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  if (sub === 'list') return cmdList(opts);
  if (sub === 'show') return cmdShow(opts, rest);
  fail(`sx3 delivery: неизвестная подкоманда: ${sub}`, 2);
}

