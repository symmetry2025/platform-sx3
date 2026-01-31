import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, persistDb, resolveDbPath } from './sx3-db.js';
import { getStorePath, resolveStoreDir } from './sx3-store.js';
import { readBundleEntryText } from './sx3-bundle.js';
import { gateDeliverablesV1 } from './sx3-gates.js';
import { printFailure } from './sx3-output.js';
import { getFormat, printOk } from './sx3-output.js';
import { Sx3CliError } from './sx3-errors.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 accept run --delivery <del_...> [--cwd <repo>] [--dry-run | --apply]
                [--check-cmd "<cmd>"] [--allow-empty]
                [--integrate-ref <ref>] [--no-checkout] [--no-integrate]
                [--allow-dirty]
                [--db <path>] [--store-dir <dir>]

Notes:
  - По умолчанию режим безопасный: dry-run (git apply --check).
  - --apply реально применяет patch.diff в текущий git worktree.
  - Если patch пустой (no-op delivery), можно разрешить через --allow-empty (обычно включается автоматически).
  - В режиме --apply по умолчанию выполняется integrate: stage → commit на ref (default: session/<session_id>).
`);
}

function getStateHome() {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

function ensureTables(db) {
  if (!hasTable(db, 'deliveries')) fail('sx3 accept: таблица deliveries не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'check_runs')) fail('sx3 accept: таблица check_runs не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'events')) fail('sx3 accept: таблица events не найдена. Сначала выполни: ./sx3 db migrate', 2);
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

function ensureGitRepo(cwd) {
  const r = childProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) fail(`sx3 accept: cwd не является git репозиторием: ${cwd}`, 2);
}

function getGitRoot(cwd) {
  const r = childProcess.spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return null;
  const p = String(r.stdout || '').trim();
  return p ? p : null;
}

function runGitApply({ cwd, patchFilePath, apply }) {
  const args = ['apply'];
  if (!apply) args.push('--check');
  // Для no-op patch'ей git apply падает, если не разрешить allow-empty.
  args.push('--allow-empty');
  args.push(patchFilePath);
  const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runGitApplyReverseCheck({ cwd, patchFilePath }) {
  const args = ['apply', '--reverse', '--check', '--allow-empty', patchFilePath];
  const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function gitStatusPorcelain(cwd) {
  const r = childProcess.spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return null;
  return String(r.stdout || '');
}

function gitRevParse(cwd, ref) {
  const r = childProcess.spawnSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return null;
  const s = String(r.stdout || '').trim();
  return s || null;
}

function gitConfigGet(cwd, key) {
  const r = childProcess.spawnSync('git', ['config', '--get', String(key)], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return null;
  const s = String(r.stdout || '').trim();
  return s || null;
}

function ensureGitIdentityOrThrow(gitRoot) {
  const email = gitConfigGet(gitRoot, 'user.email');
  const name = gitConfigGet(gitRoot, 'user.name');
  if (email && name) return;
  throw new Sx3CliError({
    stage: 'accept.integrate',
    reason: 'git_identity_missing',
    next_step_cmd:
      'git config user.email "sx3@local" && git config user.name "SX3"  # (внутри целевого репо) затем повтори sx3 accept run',
    details: { git_root: gitRoot },
  });
}

function gitHasCommit(cwd, sha) {
  const s = String(sha || '').trim();
  if (!s) return false;
  const r = childProcess.spawnSync('git', ['cat-file', '-e', `${s}^{commit}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

