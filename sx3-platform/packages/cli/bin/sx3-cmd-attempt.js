import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';

import { fail, inspect } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, persistDb, resolveDbPath } from './sx3-db.js';
import { storePutBundleFile } from './sx3-store.js';
import { gateDeliverablesV1, gateNoopPatch } from './sx3-gates.js';
import { printFailure } from './sx3-output.js';
import { getFormat, printOk } from './sx3-output.js';
import { Sx3CliError } from './sx3-errors.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 attempt run --session <id> --issue <L-000123> --cmd "<command>" [--cwd <dir>] [--worktree <name>]
                 [--heartbeat-seconds 15] [--publish --deliverables <file.json>] [--allow-noop] [--db <path>] [--store-dir <dir>]
                 [--attempt-id <att_...>]
  sx3 attempt run --from-plan <plan_id> --worktree <name> --cmd "<command>" [--cwd <dir>]
                 [--heartbeat-seconds 15] [--publish --deliverables <file.json>] [--allow-noop] [--db <path>] [--store-dir <dir>]
                 [--attempt-id <att_...>]
  sx3 attempt launch --from-plan <plan_id> --cmd "<command>" [--cwd <dir>] [--detach]
                    [--heartbeat-seconds 15] [--db <path>]
  sx3 attempt list [--db <path>]
  sx3 attempt show <attempt_id> [--db <path>]
  sx3 attempt tail <attempt_id> [--lines 200] [--db <path>]
  sx3 attempt cancel <attempt_id> [--db <path>]

Notes:
  - Heartbeat пишет сам runner (таймером), не зависит от вывода команды.
  - Логи складываются в XDG state: $XDG_STATE_HOME/smmtryx3/logs/attempts/<id>.log
`);
}

function getStateHome() {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || ''));
  } catch {
    return null;
  }
}

function getGitHeadSha(cwd) {
  try {
    const r = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return 'unknown';
    return String(r.stdout || '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getGitRoot(cwd) {
  try {
    const r = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    const p = String(r.stdout || '').trim();
    return p ? p : null;
  } catch {
    return null;
  }
}

function ensureAttemptTables(db) {
  if (!hasTable(db, 'attempts')) {
    fail('sx3 attempt: таблица attempts не найдена. Сначала выполни: ./sx3 db migrate', 2);
  }
}

function ensurePlansTable(db) {
  if (!hasTable(db, 'plans')) {
    fail('sx3 attempt: таблица plans не найдена. Сначала выполни: ./sx3 db migrate', 2);
  }
}

function isAttemptIdSafe(id) {
  const s = String(id || '').trim();
  return /^att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function buildRoundRobinPlanItems({ allowlist, assigns, limit }) {
  const issues = Array.isArray(allowlist) ? allowlist.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const as = Array.isArray(assigns)
    ? assigns
        .map((x) => ({
          worktree: x && typeof x === 'object' && typeof x.worktree === 'string' ? x.worktree.trim() : '',
          model: x && typeof x === 'object' && typeof x.model === 'string' ? x.model.trim() : '',
        }))
        .filter((x) => x.worktree)
    : [];
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : as.length || issues.length;
  const n = Math.min(issues.length, lim);
  /** @type {Array<{issue_id:string, worktree:string, model:string}>} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = as[i % as.length];
    out.push({ issue_id: issues[i], worktree: a.worktree, model: a.model || 'default' });
  }
  return out;
}

function resolveAttemptFromPlanOrFail({ db, planId, worktree }) {
  ensurePlansTable(db);
  const pid = String(planId || '').trim();
  const wt = String(worktree || '').trim();
  if (!pid) fail('sx3 attempt run: требуется --from-plan <plan_id>', 2);
  if (!wt) fail('sx3 attempt run: для --from-plan требуется --worktree <name>', 2);

  const res = db.exec(`SELECT id, session_id, selector_json, assigns_json FROM plans WHERE id=?;`, [pid]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 attempt run: plan не найден: ${pid}`, 2);

  const sessionId = String(row[1] || '');
  const selector = safeJsonParse(row[2]) || {};
  const assignsWrap = safeJsonParse(row[3]) || {};

  /** @type {Array<{issue_id:string, worktree:string, model:string}>|null} */
  let items = Array.isArray(selector.plan) ? selector.plan : null;
  if (!items) {
    items = buildRoundRobinPlanItems({
      allowlist: selector.allowlist,
      assigns: assignsWrap.assigns,
      limit: selector.limit,
    });
  }
  const pick = items.find((x) => x && typeof x === 'object' && String(x.worktree || '') === wt);
  if (!pick) {
    fail(`sx3 attempt run: в plan нет worktree=${wt}. next_step_cmd=./sx3 plan build ...`, 2);
  }
  const issueId = String(pick.issue_id || '').trim();
  if (!issueId) fail(`sx3 attempt run: в plan у worktree=${wt} пустой issue_id`, 2);

  return { sessionId, issueId };
}

