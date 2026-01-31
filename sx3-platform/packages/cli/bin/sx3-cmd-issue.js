import { Sx3CliError } from './sx3-errors.js';
import { printFailure, printOk } from './sx3-output.js';
import fs from 'node:fs';
import { getSx2StateRoot } from './sx3-sx2-state.js';
import { readIssuesIndexOrThrow, selectBacklogCandidates } from './sx3-issues.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  sx3 issue projects [--format human|min-json|jsonl]
  sx3 issue list --project <id> [--status planned,new] [--limit <n>] [--format human|min-json|jsonl]

Notes:
  - Читает локальный issue store SX2 (read-only): $XDG_STATE_HOME/smmtryx2/state/issues/<project>/index.json
`);
}

function parseStatuses(raw) {
  const s = String(raw || '').trim();
  if (!s) return ['planned', 'new'];
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function cmdList(opts) {
  const projectId = opts && typeof opts.project === 'string' ? String(opts.project).trim() : '';
  if (!projectId) throw new Sx3CliError({ stage: 'issue.args', reason: 'missing_project', next_step_cmd: 'sx3 issue list --project <id>' });

  const limitRaw = opts && typeof opts.limit === 'string' ? Number(String(opts.limit)) : NaN;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200;
  const statuses = parseStatuses(opts && typeof opts.status === 'string' ? opts.status : '');

  // Ensure store exists (throws structured error if not)
  readIssuesIndexOrThrow(projectId);
  const { candidates, reached_backlog_end, skipped_already_assigned } = selectBacklogCandidates({ projectId, statuses, limit });

  printOk(
    opts,
    {
      kind: 'sx3.issue.list',
      ok: true,
      project_id: projectId,
      statuses,
      limit,
      reached_backlog_end,
      skipped_already_assigned,
      count: candidates.length,
      items: candidates,
    },
    `[sx3 issue list] ok=1 project=${projectId} count=${candidates.length} backlog_end=${reached_backlog_end} skipped_assigned=${skipped_already_assigned}`,
  );

  // Human table
  const fmt = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  if (!fmt || fmt === 'human') {
    for (const it of candidates) {
      // eslint-disable-next-line no-console
      console.log(`${it.id}\t${it.status}\t${it.assigned_to ?? ''}\t${it.title || ''}`);
    }
  }
}

async function cmdProjects(opts) {
  const issuesDir = `${getSx2StateRoot()}/state/issues`;
  const list = fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).filter((x) => x && !x.startsWith('.')) : [];
  printOk(opts, { kind: 'sx3.issue.projects', ok: true, count: list.length, projects: list, issues_dir: issuesDir }, `[sx3 issue projects] ok=1 count=${list.length} dir=${issuesDir}`);
  const fmt = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  if (!fmt || fmt === 'human') {
    for (const p of list) {
      // eslint-disable-next-line no-console
      console.log(p);
    }
  }
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }
  try {
    if (sub === 'projects') return await cmdProjects(opts);
    if (sub === 'list') return await cmdList(opts, rest);
    throw new Sx3CliError({ stage: 'issue.args', reason: 'unknown_subcommand', next_step_cmd: 'sx3 issue list --help', details: { sub } });
  } catch (e) {
    printFailure(opts, e, 'sx3 issue failed', 2);
  }
}

