import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, openDb, persistDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 repair attempt <attempt_id> [--db <path>]

What it does:
  - если pid жив: SIGTERM + помечает attempt cancelled
  - если pid не жив: помечает attempt finished ok=0 (orphan)
`);
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

function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

async function repairAttempt(opts, attemptId) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);

  const res = db.exec(`SELECT id, session_id, status, pid FROM attempts WHERE id=?;`, [attemptId]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 repair attempt: attempt не найден: ${attemptId}`, 2);

  const sessionId = String(row[1] || '');
  const status = String(row[2] || '');
  const pid = row[3];

  const alive = pidAlive(pid);

  if (alive) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch (e) {
      const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
      fail(`sx3 repair attempt: не удалось послать SIGTERM pid=${pid}: ${msg}`, 2);
    }
    db.run(
      `UPDATE attempts
       SET status='cancelled',
           finished_at=datetime('now'),
           heartbeat_at=datetime('now'),
           ok=0,
           exit_code=143
       WHERE id=?;`,
      [attemptId],
    );
    insertEvent(db, 'attempt.repair.cancelled', { session_id: sessionId, attempt_id: attemptId, prev_status: status });
    persistDb(db, dbPath);
    // eslint-disable-next-line no-console
    console.log(`[sx3 repair attempt] ok=1 action=SIGTERM attempt_id=${attemptId} pid=${pid} prev_status=${status}`);
    return;
  }

  // orphan: процесса нет, но attempt ещё running
  db.run(
    `UPDATE attempts
     SET status='finished',
         finished_at=datetime('now'),
         heartbeat_at=datetime('now'),
         ok=0,
         exit_code=NULL
     WHERE id=?;`,
    [attemptId],
  );
  insertEvent(db, 'attempt.repair.orphaned', { session_id: sessionId, attempt_id: attemptId, prev_status: status, pid });
  persistDb(db, dbPath);
  // eslint-disable-next-line no-console
  console.log(
    `[sx3 repair attempt] ok=1 action=mark_orphan attempt_id=${attemptId} pid=${pid == null ? '' : pid} prev_status=${status}`,
  );
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  if (sub === 'attempt') {
    const attemptId = String(rest[0] || '');
    if (!attemptId) fail('sx3 repair attempt: требуется <attempt_id>', 2);
    return repairAttempt(opts, attemptId);
  }

  fail(`sx3 repair: неизвестная подкоманда: ${sub}`, 2);
}

