// Verifica que todos los scripts de la extensión parsean. Los scripts
// clásicos (content script, MAIN world, side panel) se compilan con
// vm.Script, igual que los carga Chrome; los módulos ES (background y sus
// servicios, popup) con `node --check`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(rel, out); }
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const isModule = (src) => /^\s*(import|export)\s/m.test(src);

test('todos los scripts de la extensión y del popup parsean', () => {
  const errors = [];
  for (const file of [...walk('extension'), ...walk('src')]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      if (isModule(src)) execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
      else new vm.Script(src, { filename: file });
    } catch (err) {
      errors.push(`${file}: ${String(err.stderr || err.message).split('\n').find((l) => /Error/.test(l)) || err.message}`);
    }
  }
  assert.deepEqual(errors, []);
});

test('ningún chrome.runtime.onMessage listener es async (Chrome usaría la Promise como respuesta)', () => {
  const bad = [];
  for (const file of [...walk('extension'), ...walk('src')]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (/runtime\.onMessage\.addListener\(\s*async\b/.test(src)) bad.push(file);
  }
  assert.deepEqual(bad, []);
});
