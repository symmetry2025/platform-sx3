import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

import { fail } from './sx3-lib.js';

export function getDefaultStoreDir() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'smmtryx3', 'store');
}

export function resolveStoreDir(opts) {
  const fromEnv = process.env.SMMTRYX3_STORE_DIR;
  const fromFlag = opts && typeof opts['store-dir'] === 'string' ? opts['store-dir'] : null;
  return path.resolve(fromFlag || fromEnv || getDefaultStoreDir());
}

export function normalizeRef(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  if (s.startsWith('sha256:')) return s.slice('sha256:'.length);
  return s;
}

export function isSha256Hex(s) {
  return /^[0-9a-f]{64}$/i.test(String(s || ''));
}

export function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  h.update(data);
  return { hex: h.digest('hex'), size: data.length };
}

export function getStorePath(storeDir, sha256Hex) {
  return path.join(storeDir, `${sha256Hex}.zip`);
}

export function validateBundleV1(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    const entries = new Set(zip.getEntries().map((e) => e.entryName));
    const required = ['meta.json', 'patch.diff', 'deliverables.json'];
    const missing = required.filter((r) => !entries.has(r));
    if (missing.length > 0) {
      fail(`store: bundle не соответствует v1 (не хватает: ${missing.join(', ')})`, 2);
    }
  } catch (e) {
    const msg = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e);
    fail(`store: не удалось прочитать zip: ${msg}`, 2);
  }
}

export function storePutBundleFile(opts, bundlePath) {
  const storeDir = resolveStoreDir(opts);
  fs.mkdirSync(storeDir, { recursive: true });

  if (!bundlePath) fail('store put: требуется bundlePath', 2);
  if (!fs.existsSync(bundlePath)) fail(`store put: файл не найден: ${bundlePath}`, 2);

  validateBundleV1(bundlePath);

  const { hex, size } = sha256File(bundlePath);
  const dst = getStorePath(storeDir, hex);
  fs.copyFileSync(bundlePath, dst);
  return { uri: `sha256:${hex}`, sha256: hex, size, path: dst, storeDir };
}

