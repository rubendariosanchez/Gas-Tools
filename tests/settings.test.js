// Tests de settings: normalización/migración (Variables.js), cola de
// escritura serializada (WriteQueue.js) y delta del editor (gas-tools-main.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  DEFAULT_SETTINGS_OPTIONS, SETTINGS_SCHEMA_VERSION, normalizeSettings, legacyToBool,
} from '../src/js/utils/Variables.js';
import { createWriteQueue } from '../src/js/utils/WriteQueue.js';

/** Carga el helper `GasSettingsDiff` sin arrancar el bootstrap (guard activo). */
function loadSettingsDiff() {
  const src = fs.readFileSync(new URL('../extension/js/gas-tools-main.js', import.meta.url), 'utf8');
  const ctx = { console };
  ctx.window = { __gasToolsInit: true };
  vm.runInNewContext(src, ctx);
  return ctx.window.GasSettingsDiff;
}

/** Copia a objeto del realm actual (los de vm tienen otro prototipo). */
const plain = (obj) => JSON.parse(JSON.stringify(obj));

// ── normalizeSettings ──────────────────────────────────────────────────

test('normalizeSettings rellena las claves que faltan con los defaults', () => {
  const out = normalizeSettings({ fontSize: 16 });
  assert.equal(out.fontSize, 16);
  assert.equal(out.tabSize, DEFAULT_SETTINGS_OPTIONS.tabSize);
  assert.equal(out.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS_OPTIONS, schemaVersion: SETTINGS_SCHEMA_VERSION });
});

test('normalizeSettings convierte los textos heredados a booleanos', () => {
  const out = normalizeSettings({
    lineNumbers: 'off', renderLineHighlight: 'line', rulers: '',
    occurrencesHighlight: 'singleFile', renderWhitespace: 'boundary',
    autoClosingBrackets: 'never', scrollBeyondLastLine: '',
  });
  assert.deepEqual(
    [out.lineNumbers, out.renderLineHighlight, out.rulers, out.occurrencesHighlight,
      out.renderWhitespace, out.autoClosingBrackets, out.scrollBeyondLastLine],
    [false, true, false, true, true, false, false],
  );
  assert.equal(legacyToBool('desconocido', true), true);
  assert.equal(legacyToBool('none', true), false);
});

test('normalizeSettings es idempotente y no muta la entrada', () => {
  const raw = { lineNumbers: 'on', 'load-snippets': true };
  const once = normalizeSettings(raw);
  assert.deepEqual(normalizeSettings(once), once);
  assert.deepEqual(raw, { lineNumbers: 'on', 'load-snippets': true });
});

test('normalizeSettings elimina load-snippets y conserva claves desconocidas', () => {
  const out = normalizeSettings({ 'load-snippets': false, 'future-flag': 'x' });
  assert.equal('load-snippets' in out, false);
  assert.equal(out['future-flag'], 'x');
});

test('los defaults de los 7 toggles migrados son booleanos', () => {
  ['lineNumbers', 'renderLineHighlight', 'rulers', 'occurrencesHighlight',
    'renderWhitespace', 'autoClosingBrackets', 'scrollBeyondLastLine']
    .forEach((k) => assert.equal(typeof DEFAULT_SETTINGS_OPTIONS[k], 'boolean', k));
  assert.equal('load-snippets' in DEFAULT_SETTINGS_OPTIONS, false);
});

// ── createWriteQueue ───────────────────────────────────────────────────

test('createWriteQueue serializa dos read-modify-write concurrentes', async () => {
  let store = { a: 0, b: 0 };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const write = (key) => async () => {
    const current = { ...store };     // read
    await tick();                     // aquí se colaría la otra escritura sin cola
    store = { ...current, [key]: 1 }; // write
  };
  const enqueue = createWriteQueue();
  await Promise.all([enqueue(write('a')), enqueue(write('b'))]);
  assert.deepEqual(store, { a: 1, b: 1 });
});

test('createWriteQueue sigue procesando tras una tarea fallida', async () => {
  const enqueue = createWriteQueue();
  const failed = enqueue(async () => { throw new Error('boom'); });
  const next = enqueue(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});

// ── diffSettings ───────────────────────────────────────────────────────

test('diffSettings devuelve solo las claves que cambian', () => {
  const { diffSettings } = loadSettingsDiff();
  const prev = { 'global-enable': true, fontSize: 13, fontFamily: 'Roboto Mono', rulers: false };
  assert.deepEqual(plain(diffSettings(prev, { ...prev, fontSize: 14, newKey: 1 })), { fontSize: 14, newKey: 1 });
  assert.deepEqual(plain(diffSettings(prev, { ...prev })), {});
  assert.deepEqual(plain(diffSettings(null, { a: 1 })), { a: 1 });
  assert.deepEqual(plain(diffSettings({ o: { x: 1 } }, { o: { x: 1 } })), {});
});

test('diffSettings detecta un cambio real de global-enable', () => {
  const { diffSettings } = loadSettingsDiff();
  assert.equal('global-enable' in diffSettings({ 'global-enable': true }, { 'global-enable': true }), false);
  assert.equal(diffSettings({ 'global-enable': true }, { 'global-enable': false })['global-enable'], false);
});
