import fs from 'node:fs';
import path from 'node:path';

import { fail } from './sx3-lib.js';
import {
  getStorePath,
  isSha256Hex,
  normalizeRef,
  resolveStoreDir,
  sha256File,
  storePutBundleFile,
  validateBundleV1,
} from './sx3-store.js';

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Patch Store v1 (local FS)

Usage:
  sx3 store put --bundle <file.zip> [--store-dir <dir>]
  sx3 store get <sha256|sha256:...> [--out <path>] [--store-dir <dir>]
  sx3 store verify <sha256|sha256:...> [--deep] [--store-dir <dir>]
  sx3 store gc [--keep-days 30] [--dry-run] [--store-dir <dir>]

Env:
  - SMMTRYX3_STORE_DIR=/path/to/store

Bundle v1 (минимум внутри zip):
  - meta.json
  - patch.diff
  - deliverables.json
`);
}

export async function run(opts, sub, rest) {
  if (!sub || sub === 'help' || (opts && opts.help)) {
    printHelp();
    return;
  }

  const storeDir = resolveStoreDir(opts);
  fs.mkdirSync(storeDir, { recursive: true });

  if (sub === 'put') {
    const bundlePath = opts && typeof opts.bundle === 'string' ? String(opts.bundle) : '';
    if (!bundlePath) fail('store put: требуется --bundle <file.zip>', 2);
    if (!fs.existsSync(bundlePath)) fail(`store put: файл не найден: ${bundlePath}`, 2);

    const { uri, sha256, size, path: dst } = storePutBundleFile(opts, bundlePath);

    // eslint-disable-next-line no-console
    console.log(`[sx3 store put] ok=1 uri=${uri} sha256=${sha256} size=${size} path=${dst}`);
    return;
  }

  if (sub === 'get') {
    const ref = normalizeRef(rest[0]);
    if (!isSha256Hex(ref)) fail('store get: ожидался <sha256> или sha256:<sha256>', 2);
    const src = getStorePath(storeDir, ref);
    if (!fs.existsSync(src)) fail(`store get: не найдено в store: ${ref}`, 2);

    const outPath = opts && typeof opts.out === 'string' ? String(opts.out) : '';
    if (outPath) {
      fs.copyFileSync(src, outPath);
      // eslint-disable-next-line no-console
      console.log(`[sx3 store get] ok=1 uri=sha256:${ref} out=${path.resolve(outPath)}`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(src);
    return;
  }

  if (sub === 'verify') {
    const ref = normalizeRef(rest[0]);
    if (!isSha256Hex(ref)) fail('store verify: ожидался <sha256> или sha256:<sha256>', 2);
    const p = getStorePath(storeDir, ref);
    if (!fs.existsSync(p)) fail(`store verify: не найдено в store: ${ref}`, 2);

    const { hex } = sha256File(p);
    if (hex.toLowerCase() !== ref.toLowerCase()) {
      fail(`store verify: sha256 mismatch (expected ${ref}, got ${hex})`, 2);
    }

    if (opts && opts.deep) validateBundleV1(p);

    // eslint-disable-next-line no-console
    console.log(`[sx3 store verify] ok=1 uri=sha256:${ref}`);
    return;
  }

  if (sub === 'gc') {
    const keepDaysRaw = opts && typeof opts['keep-days'] === 'string' ? String(opts['keep-days']) : '';
    const keepDays = keepDaysRaw ? Number(keepDaysRaw) : 30;
    if (!Number.isFinite(keepDays) || keepDays < 0) fail('store gc: --keep-days должен быть числом >= 0', 2);

    const dryRun = Boolean(opts && opts['dry-run']);
    const now = Date.now();
    const cutoffMs = keepDays * 24 * 60 * 60 * 1000;

    const files = fs.readdirSync(storeDir);
    let scanned = 0;
    let deleted = 0;
    let bytes = 0;

    for (const f of files) {
      if (!/^[0-9a-f]{64}\.zip$/i.test(f)) continue;
      scanned++;
      const full = path.join(storeDir, f);
      const st = fs.statSync(full);
      const ageMs = now - st.mtimeMs;
      if (ageMs <= cutoffMs) continue;
      bytes += st.size;
      if (!dryRun) fs.unlinkSync(full);
      deleted++;
    }

    // eslint-disable-next-line no-console
    console.log(`[sx3 store gc] ok=1 scanned=${scanned} deleted=${deleted} bytes=${bytes} dry_run=${dryRun ? 1 : 0}`);
    return;
  }

  fail(`sx3 store: неизвестная подкоманда: ${sub}`, 2);
}