function loadPlanItemsOrFail(db, planId) {
  ensurePlansTable(db);
  const pid = String(planId || '').trim();
  if (!pid) fail('sx3 attempt launch: требуется --from-plan <plan_id>', 2);
  const res = db.exec(`SELECT id, session_id, selector_json, assigns_json FROM plans WHERE id=?;`, [pid]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 attempt launch: plan не найден: ${pid}`, 2);

  const sessionId = String(row[1] || '');
  const selector = safeJsonParse(row[2]) || {};
  const assignsWrap = safeJsonParse(row[3]) || {};

  /** @type {Array<{issue_id:string, worktree:string, model?:string}>|null} */
  let items = Array.isArray(selector.plan) ? selector.plan : null;
  if (!items) {
    items = buildRoundRobinPlanItems({
      allowlist: selector.allowlist,
      assigns: assignsWrap.assigns,
      limit: selector.limit,
    });
  }
  if (!Array.isArray(items) || items.length === 0) fail(`sx3 attempt launch: plan пустой: ${pid}`, 2);
  return { sessionId, items };
}

function ensureDeliveryTables(db) {
  if (!hasTable(db, 'deliveries')) {
    fail('sx3 attempt publish: таблица deliveries не найдена. Сначала выполни: ./sx3 db migrate', 2);
  }
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

function getLogPathForAttempt(attemptId) {
  const logsDir = path.join(getStateHome(), 'smmtryx3', 'logs', 'attempts');
  fs.mkdirSync(logsDir, { recursive: true });
  return path.join(logsDir, `${attemptId}.log`);
}

function getGitDiff(cwd, baseSha, _resultSha, pathspec) {
  const a = String(baseSha || '').trim();
  if (!a || a === 'unknown') return null;

  // Важно: attempt может не создавать коммит. Тогда result_sha == HEAD, но изменения есть в worktree.
  // Поэтому publish строим от staged snapshot (после git add -A) относительно base_sha.
  const args = ['diff', '--cached', a];
  if (pathspec) args.push('--', String(pathspec));
  const r = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return String(r.stdout || '');
}

function buildBundleV1Zip(tmpZipPath, { meta, patchDiff, deliverablesJsonText }) {
  const zip = new AdmZip();
  zip.addFile('meta.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
  zip.addFile('patch.diff', Buffer.from(String(patchDiff || ''), 'utf8'));
  zip.addFile('deliverables.json', Buffer.from(String(deliverablesJsonText || ''), 'utf8'));
  zip.writeZip(tmpZipPath);
}

// deliverables validator lives in sx3-deliverables.js

function publishAttemptToDelivery({ opts, db, dbPath, attempt }) {
  ensureDeliveryTables(db);

  const cwd = String(attempt.cwd || '');
  const sessionId = String(attempt.session_id || '');
  const attemptId = String(attempt.id || '');
  const issueId = String(attempt.issue_id || '');
  const baseSha = String(attempt.base_sha || '');
  const resultSha = String(attempt.result_sha || '');
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) fail(`publish: не удалось определить git root для cwd=${cwd}`, 2);
  const rel = path.relative(gitRoot, cwd) || '.';
  const deliverablesPath = String(opts && typeof opts.deliverables === 'string' ? opts.deliverables : '');
  if (!deliverablesPath) fail('publish: требуется --deliverables <file.json>', 2);
  if (!fs.existsSync(deliverablesPath)) fail(`publish: deliverables не найден: ${deliverablesPath}`, 2);

  const deliverablesText = fs.readFileSync(deliverablesPath, 'utf8');
  const deliverablesObj = gateDeliverablesV1({ deliverablesText, expectedIssueId: issueId, stage: 'publish.gates.deliverables' });
  db.run(`UPDATE attempts SET deliverables_json=? WHERE id=?;`, [JSON.stringify(deliverablesObj), attemptId]);

  // Stage changes only under attempt cwd subtree (avoid staging unrelated repo changes).
  const addRes = childProcess.spawnSync('git', ['add', '-A', '--', rel], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (addRes.status !== 0) {
    fail(`publish: git add -A failed: ${String(addRes.stderr || '').trim()}`, 2);
  }

  const patchDiff = getGitDiff(gitRoot, baseSha, resultSha, rel);
  if (patchDiff == null) fail('publish: не удалось получить git diff (base/result sha). Проверь что cwd — git repo и sha валидны', 2);

  // Gates v1
  gateNoopPatch({ patchText: patchDiff, allowNoop: Boolean(opts && opts['allow-noop']), stage: 'publish.gates.noop' });

  // Best-effort: вернуть индекс в исходное состояние только для этого pathspec.
  childProcess.spawnSync('git', ['reset', '--', rel], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const tmpDir = path.join(getStateHome(), 'smmtryx3', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpZipPath = path.join(tmpDir, `bundle_${attemptId}_${Date.now()}.zip`);

  const meta = {
    schema_version: 1,
    project_id: deliverablesObj.project_id || null,
    session_id: sessionId,
    attempt_id: attemptId,
    issue_id: issueId,
    base_sha: baseSha,
    result_sha: resultSha,
    created_at: new Date().toISOString(),
  };

  buildBundleV1Zip(tmpZipPath, { meta, patchDiff, deliverablesJsonText: JSON.stringify(deliverablesObj, null, 2) });
  const put = storePutBundleFile(opts, tmpZipPath);

  const deliveryId = `del_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO deliveries(
       id, attempt_id, status, created_at,
       patch_uri, patch_sha256, patch_size,
       deliverables_json, summary_json
     ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, NULL);`,
    [deliveryId, attemptId, 'published', put.uri, put.sha256, put.size, JSON.stringify(deliverablesObj)],
  );

  insertEvent(db, 'delivery.created', {
    session_id: sessionId,
    attempt_id: attemptId,
    delivery_id: deliveryId,
    patch_uri: put.uri,
  });
  persistDb(db, dbPath);

  try {
    fs.unlinkSync(tmpZipPath);
  } catch {
    // ignore
  }

  return { deliveryId, patchUri: put.uri, patchSha256: put.sha256, patchSize: put.size };
}

async function cmdRun(opts) {
  try {
    const cmd = opts && typeof opts.cmd === 'string' ? String(opts.cmd) : '';
    const cwd = opts && typeof opts.cwd === 'string' ? path.resolve(String(opts.cwd)) : process.cwd();
    const worktree =
      opts && typeof opts.worktree === 'string'
        ? String(opts.worktree)
        : path.basename(cwd || '').trim() || 'default';

    const hbRaw = opts && typeof opts['heartbeat-seconds'] === 'string' ? String(opts['heartbeat-seconds']) : '';
    const heartbeatSeconds = hbRaw ? Number(hbRaw) : 15;
    if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0) {
      fail('sx3 attempt run: --heartbeat-seconds должен быть числом > 0', 2);
    }

    if (!cmd) fail('sx3 attempt run: требуется --cmd "<command>"', 2);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`sx3 attempt run: cwd не найден: ${cwd}`, 2);

    const dbPath = resolveDbPath(opts);
    const { db } = await openDb(dbPath);
    ensureSchemaMigrations(db);
    ensureAttemptTables(db);

    const fromPlanId = opts && typeof opts['from-plan'] === 'string' ? String(opts['from-plan']) : '';
    let sessionId = opts && typeof opts.session === 'string' ? String(opts.session) : '';
    let issueId = opts && typeof opts.issue === 'string' ? String(opts.issue) : '';
    const attemptIdFromFlag = opts && typeof opts['attempt-id'] === 'string' ? String(opts['attempt-id']).trim() : '';
    if (fromPlanId) {
      const resolved = resolveAttemptFromPlanOrFail({ db, planId: fromPlanId, worktree });
      sessionId = resolved.sessionId;
      issueId = resolved.issueId;
    }
    if (!sessionId) fail('sx3 attempt run: требуется --session <id> (или --from-plan <plan_id>)', 2);
    if (!issueId) fail('sx3 attempt run: требуется --issue <L-000123> (или --from-plan <plan_id>)', 2);

    const attemptId = attemptIdFromFlag ? attemptIdFromFlag : `att_${crypto.randomUUID()}`;
    if (attemptIdFromFlag && !isAttemptIdSafe(attemptIdFromFlag)) {
      fail('sx3 attempt run: --attempt-id должен быть вида att_<uuid>', 2);
    }
    const baseSha = getGitHeadSha(cwd);
    const logPath = getLogPathForAttempt(attemptId);

    const diagnostics = {
      cwd,
      cmd,
      log_path: logPath,
      heartbeat_seconds: heartbeatSeconds,
      base_sha_source: baseSha === 'unknown' ? 'unknown' : 'git',
      ...(fromPlanId ? { plan_id: fromPlanId } : {}),
    };

    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[sx3 attempt run] started_at=${new Date().toISOString()} cwd=${cwd}\n`);
    logStream.write(`[sx3 attempt run] cmd=${cmd}\n`);

    const child = childProcess.spawn('bash', ['-lc', cmd], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) fail('sx3 attempt run: не удалось запустить процесс', 2);

    child.stdout.on('data', (buf) => {
      logStream.write(buf);
      process.stdout.write(buf);
    });
    child.stderr.on('data', (buf) => {
      logStream.write(buf);
      process.stderr.write(buf);
    });

    db.run(
      `INSERT INTO attempts(
         id, session_id, issue_id, worktree, status,
         base_sha, started_at, pid, heartbeat_at,
         ok, diagnostics_json
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), NULL, ?);`,
      [attemptId, sessionId, issueId, worktree, 'running', baseSha, child.pid, JSON.stringify(diagnostics)],
    );
    insertEvent(db, 'attempt.started', { session_id: sessionId, attempt_id: attemptId, issue_id: issueId, worktree });
    persistDb(db, dbPath);

    let stopped = false;
    const tickMs = Math.floor(heartbeatSeconds * 1000);
    const timer = setInterval(() => {
      if (stopped) return;
      try {
        db.run(`UPDATE attempts SET heartbeat_at=datetime('now') WHERE id=?;`, [attemptId]);
        persistDb(db, dbPath);
      } catch (e) {
        const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(`[sx3 attempt run] WARN: heartbeat persist failed: ${msg}`);
      }
    }, tickMs);
    timer.unref?.();

    const finalize = (status, exitCode, ok, resultSha) => {
      stopped = true;
      clearInterval(timer);
      db.run(
        `UPDATE attempts
         SET status=?,
             finished_at=datetime('now'),
             heartbeat_at=datetime('now'),
             exit_code=?,
             ok=?,
             result_sha=?
         WHERE id=?;`,
        [
          status,
          exitCode == null ? null : Number(exitCode),
          ok == null ? null : ok ? 1 : 0,
          resultSha ? String(resultSha) : null,
          attemptId,
        ],
      );
      insertEvent(db, 'attempt.finished', {
        session_id: sessionId,
        attempt_id: attemptId,
        status,
        exit_code: exitCode,
        ok: ok ? 1 : 0,
      });
      persistDb(db, dbPath);
      logStream.write(`[sx3 attempt run] finished_at=${new Date().toISOString()} status=${status} exit_code=${exitCode}\n`);
      logStream.end();
    };

    const cancel = (reason, exitCode) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    db.run(
      `UPDATE attempts
       SET status='cancelled',
           finished_at=datetime('now'),
           heartbeat_at=datetime('now'),
           exit_code=?,
           ok=0
       WHERE id=?;`,
      [exitCode == null ? null : Number(exitCode), attemptId],
    );
    insertEvent(db, 'attempt.cancelled', { session_id: sessionId, attempt_id: attemptId, reason });
    persistDb(db, dbPath);
    logStream.write(`[sx3 attempt run] cancelled_at=${new Date().toISOString()} reason=${reason}\n`);
    logStream.end();
    };

    const onSigint = () => {
      cancel('SIGINT', 130);
      process.exit(130);
    };
    const onSigterm = () => {
      cancel('SIGTERM', 143);
      process.exit(143);
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    const exitCode = await new Promise((resolve) => {
      child.on('close', (code, signal) => {
        if (typeof code === 'number') return resolve(code);
        if (signal === 'SIGINT') return resolve(130);
        if (signal === 'SIGTERM') return resolve(143);
        return resolve(1);
      });
    });

    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);

    const resultSha = getGitHeadSha(cwd);
    const status = exitCode === 130 || exitCode === 143 ? 'cancelled' : 'finished';
    finalize(status, exitCode, exitCode === 0, resultSha);

    let publishInfo = null;
    if (exitCode === 0 && opts && opts.publish) {
      const res = db.exec(
        `SELECT id, session_id, issue_id, base_sha, result_sha, diagnostics_json
         FROM attempts
         WHERE id=?;`,
        [attemptId],
      );
      const row = res?.[0]?.values?.[0];
      const diagJson = row?.[5];
      const diag = safeJsonParse(diagJson) || {};
      publishInfo = publishAttemptToDelivery({
        opts,
        db,
        dbPath,
        attempt: {
          id: row?.[0],
          session_id: row?.[1],
          issue_id: row?.[2],
          base_sha: row?.[3],
          result_sha: row?.[4],
          cwd: diag.cwd || cwd,
        },
      });
      // eslint-disable-next-line no-console
      if (getFormat(opts) === 'human') {
        console.log(
          `[sx3 attempt publish] ok=1 attempt_id=${attemptId} delivery_id=${publishInfo.deliveryId} patch_uri=${publishInfo.patchUri}`,
        );
      }
    }

    printOk(
      opts,
      {
        kind: 'sx3.attempt.run',
        ok: exitCode === 0,
        attempt_id: attemptId,
        session_id: sessionId,
        issue_id: issueId,
        worktree,
        status,
        exit_code: exitCode,
        log_path: logPath,
        db: dbPath,
        publish: publishInfo
          ? { delivery_id: publishInfo.deliveryId, patch_uri: publishInfo.patchUri, patch_sha256: publishInfo.patchSha256 }
          : null,
      },
      `[sx3 attempt run] ok=${exitCode === 0 ? 1 : 0} attempt_id=${attemptId} exit_code=${exitCode} log=${logPath} db=${dbPath}`,
    );
    process.exit(exitCode);
  } catch (e) {
    printFailure(opts, e, 'sx3 attempt run failed', 2);
  }
}

