export class Sx3CliError extends Error {
  /**
   * @param {{stage:string, reason:string, next_step_cmd?:string|null, details?:any}} p
   */
  constructor(p) {
    super(String(p?.reason || 'sx3_error'));
    this.name = 'Sx3CliError';
    this.stage = String(p.stage || 'unknown');
    this.reason = String(p.reason || 'unknown');
    this.next_step_cmd = p.next_step_cmd ?? null;
    this.details = p.details ?? null;
  }
}

export function isSx3CliError(e) {
  return Boolean(e && typeof e === 'object' && e.name === 'Sx3CliError' && 'stage' in e && 'reason' in e);
}

