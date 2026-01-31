import fs from 'node:fs';
import path from 'node:path';

import { Sx3CliError } from './sx3-errors.js';
import { getSx2StateRoot } from './sx3-sx2-state.js';

export function getIssuesProjectDir(projectId) {
  return path.join(getSx2StateRoot(), 'state', 'issues', String(projectId));
}

export function getIssuesIndexPath(projectId) {
  return path.join(getIssuesProjectDir(projectId), 'index.json');
}

export function getIssueSnapshotPath(projectId, issueId) {
  return path.join(getIssuesProjectDir(projectId), String(issueId), 'snapshot.json');
}

export function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function readIssuesIndexOrThrow(projectId) {
  const p = getIssuesIndexPath(projectId);
  const idx = readJsonIfExists(p);
  if (!idx) {
    throw new Sx3CliError({
      stage: 'issues.read',
      reason: 'issues_index_not_found',
      next_step_cmd: `ls -la ${p}`,
      details: { path: p, project_id: String(projectId) },
    });
  }
  return idx;
}

export function readIssueSnapshotOrNull(projectId, issueId) {
  const p = getIssueSnapshotPath(projectId, issueId);
  return readJsonIfExists(p);
}

export function isBacklogEndMarker({ issueId, title, body }) {
  if (String(title || '').trim() === 'BACKLOG_END') return true;
  const b = String(body || '');
  if (/(^|\n)\s*priority\s*:\s*BACKLOG_END\s*(\n|$)/i.test(b)) return true;
  // legacy compat: some snapshots might store in lowercase
  if (/(^|\n)\s*Priority\s*:\s*BACKLOG_END\s*(\n|$)/.test(b)) return true;
  if (issueId && /(BACKLOG_END)/i.test(String(issueId))) return false;
  return false;
}

export function selectBacklogCandidates({ projectId, statuses = ['planned', 'new'], limit = 50 }) {
  const idx = readIssuesIndexOrThrow(projectId);
  const items = Array.isArray(idx.items) ? idx.items : [];
  const allowed = new Set(statuses.map((s) => String(s)));

  /** @type {Array<{id:string,status:string,title:string,assigned_to:string|null}>} */
  const planned = [];
  /** @type {Array<{id:string,status:string,title:string,assigned_to:string|null}>} */
  const fresh = [];
  let reachedBacklogEnd = false;
  let skippedAlreadyAssigned = 0;

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const title = typeof it.title === 'string' ? it.title : '';
    const id = typeof it.id === 'string' ? it.id : '';
    const st = typeof it.status === 'string' ? it.status : '';
    const assigned = typeof it.assigned_to === 'string' ? it.assigned_to.trim() : '';
    if (!id) continue;

    // backlog end marker detection (reads snapshot body if needed)
    if (String(title || '').trim() === 'BACKLOG_END') {
      reachedBacklogEnd = true;
      break;
    }
    const snap = readIssueSnapshotOrNull(projectId, id);
    if (isBacklogEndMarker({ issueId: id, title, body: snap?.body })) {
      reachedBacklogEnd = true;
      break;
    }

    if (!allowed.has(st)) continue;
    if (assigned) {
      skippedAlreadyAssigned += 1;
      continue;
    }
    const rec = { id, status: st, title, assigned_to: null };
    if (st === 'planned') planned.push(rec);
    else fresh.push(rec);
    if (planned.length + fresh.length >= limit) break;
  }

  const candidates = [...planned, ...fresh];
  return { candidates, reached_backlog_end: reachedBacklogEnd ? 1 : 0, skipped_already_assigned: skippedAlreadyAssigned };
}

