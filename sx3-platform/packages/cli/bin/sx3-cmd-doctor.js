import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 doctor [--format human|min-json|jsonl] [--db <path>]

What it does:
  - один экран состояния из SQLite: attempts (running/stale), deliveries (published), checkpoints (last)
  - печатает next_step_cmd (repair/watch/checkpoint)
`);
}

function parseSqliteDatetimeToMs(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const iso = v.includes('T') ? v : v.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFormat(opts) {
  const f = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  return f || 'human';
}

function ensureTables(db) {
  for (const t of ['attempts', 'deliveries', 'checkpoints']) {
    if (!hasTable(db, t)) fail(`sx3 doctor: таблица ${t} не найдена. Сначала выполни: ./sx3 db migrate`, 2);
  }
}

function countRunningAttempts(db) {
  const r = db.exec(`SELECT COUNT(1) AS c FROM attempts WHERE status='running';`);
  return Number(r?.[0]?.values?.[0]?.[0] || 0);
}

function countStaleAttempts(db, staleSeconds) {
  const r = db.exec(`SELECT id, heartbeat_at FROM attempts WHERE status='running' LIMIT 500;`);
  const rows = r?.[0]?.values || [];
  const nowMs = Date.now();
  let stale = 0;
  for (const row of rows) {
    const hbMs = parseSqliteDatetimeToMs(row[1]);
    const age = hbMs == null ? Infinity : (nowMs - hbMs) / 1000;
    if (age > staleSeconds) stale++;
  }
  return stale;
}

function countPublishedDeliveries(db) {
  const r = db.exec(`SELECT COUNT(1) AS c FROM deliveries WHERE status='published';`);
  return Number(r?.[0]?.values?.[0]?.[0] || 0);
}

function getLastCheckpoint(db) {
  const r = db.exec(`SELECT id, status, started_at, finished_at FROM checkpoints ORDER BY started_at DESC LIMIT 1;`);
  const row = r?.[0]?.values?.[0];
  if (!row) return null;
  return { id: row[0], status: row[1], started_at: row[2], finished_at: row[3] };
}

export async function run(opts, sub, _rest) {
  if (sub && sub !== 'help') fail(`sx3 doctor: неизвестная подкоманда: ${sub}`, 2);
  if ((opts && opts.help) || sub === 'help') {
    printHelp();
    return;
  }

  const staleRaw = opts && typeof opts['stale-seconds'] === 'string' ? String(opts['stale-seconds']) : '';
  const staleSeconds = staleRaw ? Number(staleRaw) : 45;
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) fail('sx3 doctor: --stale-seconds должен быть числом > 0', 2);

  const format = getFormat(opts);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const running = countRunningAttempts(db);
  const stale = countStaleAttempts(db, staleSeconds);
  const published = countPublishedDeliveries(db);
  const lastCp = getLastCheckpoint(db);

  const next = [];
  if (stale > 0) next.push('./sx3 watch', './sx3 repair attempt <id>');
  if (published > 0) next.push('./sx3 delivery list', './sx3 accept run --delivery <id>');
  next.push('./sx3 checkpoint run --session <id> --remote-ref <ref> --remote-confirm-sha <sha> --dry-run');

  const payload = {
    schema_version: 1,
    kind: 'sx3.doctor',
    ok: true,
    details: {
      path: dbPath,
      attempts: { running, stale, stale_seconds: staleSeconds },
      deliveries: { published },
      checkpoints: { last: lastCp },
    },
    next_step_cmd: next[0] || null,
    next_steps: next,
  };

  if (format === 'jsonl') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
    return;
  }
  if (format === 'min-json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
    return;
  }

  // human
  // eslint-disable-next-line no-console
  console.log(`[sx3 doctor] path=${dbPath}`);
  // eslint-disable-next-line no-console
  console.log(`attempts: running=${running} stale=${stale} (stale_seconds=${staleSeconds})`);
  // eslint-disable-next-line no-console
  console.log(`deliveries: published=${published}`);
  // eslint-disable-next-line no-console
  console.log(
    `checkpoints: last=${lastCp ? `${lastCp.id} status=${lastCp.status} started_at=${lastCp.started_at}` : 'none'}`,
  );
  if (next.length > 0) {
    // eslint-disable-next-line no-console
    console.log('next:');
    for (const s of next) console.log(`  - ${s}`);
  }
}