function checkoutIntegrateRef({ gitRoot, ref, allowCreate }) {
  const r = childProcess.spawnSync('git', ['rev-parse', '--verify', ref], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    if (!allowCreate) fail(`sx3 accept: integrate-ref не найден: ${ref}`, 2);
    const cr = childProcess.spawnSync('git', ['checkout', '-b', ref], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (cr.status !== 0) fail(`sx3 accept: git checkout -b ${ref} failed: ${String(cr.stderr || cr.stdout || '').trim()}`, 2);
    return;
  }
  const co = childProcess.spawnSync('git', ['checkout', ref], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (co.status !== 0) fail(`sx3 accept: git checkout ${ref} failed: ${String(co.stderr || co.stdout || '').trim()}`, 2);
}

function extractTouchedPathsFromPatch(patchText) {
  const out = new Set();
  const lines = String(patchText || '').split('\n');
  for (const line of lines) {
    // unified diff header: "+++ b/path" or "--- a/path"
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') continue;
      const cleaned = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
      if (cleaned) out.add(cleaned);
    }
  }
  return [...out.values()];
}

function stageTouchedPaths({ gitRoot, patchText }) {
  const paths = extractTouchedPathsFromPatch(patchText);
  if (paths.length === 0) return;
  // stage only touched paths; include adds/deletes/renames
  const r = childProcess.spawnSync('git', ['add', '-A', '--', ...paths], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) fail(`sx3 accept: git add -A failed: ${String(r.stderr || r.stdout || '').trim()}`, 2);
}

function commitIfStaged({ gitRoot, message }) {
  const diff = childProcess.spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const has = diff.status === 0 && String(diff.stdout || '').trim().length > 0;
  if (!has) return null;
  const r = childProcess.spawnSync('git', ['commit', '-m', message], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const errText = String(r.stderr || r.stdout || '').trim();
    if (/Author identity unknown/i.test(errText) || /user\.email/i.test(errText) || /user\.name/i.test(errText)) {
      throw new Sx3CliError({
        stage: 'accept.integrate',
        reason: 'git_identity_missing',
        next_step_cmd:
          'git config user.email "sx3@local" && git config user.name "SX3"  # (внутри целевого репо) затем повтори sx3 accept run',
        details: { git_root: gitRoot },
      });
    }
    fail(`sx3 accept: git commit failed: ${errText}`, 2);
  }
  return gitRevParse(gitRoot, 'HEAD');
}

function runCheckCmd({ cwd, cmd, logPath }) {
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`[sx3 accept check] started_at=${new Date().toISOString()} cwd=${cwd}\n`);
  logStream.write(`[sx3 accept check] cmd=${cmd}\n`);

  const child = childProcess.spawn('bash', ['-lc', cmd], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => logStream.write(b));
  child.stderr.on('data', (b) => logStream.write(b));

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      const exitCode =
        typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
      logStream.write(`[sx3 accept check] finished_at=${new Date().toISOString()} exit_code=${exitCode}\n`);
      logStream.end();
      resolve(exitCode);
    });
  });
}

