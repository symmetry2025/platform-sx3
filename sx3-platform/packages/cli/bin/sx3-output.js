import { fail } from './sx3-lib.js';
import { isSx3CliError } from './sx3-errors.js';

export function getFormat(opts) {
  const f = opts && typeof opts.format === 'string' ? String(opts.format) : 'human';
  return f || 'human';
}

export function printFailure(opts, err, fallbackMessage = 'ошибка', exitCode = 2) {
  const format = getFormat(opts);

  if (isSx3CliError(err) && (format === 'min-json' || format === 'jsonl')) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        schema_version: 1,
        kind: 'sx3.error',
        ok: false,
        stage: err.stage,
        reason: err.reason,
        next_step_cmd: err.next_step_cmd,
        details: err.details ?? null,
      }),
    );
    process.exit(exitCode);
  }

  if (isSx3CliError(err) && format === 'human') {
    const extra = err.next_step_cmd ? ` next_step_cmd=${err.next_step_cmd}` : '';
    fail(`[${err.stage}] ${err.reason}${extra}`, exitCode);
  }

  const msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err || fallbackMessage);
  fail(msg || fallbackMessage, exitCode);
}

export function printOk(opts, payload, humanLine) {
  const format = getFormat(opts);
  const ok = payload && typeof payload.ok === 'boolean' ? payload.ok : true;
  if (format === 'jsonl') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ schema_version: 1, kind: payload?.kind || 'sx3.ok', ok, ...payload }));
    return;
  }
  if (format === 'min-json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ schema_version: 1, kind: payload?.kind || 'sx3.ok', ok, details: payload }));
    return;
  }
  if (humanLine) {
    // eslint-disable-next-line no-console
    console.log(humanLine);
  }
}

