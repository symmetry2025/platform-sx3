import os from 'node:os';
import path from 'node:path';

export function getSx2StateRoot() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'smmtryx2');
}

