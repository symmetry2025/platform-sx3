export function parseDeliverablesText(deliverablesText) {
  let obj;
  try {
    obj = JSON.parse(String(deliverablesText || ''));
  } catch {
    throw new Error('deliverables_not_json');
  }
  return obj;
}

export function validateDeliverablesV1(obj, expectedIssueId) {
  if (!obj || typeof obj !== 'object') throw new Error('deliverables_not_object');
  if (obj.schema_version !== 1) throw new Error('deliverables_bad_schema_version');
  if (typeof obj.issue_id !== 'string' || !obj.issue_id.trim()) throw new Error('deliverables_missing_issue_id');
  if (expectedIssueId && obj.issue_id !== expectedIssueId) throw new Error('deliverables_issue_id_mismatch');
  for (const k of ['summary', 'changed_files', 'how_to_verify']) {
    if (!Array.isArray(obj[k]) || obj[k].length === 0) throw new Error(`deliverables_${k}_empty`);
    if (!obj[k].every((x) => typeof x === 'string' && x.trim())) throw new Error(`deliverables_${k}_not_strings`);
  }
  if (obj.risks != null) {
    if (!Array.isArray(obj.risks)) throw new Error('deliverables_risks_not_array');
    if (!obj.risks.every((x) => typeof x === 'string')) throw new Error('deliverables_risks_not_strings');
  }
  return obj;
}

export function parseAndValidateDeliverablesText(deliverablesText, expectedIssueId) {
  const obj = parseDeliverablesText(deliverablesText);
  return validateDeliverablesV1(obj, expectedIssueId);
}

