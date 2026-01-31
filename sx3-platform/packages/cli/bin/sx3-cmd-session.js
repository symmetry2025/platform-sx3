import crypto from 'node:crypto';

import { fail, inspect } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, persistDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 session open --project <id> [--session <id>] [--db <path>]
  sx3 session status [--session <id>] [--db <path>]
  sx3 session list [--db <path>]
  sx3 session close --session <id> [--db <path>]
`);
}

function ensureTables(db) {
  if (!hasTable(db, 'sessions')) fail('sx3 session: таблица sessions не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'events')) fail('sx3 session: таблица events не найдена. Сначала выполни: ./sx3 db migrate', 2);
}

function insertEvent(db, kind, fields) {
  const payload = fields ? JSON.stringify(fields) : null;
  db.run(
    `INSERT INTO events(ts, kind, session_id, attempt_id, delivery_id, checkpoint_id, payload_json)
     VALUES (datetime('now'), ?, ?, ?, ?, ?, ?);`,
    [
      kind,
      fields?.session_id ?? null,
      fields?.attempt_id ?? null,
      fields?.delivery_id ?? null,
      fields?.checkpoint_id ?? null,
      payload,
    ],
  );
}

async function cmdOpen(opts) {
  const projectId = opts && typeof opts.project === 'string' ? String(opts.project) : '';
  if (!projectId) fail('sx3 session open: требуется --project <id>', 2);

  const sessionId = opts && typeof opts.session === 'string' ? String(opts.session) : `s_${crypto.randomUUID()}`;
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  // idempotent-ish: if already exists, just show.
  const ex = db.exec(`SELECT id FROM sessions WHERE id=?;`, [sessionId]);
  const exists = Boolean(ex?.[0]?.values?.length);
  if (!exists) {
    db.run(
      `INSERT INTO sessions(id, project_id, status, created_at, closed_at, meta_json)
       VALUES (?, ?, 'open', datetime('now'), NULL, NULL);`,
      [sessionId, projectId],
    );
    insertEvent(db, 'session.opened', { session_id: sessionId, project_id: projectId });
    persistDb(db, dbPath);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[sx3 session open] ok=1 id=${sessionId} project_id=${projectId} db=${dbPath} remote_ref=origin/session/${sessionId}`,
  );
  // eslint-disable-next-line no-console
  console.log(`next_step_cmd=./sx3 checkpoint run --session ${sessionId} --remote-confirm-sha <sha> --dry-run`);
}

async function cmdStatus(opts) {
  const id = opts && typeof opts.session === 'string' ? String(opts.session) : '';
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  let res;
  if (id) {
    res = db.exec(`SELECT * FROM sessions WHERE id=?;`, [id]);
  } else {
    res = db.exec(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1;`);
  }
  const row = res?.[0]?.values?.[0];
  if (!row) fail(id ? `sx3 session status: session не найден: ${id}` : 'sx3 session status: sessions пусто', 2);
  const cols = res[0].columns;
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  // eslint-disable-next-line no-console
  console.log(inspect(obj));
}

async function cmdList(opts) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const res = db.exec(
    `SELECT id, project_id, status, created_at, closed_at
     FROM sessions
     ORDER BY created_at DESC
     LIMIT 50;`,
  );
  const rows = res?.[0]?.values || [];
  // eslint-disable-next-line no-console
  console.log(`[sx3 session list] path=${dbPath} count=${rows.length}`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(
      [`- id=${r[0]}`, `project=${r[1]}`, `status=${r[2]}`, `created_at=${r[3]}`, `closed_at=${r[4] || ''}`].join(' '),
    );
  }
}

async function cmdClose(opts) {
  const id = opts && typeof opts.session === 'string' ? String(opts.session) : '';
  if (!id) fail('sx3 session close: требуется --session <id>', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const res = db.exec(`SELECT id, status FROM sessions WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 session close: session не найден: ${id}`, 2);
  const status = String(row[1] || '');
  if (status === 'closed') {
    // eslint-disable-next-line no-console
    console.log(`[sx3 session close] ok=1 id=${id} already_closed=1`);
    return;
  }

  db.run(`UPDATE sessions SET status='closed', closed_at=datetime('now') WHERE id=?;`, [id]);
  insertEvent(db, 'session.closed', { session_id: id });
  persistDb(db, dbPath);
  // eslint-disable-next-line no-console
  console.log(`[sx3 session close] ok=1 id=${id}`);
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }
  if (sub === 'open') return cmdOpen(opts);
  if (sub === 'status') return cmdStatus(opts, rest);
  if (sub === 'list') return cmdList(opts);
  if (sub === 'close') return cmdClose(opts);
  fail(`sx3 session: неизвестная подкоманда: ${sub}`, 2);
}

