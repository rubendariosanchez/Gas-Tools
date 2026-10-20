// Tests de i18n: helpers del popup (src/js/utils/I18n.js), DomUtils.t del
// editor y consistencia de las claves entre código y _locales/{en,es}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { flattenMessages, normalizeLanguage, tr } from '../src/js/utils/I18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const EN = readJson('_locales/en/messages.json');
const ES = readJson('_locales/es/messages.json');

/** Lista recursiva de archivos con alguna de las extensiones dadas. */
function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(rel, exts, out); }
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────

test('flattenMessages convierte el formato de Chrome a {key: string}', () => {
  assert.deepEqual(flattenMessages({ a: { message: 'A' }, b: { message: 'B', description: 'x' }, c: {} }), { a: 'A', b: 'B' });
});

test('flattenMessages resuelve placeholders con nombre ($NAME$ → $1)', () => {
  const flat = flattenMessages({
    k: { message: 'Tema "$NAME$" listo', placeholders: { name: { content: '$1' } } },
  });
  assert.equal(flat.k, 'Tema "$1" listo');
});

test('ningún mensaje deja placeholders con nombre sin definir', () => {
  for (const [label, raw] of [['en', EN], ['es', ES]]) {
    const flat = flattenMessages(raw);
    const bad = Object.entries(flat).filter(([, v]) => /\$[A-Za-z_][A-Za-z0-9_]*\$/.test(v)).map(([k]) => k);
    assert.deepEqual(bad, [], `${label}: placeholders sin resolver`);
  }
});

test('normalizeLanguage solo acepta en/es y por defecto usa inglés', () => {
  assert.equal(normalizeLanguage('es'), 'es');
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(normalizeLanguage(null), 'en');
});

test('tr sin diccionario cargado devuelve el fallback con sustituciones', () => {
  assert.equal(tr('noExiste', 'Hola $1, tienes $2', ['Ana', 3]), 'Hola Ana, tienes 3');
});

test('DomUtils.t traduce, cae al inglés y aplica sustituciones', () => {
  const src = fs.readFileSync(path.join(ROOT, 'extension/js/services/dom-utils.js'), 'utf8');
  const ctx = { window: {}, document: {}, console };
  vm.runInNewContext(`${src}\n;globalThis.DomUtils = DomUtils;`, ctx);
  const { DomUtils } = ctx;

  assert.equal(DomUtils.lang(), 'en');
  assert.equal(DomUtils.t('edX', 'Send'), 'Send');

  DomUtils.setI18n({ lang: 'es', messages: { edX: 'Enviar', edCount: '$1 archivos' } });
  assert.equal(DomUtils.lang(), 'es');
  assert.equal(DomUtils.t('edX', 'Send'), 'Enviar');
  assert.equal(DomUtils.t('edCount', '$1 files', 4), '4 archivos');
  assert.equal(DomUtils.t('edMissing', 'Fallback'), 'Fallback');

  DomUtils.setI18n(null);
  assert.equal(DomUtils.t('edX', 'Send'), 'Send');
});

// ── Consistencia de claves ─────────────────────────────────────────────

test('en y es tienen exactamente las mismas claves', () => {
  const enKeys = Object.keys(EN).sort();
  const esKeys = Object.keys(ES).sort();
  assert.deepEqual(enKeys.filter((k) => !ES[k]), [], 'faltan en es');
  assert.deepEqual(esKeys.filter((k) => !EN[k]), [], 'sobran en es');
});

test('los placeholders $n coinciden entre en y es', () => {
  const ph = (s) => (s.match(/\$\d/g) || []).sort().join(',');
  const bad = Object.keys(EN).filter((k) => ES[k] && ph(EN[k].message) !== ph(ES[k].message));
  assert.deepEqual(bad, []);
});

test('toda clave usada en el editor (DomUtils.t) existe en _locales/en', () => {
  const missing = [];
  for (const file of walk('extension/js', ['.js'])) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/DomUtils\.t\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      if (!EN[m[1]]) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('las claves del editor usan el prefijo ed (las únicas que se envían a la página)', () => {
  const bad = [];
  for (const file of walk('extension/js', ['.js'])) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/DomUtils\.t\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      if (!m[1].startsWith('ed')) bad.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('toda clave usada en el popup (tr) existe en _locales/en', () => {
  const missing = [];
  for (const file of [...walk('src/js', ['.js']), ...walk('src/components', ['.js'])]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/\btr\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      if (!EN[m[1]]) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('toda clave data-i18n* de las plantillas HTML existe en _locales/en', () => {
  const missing = [];
  for (const file of [...walk('src/html', ['.html']), ...walk('extension/html', ['.html'])]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) {
      if (!EN[m[1]]) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
