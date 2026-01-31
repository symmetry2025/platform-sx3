import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, resolveDbPath } from './sx3-db.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 watch [--stale-seconds 45] [--format human|min-json|jsonl] [--db <path>]

What it does:
  - показывает running attempts и возраст heartbeat
  - помечает stale (heartbeat слишком старый)
  - печатает next_step_cmd для repair
`);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ''));
  } catch {
    return null;
  }
}

function parseSqliteDatetimeToMs(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  // sqlite datetime('now') -> "YYYY-MM-DD HH:MM:SS"
  const iso = v.includes('T') ? v : v.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getFormat(opts) {
  const f = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  return f || 'human';
}

function ensureTables(db) {
  if (!hasTable(db, 'attempts')) fail('sx3 watch: таблица attempts не найдена. Сначала выполни: ./sx3 db migrate', 2);
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

export async function run(opts, sub, _rest) {
  if (sub && sub !== 'help') fail(`sx3 watch: неизвестная подкоманда: ${sub}`, 2);
  if ((opts && opts.help) || sub === 'help') {
    printHelp();
    return;
  }

  const staleRaw = opts && typeof opts['stale-seconds'] === 'string' ? String(opts['stale-seconds']) : '';
  const staleSeconds = staleRaw ? Number(staleRaw) : 45;
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) fail('sx3 watch: --stale-seconds должен быть числом > 0', 2);

  const format = getFormat(opts);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const res = db.exec(
    `SELECT id, session_id, issue_id, worktree, status, started_at, heartbeat_at, pid, diagnostics_json
     FROM attempts
     WHERE status='running'
     ORDER BY started_at DESC
     LIMIT 200;`,
  );
  const rows = res?.[0]?.values || [];
  const nowMs = Date.now();

  const items = rows.map((r) => {
    const id = String(r[0] || '');
    const hbMs = parseSqliteDatetimeToMs(r[6]);
    const hbAgeSec = hbMs == null ? null : Math.floor((nowMs - hbMs) / 1000);
    const diag = safeJsonParse(r[8]) || {};
    const alive = pidAlive(r[7]);
    const stale = hbAgeSec != null ? hbAgeSec > staleSeconds : true;
    return {
      id,
      session_id: r[1],
      issue_id: r[2],
      worktree: r[3],
      status: r[4],
      started_at: r[5],
      heartbeat_at: r[6],
      heartbeat_age_seconds: hbAgeSec,
      pid: r[7],
      pid_alive: alive ? 1 : 0,
      stale: stale ? 1 : 0,
      cmd: typeof diag.cmd === 'string' ? diag.cmd : null,
      cwd: typeof diag.cwd === 'string' ? diag.cwd : null,
      next_step_cmd: stale ? `./sx3 repair attempt ${id}` : null,
    };
  });

  const staleCount = items.filter((x) => x.stale === 1).length;

  if (format === 'jsonl') {
    for (const it of items) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ kind: 'sx3.watch.attempt', ...it }));
    }
    return;
  }

  if (format === 'min-json') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        schema_version: 1,
        kind: 'sx3.watch',
        ok: true,
        details: { path: dbPath, running: items.length, stale: staleCount, stale_seconds: staleSeconds },
      }),
    );
    return;
  }

  // human
  // eslint-disable-next-line no-console
  console.log(`[sx3 watch] path=${dbPath} running=${items.length} stale=${staleCount} stale_seconds=${staleSeconds}`);
  for (const it of items) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `- id=${it.id}`,
        `session=${it.session_id}`,
        `issue=${it.issue_id}`,
        `wt=${it.worktree}`,
        `pid=${it.pid}`,
        `pid_alive=${it.pid_alive}`,
        `hb_age_s=${it.heartbeat_age_seconds == null ? '' : it.heartbeat_age_seconds}`,
        `stale=${it.stale}`,
        it.next_step_cmd ? `next=${it.next_step_cmd}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}