async function cmdLaunch(opts) {
  const cmd = opts && typeof opts.cmd === 'string' ? String(opts.cmd) : '';
  if (!cmd) fail('sx3 attempt launch: требуется --cmd "<command>"', 2);
  const cwd = opts && typeof opts.cwd === 'string' ? path.resolve(String(opts.cwd)) : process.cwd();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`sx3 attempt launch: cwd не найден: ${cwd}`, 2);

  const hbRaw = opts && typeof opts['heartbeat-seconds'] === 'string' ? String(opts['heartbeat-seconds']) : '';
  const heartbeatSeconds = hbRaw ? Number(hbRaw) : 15;
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds <= 0) fail('sx3 attempt launch: --heartbeat-seconds должен быть числом > 0', 2);

  const planId = opts && typeof opts['from-plan'] === 'string' ? String(opts['from-plan']) : '';
  const detach = Boolean(opts && opts.detach);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureAttemptTables(db);
  ensurePlansTable(db);

  const { sessionId, items } = loadPlanItemsOrFail(db, planId);

  /** @type {Array<{attempt_id:string, worktree:string, issue_id:string}>} */
  const launched = [];

  // Запускаем из текущего CLI процесса через node smmtryx3.js, чтобы не зависеть от pnpm.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const smmtry = path.resolve(here, 'smmtryx3.js');

  for (const it of items) {
    const issueId = String(it.issue_id || '').trim();
    const worktree = String(it.worktree || '').trim();
    if (!issueId || !worktree) continue;
    const attemptId = `att_${crypto.randomUUID()}`;

    const args = [
      smmtry,
      'attempt',
      'run',
      '--attempt-id',
      attemptId,
      '--session',
      sessionId,
      '--issue',
      issueId,
      '--worktree',
      worktree,
      '--cmd',
      cmd,
      '--cwd',
      cwd,
      '--heartbeat-seconds',
      String(heartbeatSeconds),
    ];
    if (planId) args.push('--from-plan', planId);
    if (opts && typeof opts.db === 'string') args.push('--db', String(opts.db));

    const child = childProcess.spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: detach ? 'ignore' : 'inherit',
      detached: detach,
      env: process.env,
    });
    if (detach) child.unref?.();
    if (!detach) {
      // sequential: wait so output is readable
      const code = await new Promise((resolve) => child.on('exit', (c) => resolve(typeof c === 'number' ? c : 1)));
      if (code !== 0) {
        throw new Sx3CliError({
          stage: 'attempt.launch',
          reason: 'child_failed',
          next_step_cmd: `./sx3 attempt run --session ${sessionId} --issue ${issueId} --worktree ${worktree} --cmd "<cmd>"`,
          details: { exit_code: code, issue_id: issueId, worktree, plan_id: planId },
        });
      }
    }
    launched.push({ attempt_id: attemptId, worktree, issue_id: issueId });
  }

  printOk(
    opts,
    { kind: 'sx3.attempt.launch', ok: true, plan_id: planId, session_id: sessionId, detach: detach ? 1 : 0, launched },
    `[sx3 attempt launch] ok=1 plan_id=${planId} session=${sessionId} detach=${detach ? 1 : 0} launched=${launched.length}`,
  );
}

