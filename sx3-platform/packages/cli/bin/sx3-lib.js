import util from 'node:util';

export function fail(msg, code = 1) {
  // eslint-disable-next-line no-console
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

/**
 * Minimal argv parser (positional args + `--key value` / `--key=value` flags).
 * v0 is intentionally tiny; expand as sx3 commands land.
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  /** @type {Record<string, string|boolean>} */
  const opts = {};
  /** @type {string[]} */
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('-')) {
      positionals.push(a);
      continue;
    }
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a.startsWith('--') && a.includes('=')) {
      const [k, v] = a.slice(2).split('=', 2);
      opts[k] = v ?? '';
      continue;
    }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith('-')) {
        opts[k] = String(next);
        i++;
      } else {
        opts[k] = true;
      }
      continue;
    }
    // unknown short flag → treat as boolean without the dash
    opts[a.replace(/^-+/, '')] = true;
  }

  return { positionals, opts };
}

export function inspect(obj) {
  return util.inspect(obj, { depth: 6, colors: false, compact: false });
}

