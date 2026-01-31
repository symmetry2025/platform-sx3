import crypto from 'node:crypto';

import { fail, inspect } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, persistDb, resolveDbPath } from './sx3-db.js';
import { getGitRoot, getWorktrees, git, isGitRepo, relation, revParse, workingTreePorcelain } from './sx3-git.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 checkpoint run [--session <id>]
                    [--cwd <path>]
                    [--remote-ref <ref>] [--fetch]
                    --remote-confirm-sha <sha>
                    [--dry-run | --apply]
                    [--allow-dirty]
                    [--allow-active-attempts]
                    [--format human|min-json|jsonl]
                    [--db <path>]
  sx3 checkpoint show <checkpoint_id> [--db <path>]

Notes:
  - По умолчанию режим безопасный: dry-run (ничего не меняет).
  - Sync запрещён без --remote-confirm-sha (guard против опасного reset/push).
  - --remote-ref может быть локальным ref (например HEAD) — удобно для dev без origin.
  - Если --session не указан, берём последнюю open session из SQLite.
  - В apply-режиме checkpoint пушит session/<id> в remote и затем синхронизирует worktrees к подтверждённому sha.
  - В apply-режиме checkpoint по умолчанию запрещён при активных attempts (runner работает) — можно override флагом --allow-active-attempts.