function makeTmpPatchFile(deliveryId, patchText) {
  const tmpDir = path.join(getStateHome(), 'smmtryx3', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const p = path.join(tmpDir, `patch_${deliveryId}_${Date.now()}.diff`);
  fs.writeFileSync(p, String(patchText || ''), 'utf8');
  return p;
}

function getCheckLogPath(checkId) {
  const dir = path.join(getStateHome(), 'smmtryx3', 'logs', 'check_runs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${checkId}.log`);
}

async function cmdRun(opts) {
  try {
    const deliveryId = opts && typeof opts.delivery === 'string' ? String(opts.delivery) : '';
    if (!deliveryId) fail('sx3 accept run: требуется --delivery <del_...>', 2);

    const cwd = opts && typeof opts.cwd === 'string' ? path.resolve(String(opts.cwd)) : process.cwd();

  const apply = Boolean(opts && opts.apply);
  const dryRunFlag = Boolean(opts && opts['dry-run']);
  if (apply && dryRunFlag) fail('sx3 accept run: нельзя одновременно --apply и --dry-run', 2);
  const doApply = apply; // default false => dry-run

  const checkCmd = opts && typeof opts['check-cmd'] === 'string' ? String(opts['check-cmd']) : '';
  const allowEmptyFlag = Boolean(opts && opts['allow-empty']);

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const dRes = db.exec(`SELECT id, attempt_id, status, patch_uri, patch_sha256, deliverables_json FROM deliveries WHERE id=?;`, [
    deliveryId,
  ]);
  const dRow = dRes?.[0]?.values?.[0];
  if (!dRow) fail(`sx3 accept run: delivery не найден: ${deliveryId}`, 2);
  const attemptId = String(dRow[1] || '');
  const deliveryStatus = String(dRow[2] || '');
  const patchSha256 = String(dRow[4] || '');
  const deliverablesJsonText = String(dRow[5] || '');

  if (deliveryStatus !== 'published' && deliveryStatus !== 'accepted') {
    fail(`sx3 accept run: неподдерживаемый статус delivery: ${deliveryStatus}`, 2);
  }

  // Validate deliverables again (contract)
  gateDeliverablesV1({ deliverablesText: deliverablesJsonText, expectedIssueId: null, stage: 'accept.gates.deliverables' });

  // If already accepted+integrated, be idempotent.
  if (deliveryStatus === 'accepted') {
    const d2 = db.exec(`SELECT summary_json FROM deliveries WHERE id=?;`, [deliveryId]);
    const sj = String(d2?.[0]?.values?.[0]?.[0] || '');
    if (sj) {
      try {
        const parsed = JSON.parse(sj);
        const sha = parsed && typeof parsed.integrate_commit_sha === 'string' ? parsed.integrate_commit_sha : '';
        if (sha) {
          ensureGitRepo(cwd);
          const gitRoot2 = getGitRoot(cwd);
          if (gitRoot2 && gitHasCommit(gitRoot2, sha)) {
            printOk(
              opts,
              { kind: 'sx3.accept.run', ok: true, idempotent: 1, delivery_id: deliveryId, attempt_id: attemptId, integrated_sha: sha },
              `[sx3 accept run] ok=1 idempotent=1 delivery_id=${deliveryId} integrated_sha=${sha}`,
            );
            return;
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  const storeDir = resolveStoreDir(opts);
  const zipPath = getStorePath(storeDir, patchSha256);
  if (!fs.existsSync(zipPath)) fail(`sx3 accept run: bundle не найден в store: ${zipPath}`, 2);

  const patchText = readBundleEntryText(zipPath, 'patch.diff');
  const patchFilePath = makeTmpPatchFile(deliveryId, patchText);

  ensureGitRepo(cwd);
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) fail(`sx3 accept: не удалось определить git root для cwd=${cwd}`, 2);

  const allowDirty = Boolean(opts && opts['allow-dirty']);
  const porcelain = gitStatusPorcelain(gitRoot);
  if (!allowDirty && porcelain != null && porcelain.trim().length > 0) {
    fail('sx3 accept run: repo dirty. Приведи в clean состояние или явно --allow-dirty', 2);
  }

  const isEmptyPatch = !String(patchText || '').trim();
  if (isEmptyPatch && !allowEmptyFlag) {
    // Авто-разрешение для no-op delivery: важный кейс (будущие gates разрулят политику).
    if (getFormat(opts) === 'human') {
      // eslint-disable-next-line no-console
      console.log(`[sx3 accept run] note=empty_patch allow_empty=auto delivery_id=${deliveryId}`);
    }
  }
  const noIntegrate = Boolean(opts && opts['no-integrate']);
  const noCheckout = Boolean(opts && opts['no-checkout']);
  const integrateRefFlag = opts && typeof opts['integrate-ref'] === 'string' ? String(opts['integrate-ref']).trim() : '';

  // Resolve session_id via attempt_id (best effort) to pick integrate-ref default.
  let integrateSessionId = null;
  if (attemptId) {
    const aRes = db.exec(`SELECT session_id FROM attempts WHERE id=?;`, [attemptId]);
    const sid = aRes?.[0]?.values?.[0]?.[0];
    if (sid) integrateSessionId = String(sid);
  }
  const integrateRefDefault = integrateSessionId ? `session/${integrateSessionId}` : `session/unknown`;
  const integrateRefFinal = integrateRefFlag || integrateRefDefault;

  // Checkout integration ref BEFORE applying patch (to avoid switching branches after modifications).
  if (doApply && !noIntegrate && !noCheckout) {
    // Preflight: ensure we can commit before we touch the repo.
    ensureGitIdentityOrThrow(gitRoot);
    checkoutIntegrateRef({ gitRoot, ref: integrateRefFinal, allowCreate: true });
  }

  let alreadyApplied = false;
  if (!isEmptyPatch) {
    const applyRes = runGitApply({ cwd: gitRoot, patchFilePath, apply: doApply });
    if (applyRes.status !== 0) {
      // idempotence: if patch already applied, reverse check should succeed
      const rev = runGitApplyReverseCheck({ cwd: gitRoot, patchFilePath });
      if (rev.status === 0) {
        alreadyApplied = true;
      } else {
        fail(`sx3 accept run: git apply ${doApply ? '' : '--check '}failed: ${String(applyRes.stderr || '').trim()}`, 2);
      }
    }
  }

  if (!doApply) {
    printOk(
      opts,
      {
        kind: 'sx3.accept.run',
        ok: true,
        dry_run: 1,
        delivery_id: deliveryId,
        cwd: gitRoot,
        check_cmd: checkCmd || null,
        already_applied: alreadyApplied ? 1 : 0,
      },
      `[sx3 accept run] ok=1 dry_run=1 delivery_id=${deliveryId} cwd=${cwd}`,
    );
    return;
  }

  if (!noIntegrate) {
    if (!isEmptyPatch) stageTouchedPaths({ gitRoot, patchText });
    const commitMsg = `sx3 accept ${deliveryId}`;
    const integratedSha = commitIfStaged({ gitRoot, message: commitMsg });
    if (integratedSha) {
      db.run(`UPDATE deliveries SET status='accepted', summary_json=? WHERE id=?;`, [
        JSON.stringify({
          schema_version: 1,
          integrated_at: new Date().toISOString(),
          integrate_commit_sha: integratedSha,
          integrate_ref: integrateRefFinal,
          already_applied: alreadyApplied ? 1 : 0,
        }),
        deliveryId,
      ]);
      insertEvent(db, 'delivery.integrated', { delivery_id: deliveryId, attempt_id: attemptId, integrate_commit_sha: integratedSha });
    } else {
      // no staged changes: could be already applied or empty patch
      db.run(`UPDATE deliveries SET status='accepted', summary_json=? WHERE id=?;`, [
        JSON.stringify({
          schema_version: 1,
          integrated_at: new Date().toISOString(),
          integrate_commit_sha: null,
          integrate_ref: integrateRefFinal,
          already_applied: alreadyApplied ? 1 : 0,
          note: 'no_changes_to_commit',
        }),
        deliveryId,
      ]);
    }
    persistDb(db, dbPath);
  } else {
    db.run(`UPDATE deliveries SET status='accepted' WHERE id=?;`, [deliveryId]);
    persistDb(db, dbPath);
  }

  // Record check run (optional)
  let checkOk = 1;
  let checkId = null;
  let checkExitCode = null;
  let checkLogPath = null;

  if (checkCmd) {
    checkId = `chk_${crypto.randomUUID()}`;
    checkLogPath = getCheckLogPath(checkId);
    db.run(
      `INSERT INTO check_runs(id, delivery_id, status, started_at, finished_at, ok, report_json, log_uri)
       VALUES (?, ?, 'running', datetime('now'), NULL, NULL, ?, ?);`,
      [checkId, deliveryId, JSON.stringify({ cmd: checkCmd, cwd }), checkLogPath],
    );
    persistDb(db, dbPath);

    checkExitCode = await runCheckCmd({ cwd: gitRoot, cmd: checkCmd, logPath: checkLogPath });
    checkOk = checkExitCode === 0 ? 1 : 0;

    db.run(
      `UPDATE check_runs SET status='finished', finished_at=datetime('now'), ok=?, report_json=? WHERE id=?;`,
      [checkOk, JSON.stringify({ cmd: checkCmd, cwd, exit_code: checkExitCode }), checkId],
    );
    insertEvent(db, 'check_run.finished', { delivery_id: deliveryId, check_run_id: checkId, ok: checkOk });
    persistDb(db, dbPath);

    if (!checkOk) {
      fail(`sx3 accept run: checks failed (exit_code=${checkExitCode}). См. лог: ${checkLogPath}`, 2);
    }
  }

  insertEvent(db, 'delivery.accepted', { delivery_id: deliveryId, attempt_id: attemptId, check_id: checkId });
  persistDb(db, dbPath);

  printOk(
    opts,
    {
      kind: 'sx3.accept.run',
      ok: true,
      dry_run: 0,
      delivery_id: deliveryId,
      attempt_id: attemptId,
      applied: 1,
      checks_ok: checkOk,
      check_id: checkId,
      check_log: checkLogPath,
      cwd: gitRoot,
      already_applied: alreadyApplied ? 1 : 0,
      integrate_ref: noIntegrate ? null : integrateRefFinal,
    },
    `[sx3 accept run] ok=1 delivery_id=${deliveryId} attempt_id=${attemptId} applied=1 checks_ok=${checkOk} cwd=${gitRoot}`,
  );
  } catch (e) {
    printFailure(opts, e, 'sx3 accept run failed', 2);
  }
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }
  if (sub === 'run') return cmdRun(opts, rest);
  fail(`sx3 accept: неизвестная подкоманда: ${sub}`, 2);
}