async function cmdList(opts) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureAttemptTables(db);

  const res = db.exec(
    `SELECT id, session_id, issue_id, worktree, status, started_at, finished_at, exit_code, ok, heartbeat_at
     FROM attempts
     ORDER BY started_at DESC
     LIMIT 50;`,
  );
  const rows = res?.[0]?.values || [];
  // eslint-disable-next-line no-console
  console.log(`[sx3 attempt list] path=${dbPath} count=${rows.length}`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `- id=${r[0]}`,
        `session=${r[1]}`,
        `issue=${r[2]}`,
        `wt=${r[3]}`,
        `status=${r[4]}`,
        `started_at=${r[5]}`,
        `finished_at=${r[6] || ''}`,
        `exit_code=${r[7] == null ? '' : r[7]}`,
        `ok=${r[8] == null ? '' : r[8]}`,
        `heartbeat_at=${r[9] || ''}`,
      ].join(' '),
    );
  }
}

async function cmdShow(opts, rest) {
  const id = String(rest[0] || '');
  if (!id) fail('sx3 attempt show: требуется <attempt_id>', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureAttemptTables(db);

  const res = db.exec(`SELECT * FROM attempts WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 attempt show: attempt не найден: ${id}`, 2);
  const cols = res[0].columns;
  /** @type {Record<string, unknown>} */
  const obj = {};
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
  // eslint-disable-next-line no-console
  console.log(inspect(obj));
}

async function cmdTail(opts, rest) {
  const id = String(rest[0] || '');
  if (!id) fail('sx3 attempt tail: требуется <attempt_id>', 2);

  const linesRaw = opts && typeof opts.lines === 'string' ? String(opts.lines) : '';
  const lines = linesRaw ? Number(linesRaw) : 200;
  if (!Number.isFinite(lines) || lines <= 0) fail('sx3 attempt tail: --lines должен быть числом > 0', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureAttemptTables(db);

  const res = db.exec(`SELECT diagnostics_json FROM attempts WHERE id=?;`, [id]);
  const diag = res?.[0]?.values?.[0]?.[0];
  const parsed = safeJsonParse(diag);
  const logPath = parsed && typeof parsed.log_path === 'string' ? String(parsed.log_path) : '';
  if (!logPath) fail(`sx3 attempt tail: у attempt нет diagnostics.log_path: ${id}`, 2);
  if (!fs.existsSync(logPath)) fail(`sx3 attempt tail: log не найден: ${logPath}`, 2);

  const data = fs.readFileSync(logPath, 'utf8');
  const all = data.split('\n');
  const tail = all.slice(Math.max(0, all.length - lines));
  // eslint-disable-next-line no-console
  console.log(tail.join('\n'));
}

async function cmdCancel(opts, rest) {
  const id = String(rest[0] || '');
  if (!id) fail('sx3 attempt cancel: требуется <attempt_id>', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureAttemptTables(db);

  const res = db.exec(`SELECT pid, status, session_id FROM attempts WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 attempt cancel: attempt не найден: ${id}`, 2);
  const pid = row[0];
  const status = String(row[1] || '');
  const sessionId = String(row[2] || '');

  if (!pid) fail(`sx3 attempt cancel: у attempt нет pid (status=${status})`, 2);

  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch (e) {
    const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
    fail(`sx3 attempt cancel: не удалось послать SIGTERM pid=${pid}: ${msg}`, 2);
  }

  db.run(
    `UPDATE attempts
     SET status='cancelled',
         finished_at=datetime('now'),
         heartbeat_at=datetime('now'),
         ok=0
     WHERE id=?;`,
    [id],
  );
  insertEvent(db, 'attempt.cancelled', { session_id: sessionId, attempt_id: id, reason: 'cancel cmd' });
  persistDb(db, dbPath);
  // eslint-disable-next-line no-console
  console.log(`[sx3 attempt cancel] ok=1 attempt_id=${id} pid=${pid}`);
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  if (sub === 'run') return cmdRun(opts);
  if (sub === 'launch') return cmdLaunch(opts);
  if (sub === 'list') return cmdList(opts);
  if (sub === 'show') return cmdShow(opts, rest);
  if (sub === 'tail') return cmdTail(opts, rest);
  if (sub === 'cancel') return cmdCancel(opts, rest);

  fail(`sx3 attempt: неизвестная подкоманда: ${sub}`, 2);
}

