import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { fail } from './sx3-lib.js';
import { ensureSchemaMigrations, hasTable, openDb, persistDb, resolveDbPath } from './sx3-db.js';
import { getFormat, printFailure, printOk } from './sx3-output.js';
import { Sx3CliError } from './sx3-errors.js';
import { selectBacklogCandidates } from './sx3-issues.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 plan build [--session <id>] --allowlist <file.json> --assigns <file.json>
                 [--limit <n>] [--dry-run | --apply]
                 [--format human|min-json|jsonl]
                 [--db <path>]
  sx3 plan build [--session <id>] --from-backlog --project <id> --assigns <file.json>
                 [--limit <n>] [--dry-run | --apply]
                 [--format human|min-json|jsonl]
                 [--db <path>]
  sx3 plan list [--session <id>] [--db <path>]
  sx3 plan show <plan_id> [--db <path>] [--format human|min-json|jsonl]

Input contracts (v1, minimal):
  - allowlist: JSON array of issue ids, e.g. ["L-000123","L-000124"] (order is preserved)
  - assigns: JSON array of objects, e.g. [{"worktree":"agent-1","model":"default"},{"worktree":"agent-2","model":"light"}]
`);
}

function ensureTables(db) {
  if (!hasTable(db, 'plans')) fail('sx3 plan: таблица plans не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'sessions')) fail('sx3 plan: таблица sessions не найдена. Сначала выполни: ./sx3 db migrate', 2);
  if (!hasTable(db, 'events')) fail('sx3 plan: таблица events не найдена. Сначала выполни: ./sx3 db migrate', 2);
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

function readJsonFile(p, stage) {
  const abs = path.resolve(String(p || ''));
  if (!abs) throw new Sx3CliError({ stage, reason: 'missing_path', next_step_cmd: null });
  if (!fs.existsSync(abs)) {
    throw new Sx3CliError({ stage, reason: 'file_not_found', next_step_cmd: `ls -la ${abs}`, details: { path: abs } });
  }
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
    throw new Sx3CliError({ stage, reason: 'json_parse_failed', next_step_cmd: `cat ${abs}`, details: { path: abs, error: msg } });
  }
}

function parseAllowlist(obj) {
  const a = Array.isArray(obj) ? obj : obj && typeof obj === 'object' && Array.isArray(obj.issues) ? obj.issues : null;
  if (!a) throw new Sx3CliError({ stage: 'plan.allowlist', reason: 'bad_shape', next_step_cmd: 'ожидался JSON массив строк ["L-000123",...]' });
  const out = a.map((x) => String(x || '').trim()).filter(Boolean);
  if (out.length === 0) throw new Sx3CliError({ stage: 'plan.allowlist', reason: 'empty', next_step_cmd: 'добавь issue ids в allowlist' });
  return out;
}

function parseAssigns(obj) {
  if (!Array.isArray(obj)) throw new Sx3CliError({ stage: 'plan.assigns', reason: 'bad_shape', next_step_cmd: 'ожидался JSON массив объектов {worktree, model?}' });
  /** @type {{worktree:string, model:string}[]} */
  const out = [];
  for (const it of obj) {
    const wt = it && typeof it === 'object' && typeof it.worktree === 'string' ? it.worktree.trim() : '';
    if (!wt) throw new Sx3CliError({ stage: 'plan.assigns', reason: 'missing_worktree', next_step_cmd: 'каждый assigns элемент должен иметь worktree' });
    const model = it && typeof it === 'object' && typeof it.model === 'string' ? it.model.trim() : '';
    out.push({ worktree: wt, model: model || 'default' });
  }
  if (out.length === 0) throw new Sx3CliError({ stage: 'plan.assigns', reason: 'empty', next_step_cmd: 'добавь хотя бы один worktree в assigns' });
  return out;
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

function pickSessionId({ db, opts }) {
  const explicit = opts && typeof opts.session === 'string' ? String(opts.session).trim() : '';
  if (explicit) {
    const r = db.exec(`SELECT status FROM sessions WHERE id=? LIMIT 1;`, [explicit]);
    const st = r?.[0]?.values?.[0]?.[0];
    if (!st) {
      throw new Sx3CliError({
        stage: 'plan.session',
        reason: 'session_not_found',
        next_step_cmd: './sx3 session status',
        details: { session_id: explicit },
      });
    }
    if (String(st) !== 'open') {
      throw new Sx3CliError({
        stage: 'plan.session',
        reason: 'session_not_open',
        next_step_cmd: './sx3 session open --project <id>',
        details: { session_id: explicit, status: String(st) },
      });
    }
    return explicit;
  }
  const r = db.exec(`SELECT id FROM sessions WHERE status='open' ORDER BY created_at DESC LIMIT 1;`);
  const id = r?.[0]?.values?.[0]?.[0];
  if (!id) {
    throw new Sx3CliError({
      stage: 'plan.session',
      reason: 'no_open_session',
      next_step_cmd: './sx3 session open --project <id>',
    });
  }
  return String(id);
}

function buildRoundRobinPlan({ issueIds, assigns, limit }) {
  const n = Math.min(issueIds.length, limit);
  /** @type {Array<{issue_id:string, worktree:string, model:string}>} */
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const a = assigns[i % assigns.length];
    items.push({ issue_id: issueIds[i], worktree: a.worktree, model: a.model });
  }
  return items;
}

async function cmdList(opts) {
  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const sessionId = opts && typeof opts.session === 'string' ? String(opts.session).trim() : '';
  const res = sessionId
    ? db.exec(
        `SELECT id, session_id, created_at
         FROM plans
         WHERE session_id=?
         ORDER BY created_at DESC
         LIMIT 50;`,
        [sessionId],
      )
    : db.exec(
        `SELECT id, session_id, created_at
         FROM plans
         ORDER BY created_at DESC
         LIMIT 50;`,
      );
  const rows = res?.[0]?.values || [];
  // eslint-disable-next-line no-console
  console.log(`[sx3 plan list] path=${dbPath} count=${rows.length}${sessionId ? ` session=${sessionId}` : ''}`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`- id=${r[0]} session=${r[1]} created_at=${r[2]}`);
  }
}

async function cmdShow(opts, rest) {
  const id = String(rest[0] || '').trim();
  if (!id) throw new Sx3CliError({ stage: 'plan.args', reason: 'missing_plan_id', next_step_cmd: 'sx3 plan show <plan_id>' });

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const res = db.exec(`SELECT id, session_id, created_at, selector_json, assigns_json FROM plans WHERE id=?;`, [id]);
  const row = res?.[0]?.values?.[0];
  if (!row) throw new Sx3CliError({ stage: 'plan.show', reason: 'plan_not_found', next_step_cmd: './sx3 plan list', details: { id } });

  const selector = JSON.parse(String(row[3] || '{}'));
  const assignsWrap = JSON.parse(String(row[4] || '{}'));
  const plan = Array.isArray(selector.plan)
    ? selector.plan
    : buildRoundRobinPlanItems({ allowlist: selector.allowlist, assigns: assignsWrap.assigns, limit: selector.limit });

  printOk(
    opts,
    {
      kind: 'sx3.plan.show',
      id: String(row[0]),
      session_id: String(row[1]),
      created_at: String(row[2]),
      selector: selector,
      assigns: assignsWrap,
      plan,
    },
    `[sx3 plan show] ok=1 id=${String(row[0])} session=${String(row[1])} items=${Array.isArray(plan) ? plan.length : 0}`,
  );
  if (getFormat(opts) === 'human') {
    for (const it of plan) {
      // eslint-disable-next-line no-console
      console.log(`- ${it.issue_id} -> ${it.worktree} model=${it.model || 'default'}`);
    }
  }
}

async function cmdBuild(opts) {
  const fromBacklog = Boolean(opts && opts['from-backlog']);
  const projectId = opts && typeof opts.project === 'string' ? String(opts.project).trim() : '';
  const allowlistPath = opts && typeof opts.allowlist === 'string' ? String(opts.allowlist) : '';
  const assignsPath = opts && typeof opts.assigns === 'string' ? String(opts.assigns) : '';
  if (!fromBacklog && !allowlistPath) {
    throw new Sx3CliError({
      stage: 'plan.args',
      reason: 'missing_allowlist',
      next_step_cmd: 'sx3 plan build --allowlist <file.json> --assigns <file.json>  (или --from-backlog --project <id>)',
    });
  }
  if (fromBacklog && !projectId) {
    throw new Sx3CliError({ stage: 'plan.args', reason: 'missing_project', next_step_cmd: 'sx3 plan build --from-backlog --project <id> --assigns <file.json>' });
  }
  if (!assignsPath) throw new Sx3CliError({ stage: 'plan.args', reason: 'missing_assigns', next_step_cmd: 'sx3 plan build --allowlist <file.json> --assigns <file.json>' });

  const allowObj = fromBacklog ? null : readJsonFile(allowlistPath, 'plan.allowlist');
  const assignsObj = readJsonFile(assignsPath, 'plan.assigns');
  const assigns = parseAssigns(assignsObj);

  const limitRaw = opts && typeof opts.limit === 'string' ? Number(String(opts.limit)) : NaN;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : assigns.length;

  const dbPath = resolveDbPath(opts);
  const { db } = await openDb(dbPath);
  ensureSchemaMigrations(db);
  ensureTables(db);

  const sessionId = pickSessionId({ db, opts });
  let issueIds = [];
  let selectorSource = 'allowlist';
  let backlogMeta = null;
  if (fromBacklog) {
    const sel = selectBacklogCandidates({ projectId, statuses: ['planned', 'new'], limit: Math.max(limit, assigns.length) });
    issueIds = sel.candidates.map((x) => x.id);
    selectorSource = 'backlog';
    backlogMeta = { project_id: projectId, reached_backlog_end: sel.reached_backlog_end, skipped_already_assigned: sel.skipped_already_assigned };
  } else {
    issueIds = parseAllowlist(allowObj);
  }

  const planItems = buildRoundRobinPlan({ issueIds, assigns, limit });

  const apply = Boolean(opts && opts.apply);
  const dryRunFlag = Boolean(opts && opts['dry-run']);
  if (apply && dryRunFlag) throw new Sx3CliError({ stage: 'plan.args', reason: 'conflicting_flags', next_step_cmd: 'убери один из флагов: --apply или --dry-run' });

  if (!apply) {
    printOk(
      opts,
      {
        kind: 'sx3.plan.build',
        session_id: sessionId,
        apply: 0,
        source: selectorSource,
        ...(backlogMeta ? { backlog: backlogMeta } : {}),
        allowlist_count: issueIds.length,
        assigns_count: assigns.length,
        selected_count: planItems.length,
        plan: planItems,
      },
      `[sx3 plan build] ok=1 apply=0 session=${sessionId} selected=${planItems.length} (dry-run)`,
    );
    if (getFormat(opts) === 'human') {
      for (const it of planItems) {
        // eslint-disable-next-line no-console
        console.log(`- ${it.issue_id} -> ${it.worktree} model=${it.model}`);
      }
    }
    return;
  }

  const planId = `plan_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO plans(id, session_id, created_at, selector_json, assigns_json)
     VALUES (?, ?, datetime('now'), ?, ?);`,
    [
      planId,
      sessionId,
      JSON.stringify({ schema_version: 1, source: selectorSource, allowlist: issueIds, limit, plan: planItems, ...(backlogMeta ? { backlog: backlogMeta } : {}) }),
      JSON.stringify({ schema_version: 1, assigns }),
    ],
  );
  insertEvent(db, 'plan.built', { session_id: sessionId, plan_id: planId, selected_count: planItems.length });
  persistDb(db, dbPath);

  printOk(
    opts,
    {
      kind: 'sx3.plan.build',
      id: planId,
      session_id: sessionId,
      apply: 1,
      db: dbPath,
      allowlist_count: issueIds.length,
      assigns_count: assigns.length,
      selected_count: planItems.length,
      plan: planItems,
    },
    `[sx3 plan build] ok=1 apply=1 id=${planId} session=${sessionId} selected=${planItems.length} db=${dbPath}`,
  );
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  try {
    if (sub === 'build') return await cmdBuild(opts, rest);
    if (sub === 'list') return await cmdList(opts);
    if (sub === 'show') return await cmdShow(opts, rest);
    throw new Sx3CliError({ stage: 'plan.args', reason: 'unknown_subcommand', next_step_cmd: 'sx3 plan build --help', details: { sub } });
  } catch (e) {
    printFailure(opts, e, 'sx3 plan failed', 2);
  }
}

