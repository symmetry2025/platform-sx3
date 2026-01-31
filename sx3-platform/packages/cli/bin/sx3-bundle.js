import fs from 'node:fs';

import AdmZip from 'adm-zip';

import { fail } from './sx3-lib.js';

export function readBundleEntryText(zipPath, entryName) {
  try {
    const zip = new AdmZip(zipPath);
    const e = zip.getEntry(entryName);
    if (!e) fail(`bundle: отсутствует файл в архиве: ${entryName}`, 2);
    return zip.readAsText(e);
  } catch (err) {
    const msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
    fail(`bundle: не удалось прочитать архив: ${msg}`, 2);
  }
}

export function ensureFileExists(p, humanName) {
  if (!p) fail(`${humanName}: path пустой`, 2);
  if (!fs.existsSync(p)) fail(`${humanName}: файл не найден: ${p}`, 2);
}

