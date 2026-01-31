#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail, parseArgs } from './sx3-lib.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
SX3 (WIP) — новая чистая платформа мультиагентной разработки.

Usage:
  smmtryx3 --help
  smmtryx3 home                  # печатает shell-snippet (для eval "$(./sx3 home)")
  smmtryx3 db migrate|status      # SQLite migrations/status (stage 1)
  smmtryx3 store <put|get|verify|gc> # Patch Store v1 (stage 2)
  smmtryx3 attempt <run|launch|list|show|tail|cancel> # Attempt runner + heartbeat (stage 3)
  smmtryx3 session open|status|list|close # Sessions (WIP)
  smmtryx3 plan build             # Plan builder (MVP)
  smmtryx3 issue projects|list    # Issues/backlog (read-only, from SX2 store)
  smmtryx3 delivery <list|show>   # Deliveries (stage 4)
  smmtryx3 accept run             # Accept delivery (stage 6)
  smmtryx3 checkpoint run|show    # Checkpoint engine (stage 7)
  smmtryx3 watch                  # Watch (stage 8, MVP)
  smmtryx3 repair attempt <id>    # Repair (stage 8, MVP)
  smmtryx3 doctor                 # Doctor (stage 8, MVP)

Docs:
  - ../docs/SX3_MASTER_PLAN.md (канон архитектуры и этапов)
`);
}

function printHomeSnippet() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const sx3Path = path.join(repoRoot, 'sx3');

  // eslint-disable-next-line no-console
  console.log(
    [
      '# sx3: helper function (copy to your shell or use: eval "$(./sx3 home)")',
      'sx3() {',
      `  "${sx3Path}" "$@"`,
      '}',
      '',
    ].join('\n'),
  );
}

async function main() {
  const { positionals, opts } = parseArgs(process.argv);
  if (opts.help || positionals.length === 0 || positionals[0] === 'help') {
    printHelp();
    return;
  }

  const cmd = String(positionals[0]);
  if (cmd === 'home') {
    printHomeSnippet();
    return;
  }

  const cmdsWithSub = new Set(['db', 'store', 'attempt', 'delivery', 'accept', 'checkpoint', 'repair', 'session', 'plan', 'issue']);
  const sub =
    cmdsWithSub.has(cmd) && positionals[1] && !String(positionals[1]).startsWith('--')
      ? String(positionals[1])
      : '';

  try {
    const mod = await import(`./sx3-cmd-${cmd}.js`);
    if (typeof mod?.run !== 'function') fail(`sx3: команда ${cmd} не реализована (нет export run)`, 2);
    const rest = sub ? positionals.slice(2) : positionals.slice(1);
    return mod.run(opts, sub, rest);
  } catch (e) {
    if (e && typeof e === 'object' && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND')) {
      fail(`неизвестная команда: ${cmd}`, 2);
    }
    throw e;
  }
}

main().catch((e) => {
  const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
  fail(msg, 2);
});

