import childProcess from 'node:child_process';

import { fail } from './sx3-lib.js';

export function git(args, { cwd, allowFailure = false } = {}) {
  const r = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!allowFailure && r.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${String(r.stderr || r.stdout || '').trim()}`, 2);
  }
  return r;
}

export function getGitRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd, allowFailure: true });
  if (r.status !== 0) return null;
  const p = String(r.stdout || '').trim();
  return p || null;
}

export function revParse(ref, { cwd }) {
  const r = git(['rev-parse', ref], { cwd, allowFailure: true });
  if (r.status !== 0) return null;
  const s = String(r.stdout || '').trim();
  return s || null;
}

export function isGitRepo(cwd) {
  const r = git(['rev-parse', '--is-inside-work-tree'], { cwd, allowFailure: true });
  return r.status === 0;
}

export function getWorktrees({ cwd }) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd, allowFailure: true });
  if (r.status !== 0) return [];
  const lines = String(r.stdout || '').split('\n');
  /** @type {{path:string, head:string|null, branch:string|null, bare?:boolean}[]} */
  const out = [];
  /** @type {any} */
  let cur = null;
  for (const line of lines) {
    const l = String(line || '').trimEnd();
    if (!l) continue;
    if (l.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: l.slice('worktree '.length).trim(), head: null, branch: null };
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('HEAD ')) cur.head = l.slice('HEAD '.length).trim();
    if (l.startsWith('branch ')) cur.branch = l.slice('branch '.length).trim();
    if (l === 'bare') cur.bare = true;
  }
  if (cur) out.push(cur);
  return out.filter((w) => w.path);
}

export function workingTreePorcelain({ cwd }) {
  const r = git(['status', '--porcelain'], { cwd, allowFailure: true });
  if (r.status !== 0) return null;
  return String(r.stdout || '');
}

export function mergeBase(a, b, { cwd }) {
  const r = git(['merge-base', a, b], { cwd, allowFailure: true });
  if (r.status !== 0) return null;
  const s = String(r.stdout || '').trim();
  return s || null;
}

export function relation(localSha, remoteSha, { cwd }) {
  const l = String(localSha || '').trim();
  const r = String(remoteSha || '').trim();
  if (!l || !r) return { kind: 'unknown' };
  if (l === r) return { kind: 'equal' };
  const base = mergeBase(l, r, { cwd });
  if (!base) return { kind: 'unknown' };
  if (base === r) return { kind: 'ahead-only' }; // local ahead of remote
  if (base === l) return { kind: 'behind-only' }; // local behind remote
  return { kind: 'diverged' };
}

