import { parseAndValidateDeliverablesText } from './sx3-deliverables.js';
import { Sx3CliError } from './sx3-errors.js';

/**
 * Gate: deliverables must exist and be valid (v1).
 */
export function gateDeliverablesV1({ deliverablesText, expectedIssueId, stage = 'gates.deliverables' }) {
  try {
    return parseAndValidateDeliverablesText(deliverablesText, expectedIssueId);
  } catch (e) {
    const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
    throw new Sx3CliError({
      stage,
      reason: 'deliverables_invalid',
      next_step_cmd: 'проверь deliverables.json (schema_version=1, issue_id, summary/changed_files/how_to_verify)',
      details: { error: msg },
    });
  }
}

/**
 * Gate: no-op patch policy.
 * Default: disallow no-op publish, because delivery should represent a real change.
 */
export function gateNoopPatch({ patchText, allowNoop = false, stage = 'gates.noop' }) {
  const isEmpty = !String(patchText || '').trim();
  if (!isEmpty) return { ok: true, noop: false };
  if (allowNoop) return { ok: true, noop: true };
  throw new Sx3CliError({
    stage,
    reason: 'noop_patch_disallowed',
    next_step_cmd: './sx3 attempt run ... --publish --allow-noop --deliverables <file.json>',
    details: { note: 'patch.diff пустой' },
  });
}