`);
}

function ensureTables(db) {
  if (!hasTable(db, 'checkpoints')) fail('sx3 checkpoint: таблица checkpoints не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'events')) fail('sx3 checkpoint: таблица events не найдена. Сначала выполни: ./sx3 db migrate', 2);
}

function ensureSessionsTable(db) {
  if (!hasTable(db, 'sessions')) fail('sx3 checkpoint: таблица sessions не найдена. Сначала выполни: ./sx3 db migrate', 2);
}

function ensureAttemptsTable(db) {
  if (!hasTable(db, 'attempts')) fail('sx3 checkpoint: таблица attempts не найдена. Сначала выполни: ./sx3 db migrate', 2);
}

function getFormat(opts) {
  const f = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  return f || 'human';
}

function checkpointFail(opts, payload) {
  const format = getFormat(opts);
  if (format === 'min-json' || format === 'jsonl') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        schema_version: 1,
        kind: 'sx3.checkpoint.run',
        ok: false,
        stage: payload.stage || 'checkpoint',
        reason: payload.reason || 'unknown',
        next_step_cmd: payload.next_step_cmd || null,
        details: payload.details || null,
      }),
    );
    process.exit(2);
  }
  fail(payload.message || payload.reason || 'checkpoint failed', 2);
}

function checkpointOk(opts, payload) {
  const format = getFormat(opts);
  if (format === 'jsonl') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ schema_version: 1, kind: 'sx3.checkpoint.run', ok: true, ...payload }));
    return;
  }
  if (format === 'min-json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ schema_version: 1, kind: 'sx3.checkpoint.run', ok: true, details: payload }));
    return;
  }
  // human output is printed by caller
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

function getCwd(opts) {
  return opts && typeof opts.cwd === 'string' ? String(opts.cwd) : process.cwd();
}

function getRemoteRef(opts, sessionId) {
  const rr = opts && typeof opts['remote-ref'] === 'string' ? String(opts['remote-ref']) : '';
  if (rr) return rr;
  // пока нет session open — default максимально безопасный: не трогаем origin, работаем от HEAD.
  return sessionId ? `origin/session/${sessionId}` : 'HEAD';
}

function mustRemoteConfirmSha(opts) {
  const s = opts && typeof opts['remote-confirm-sha'] === 'string' ? String(opts['remote-confirm-sha']).trim() : '';
  if (!s) {
    checkpointFail(opts, {
      stage: 'checkpoint.guard',
      reason: 'remote_confirm_required',
      message: 'sx3 checkpoint run: требуется --remote-confirm-sha <sha> (guard)',
      next_step_cmd: './sx3 checkpoint run --session <id> --remote-ref <ref> --remote-confirm-sha <sha> --dry-run',
    });
  }
  return s;
}

function shouldApply(opts) {
  const apply = Boolean(opts && opts.apply);
  const dryRunFlag = Boolean(opts && opts['dry-run']);
  if (apply && dryRunFlag) fail('sx3 checkpoint run: нельзя одновременно --apply и --dry-run', 2);
  return apply; // default false => dry-run
}

function localSessionBranch(sessionId) {
  return `session/${String(sessionId)}`;
}

function ensureLocalSessionBranch({ gitRoot, sessionId, apply }) {
  const b = localSessionBranch(sessionId);
  const sha = revParse(b, { cwd: gitRoot });
  if (sha) return sha;
  if (!apply) return null;
  // create local session branch pointing to HEAD
  const head = revParse('HEAD', { cwd: gitRoot });
  if (!head) throw new Error('head_unreadable');
  git(['branch', b, head], { cwd: gitRoot, allowFailure: false });
  const sha2 = revParse(b, { cwd: gitRoot });
  return sha2 || null;
}

function pushSessionBranch({ gitRoot, remoteRef, sessionBranch, apply }) {
  if (!apply) return;
  if (!isRemoteRefLike(remoteRef)) return;
  const [remoteName, ...rest] = String(remoteRef).split('/');
  const remoteBranch = rest.join('/');
  if (!remoteName || !remoteBranch) throw new Error(`bad_remote_ref: ${remoteRef}`);
  // push local sessionBranch -> remoteBranch
  git(['push', remoteName, `${sessionBranch}:${remoteBranch}`], { cwd: gitRoot, allowFailure: false });
  git(['fetch', remoteName], { cwd: gitRoot, allowFailure: false });
}

function isDirtyRepo({ gitRoot }) {
  const porcelain = workingTreePorcelain({ cwd: gitRoot });
  if (porcelain == null) return true;
  return porcelain.trim().length > 0;
}

function isRemoteRefLike(s) {
  const v = String(s || '');
  // crude: "origin/main" or "origin/session/x"
  return v.includes('/') && !v.startsWith('refs/');
}

function fetchIfRequested({ gitRoot, remoteRef, doFetch }) {
  if (!doFetch) return;
  // if remoteRef looks like remote ref (origin/...), fetch the remote name.
  const parts = String(remoteRef).split('/');
  const remoteName = parts[0];
  if (!remoteName) return;
  git(['fetch', remoteName], { cwd: gitRoot, allowFailure: false });
}

function syncWorktrees({ gitRoot, targetSha, allowDirty, apply }) {
  const wts = getWorktrees({ cwd: gitRoot });
  /** @type {any[]} */
  const report = [];
  for (const wt of wts) {
    const wtPath = wt.path;
    if (!wtPath) continue;
    const porcelain = workingTreePorcelain({ cwd: wtPath });
    const dirty = porcelain == null ? true : porcelain.trim().length > 0;
    if (dirty && !allowDirty) {
      report.push({ path: wtPath, ok: 0, skipped: 1, reason: 'dirty', target_sha: targetSha });
      continue;
    }
    if (!apply) {
      report.push({ path: wtPath, ok: 1, dry_run: 1, target_sha: targetSha });
      continue;
    }
    // Hard reset each worktree to target sha (safe only under allowDirty/clean).
    git(['reset', '--hard', targetSha], { cwd: wtPath, allowFailure: false });
    report.push({ path: wtPath, ok: 1, applied: 1, target_sha: targetSha });
  }
  return report;
}

async function cmdRun(opts) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);
  ensureSessionsTable(db);
  ensureAttemptsTable(db);

  let sessionId = opts && typeof opts.session === 'string' ? String(opts.session) : '';
  if (!sessionId) {
    const r = db.exec(`SELECT id FROM sessions WHERE status='open' ORDER BY created_at DESC LIMIT 1;`);
    const id = r?.[0]?.values?.[0]?.[0];
    sessionId = id ? String(id) : '';
  }
  if (!sessionId) {
    checkpointFail(opts, {
      stage: 'checkpoint.args',
      reason: 'no_open_session',
      message: 'не найдена open session (и --session не указан)',
      next_step_cmd: './sx3 session open --project <id>',
    });
  }

  const apply = shouldApply(opts);
  const allowActiveAttempts = Boolean(opts && opts['allow-active-attempts']);
  const runningRes = db.exec(`SELECT COUNT(1) AS c FROM attempts WHERE session_id=? AND status='running';`, [sessionId]);
  const runningCount = Number(runningRes?.[0]?.values?.[0]?.[0] || 0);
  if (apply && runningCount > 0 && !allowActiveAttempts) {
    checkpointFail(opts, {
      stage: 'checkpoint.guard',
      reason: 'active_attempts',
      message: `есть активные attempts (running=${runningCount}) — checkpoint --apply запрещён`,
      next_step_cmd: './sx3 watch  # дождись завершения или repair stuck attempts',
      details: { running: runningCount, session_id: sessionId },
    });
  }

  const cwd = getCwd(opts);
  if (!isGitRepo(cwd)) checkpointFail(opts, { stage: 'checkpoint.git', reason: 'not_git_repo', message: `cwd не является git repo: ${cwd}` });
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) checkpointFail(opts, { stage: 'checkpoint.git', reason: 'git_root_not_found', message: `не удалось определить git root для cwd=${cwd}` });

  const remoteRef = getRemoteRef(opts, sessionId);
  const doFetch = Boolean(opts && (opts.fetch || isRemoteRefLike(remoteRef)));
  fetchIfRequested({ gitRoot, remoteRef, doFetch });

  const sessionBranch = localSessionBranch(sessionId);
  let localSessionSha = ensureLocalSessionBranch({ gitRoot, sessionId, apply });
  const localSessionBranchMissing = !localSessionSha;
  if (!localSessionSha) {
    // In dry-run, still proceed using HEAD as a stand-in, but instruct how to create the branch.
    const head = revParse('HEAD', { cwd: gitRoot });
    if (!head) checkpointFail(opts, { stage: 'checkpoint.git', reason: 'head_unreadable', message: 'не удалось прочитать HEAD' });
    localSessionSha = head;
  }

  const remoteHead = revParse(remoteRef, { cwd: gitRoot });
  if (!remoteHead) {
    checkpointFail(opts, {
      stage: 'checkpoint.git',
      reason: 'remote_ref_unreadable',
      message: `не удалось прочитать remote-ref=${remoteRef}. Подсказка: попробуй --remote-ref HEAD (dev) или --fetch`,
      next_step_cmd: `./sx3 checkpoint run --session ${sessionId} --remote-ref HEAD --remote-confirm-sha ${localSessionSha} --dry-run`,
      details: { remote_ref: remoteRef },
    });
  }

  const confirm = mustRemoteConfirmSha(opts);
  if (confirm !== remoteHead) {
    checkpointFail(opts, {
      stage: 'checkpoint.guard',
      reason: 'remote_confirm_mismatch',
      message: `remote-confirm-sha mismatch (current=${remoteHead}, got=${confirm})`,
      next_step_cmd: `./sx3 checkpoint run --session ${sessionId} --remote-ref ${remoteRef} --remote-confirm-sha ${remoteHead} --dry-run`,
      details: { current_remote_sha: remoteHead, provided: confirm, remote_ref: remoteRef },
    });
  }

  const allowDirty = Boolean(opts && opts['allow-dirty']);

  if (!allowDirty && isDirtyRepo({ gitRoot })) {
    checkpointFail(opts, {
      stage: 'checkpoint.guard',
      reason: 'repo_dirty',
      message: 'repo dirty (есть изменения/неотслеживаемые файлы). Либо приведи в clean состояние, либо явно --allow-dirty.',
      next_step_cmd: `./sx3 checkpoint run --session ${sessionId} --remote-ref ${remoteRef} --remote-confirm-sha ${remoteHead} --dry-run --allow-dirty`,
    });
  }

  const checkpointId = `chkpt_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO checkpoints(id, session_id, status, started_at, finished_at, session_head_sha_local, session_head_sha_remote, synced_worktrees_json, report_json)
     VALUES (?, ?, 'running', datetime('now'), NULL, ?, ?, NULL, NULL);`,
    [checkpointId, sessionId, localSessionSha, remoteHead],
  );
  insertEvent(db, 'checkpoint.started', { session_id: sessionId, checkpoint_id: checkpointId, local: localSessionSha, remote: remoteHead });
  persistDb(db, dbPath);

  /** @type {any} */
  const report = {
    git_root: gitRoot,
    cwd,
    remote_ref: remoteRef,
    local_session_branch: sessionBranch,
    local_session_sha: localSessionSha,
    local_session_branch_missing: localSessionBranchMissing ? 1 : 0,
    remote_head: remoteHead,
    apply: apply ? 1 : 0,
    allow_dirty: allowDirty ? 1 : 0,
    allow_active_attempts: allowActiveAttempts ? 1 : 0,
    running_attempts: runningCount,
    actions: [],
  };

  try {
    const rel = relation(localSessionSha, remoteHead, { cwd: gitRoot });
    report.relation = rel.kind;

    // Policy engine v1 (from master plan)
    if (rel.kind === 'diverged') {
      throw new Error(
        `diverged: local=${localSessionSha} remote=${remoteHead}. next_step_cmd=git -C "${gitRoot}" log --oneline --decorate --graph --boundary --left-right ${remoteHead}...${localSessionSha}`,
      );
    }

    let targetSha = remoteHead;

    if (rel.kind === 'equal') {
      report.actions.push({ kind: 'noop', note: 'local==remote' });
      targetSha = remoteHead;
    }

    if (rel.kind === 'ahead-only') {
      // fast push local to the remote ref (if it exists and is remote-ish)
      report.actions.push({ kind: 'push', from: localSessionSha, to_ref: remoteRef, from_branch: sessionBranch });
      if (apply) {
        if (!isRemoteRefLike(remoteRef)) {
          // dev mode: no push
        } else {
          pushSessionBranch({ gitRoot, remoteRef, sessionBranch, apply });
          const newRemote = revParse(remoteRef, { cwd: gitRoot });
          if (!newRemote || newRemote !== localSessionSha) {
            throw new Error(`remote_verify_failed: expected ${localSessionSha}, got ${newRemote || 'null'}`);
          }
        }
      }
      targetSha = localSessionSha;
    }

    if (rel.kind === 'behind-only') {
      report.actions.push({ kind: 'reset_to_remote', to: remoteHead });
      if (!apply) {
        // ok in dry-run
      } else {
        // Safe fast-forward of the session branch ref to remote.
        git(['update-ref', `refs/heads/${sessionBranch}`, remoteHead], { cwd: gitRoot, allowFailure: false });
      }
      targetSha = remoteHead;
    }

    // Sync all worktrees to target sha (or noop in dry-run)
    report.actions.push({ kind: 'sync_worktrees', target_sha: targetSha });
    const synced = syncWorktrees({ gitRoot, targetSha, allowDirty, apply });
    report.synced_worktrees = synced;

    db.run(
      `UPDATE checkpoints
       SET status='finished',
           finished_at=datetime('now'),
           session_head_sha_local=?,
           session_head_sha_remote=?,
           synced_worktrees_json=?,
           report_json=?
       WHERE id=?;`,
      [targetSha, revParse(remoteRef, { cwd: gitRoot }) || remoteHead, JSON.stringify(synced), JSON.stringify(report), checkpointId],
    );
    insertEvent(db, 'checkpoint.finished', { session_id: sessionId, checkpoint_id: checkpointId, ok: 1 });
    persistDb(db, dbPath);

    checkpointOk(opts, {
      id: checkpointId,
      relation: report.relation,
      apply: apply ? 1 : 0,
      target_sha: targetSha,
      db: dbPath,
      remote_ref: remoteRef,
      local_session_branch: sessionBranch,
      local_session_sha: localSessionSha,
      remote_head: remoteHead,
    });
    if (getFormat(opts) === 'human') {
      // eslint-disable-next-line no-console
      console.log(
        `[sx3 checkpoint run] ok=1 id=${checkpointId} session=${sessionId} relation=${report.relation} apply=${apply ? 1 : 0} target_sha=${targetSha} remote_ref=${remoteRef} db=${dbPath}`,
      );
    }
    return;
  } catch (e) {
    const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
    report.error = msg;
    db.run(
      `UPDATE checkpoints
       SET status='failed',
           finished_at=datetime('now'),
           report_json=?
       WHERE id=?;`,
      [JSON.stringify(report), checkpointId],
    );
    insertEvent(db, 'checkpoint.failed', { session_id: sessionId, checkpoint_id: checkpointId, ok: 0, reason: msg });
    persistDb(db, dbPath);
    checkpointFail(opts, {
      stage: 'checkpoint.run',
      reason: 'failed',
      message: `sx3 checkpoint run failed: ${msg}`,
      next_step_cmd: `./sx3 checkpoint show ${checkpointId}`,
      details: { checkpoint_id: checkpointId },
    });
  }
}

async function cmdShow(opts, rest) {
  const id = String(rest[0] || '');
  if (!id) fail('sx3 checkpoint show: требуется <checkpoint_id>', 2);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const res = db.exec(`SELECT * FROM checkpoints WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) fail(`sx3 checkpoint show: checkpoint не найден: ${id}`, 2);
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
  if (sub === 'run') return cmdRun(opts);
  if (sub === 'show') return cmdShow(opts, rest);
  fail(`sx3 checkpoint: неизвестная подкоманда: ${sub}`, 2);
}

