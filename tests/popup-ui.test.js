// Tests del popup (fase 2): esquema declarativo de settings (Variables.js),
// claves i18n del esquema, tokens de diseño compartidos (gas-ui.js) y carga
// del script de tokens desde el HTML del popup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS_OPTIONS, SETTINGS_SCHEMA, SETTINGS_SECTIONS, getSchemaDefaults, isStoredSetting,
} from '../src/js/utils/Variables.js';
import { normalizeSearchText } from '../src/js/modules/settings-renderer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EN = JSON.parse(read('_locales/en/messages.json'));
const ES = JSON.parse(read('_locales/es/messages.json'));

/** Lista recursiva de archivos con alguna de las extensiones dadas. */
function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor') walk(rel, exts, out); }
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** Carga gas-ui.js en un contexto aislado y devuelve `GasUi`. */
function loadGasUi(extra = {}) {
  const ctx = { window: { ...extra } };
  vm.runInNewContext(read('extension/js/shared/gas-ui.js'), ctx);
  return ctx.window.GasUi;
}

// Defaults de la fase 1: el esquema debe reproducirlos exactamente.
const PHASE1_DEFAULTS = {
  'ui-language': 'en',
  'global-enable': true,
  'ai-autocomplete': false,
  'gas-folders': true,
  'gas-file-tabs': false,
  'gas-folders-color': '#5f6368',
  'gas-file-gs-color': '#4086f4',
  'gas-file-html-color': '#fc490b',
  'gas-file-json-color': '#1bb24b',
  'gas-error-lens': true,
  'gas-error-lens-custom-rules': false,
  'debug-mode': false,
  'ide-dark-mode': false,
  'showMinimap': false,
  'lineNumbers': true,
  'wordWrap': true,
  'renderLineHighlight': true,
  'rulers': false,
  'occurrencesHighlight': true,
  'renderWhitespace': false,
  'fontFamily': 'Roboto Mono',
  'fontSize': 13,
  'lineHeight': 19,
  'bracketPairs': true,
  'quickSuggestions': true,
  'autoClosingBrackets': true,
  'guides-indentation': true,
  'folding': true,
  'smoothScrolling': true,
  'scrollBeyondLastLine': false,
  'tabSize': 2,
  'cursorStyle': 'line',
  'cursorBlinking': 'blink',
};

// ── Esquema ────────────────────────────────────────────────────────────

test('cada clave de DEFAULT_SETTINGS_OPTIONS aparece exactamente una vez en el esquema', () => {
  const counts = SETTINGS_SCHEMA.reduce((acc, e) => ({ ...acc, [e.key]: (acc[e.key] || 0) + 1 }), {});
  const bad = Object.keys(DEFAULT_SETTINGS_OPTIONS).filter((k) => counts[k] !== 1);
  assert.deepEqual(bad, []);
  assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 1), [], 'claves duplicadas en el esquema');
});

test('los defaults derivados del esquema coinciden con los de la fase 1', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS_OPTIONS }, PHASE1_DEFAULTS);
});

test('las entradas sync no entran en DEFAULT_SETTINGS_OPTIONS y tienen storageKey', () => {
  SETTINGS_SCHEMA.filter((e) => !isStoredSetting(e)).forEach((e) => {
    assert.equal(e.key in DEFAULT_SETTINGS_OPTIONS, false, e.key);
    assert.equal(typeof e.storageKey, 'string', e.key);
  });
});

test('el esquema es coherente: tipos, secciones, padres y opciones', () => {
  const sectionIds = new Set(SETTINGS_SECTIONS.map((s) => s.id));
  const byKey = Object.fromEntries(SETTINGS_SCHEMA.map((e) => [e.key, e]));
  for (const e of SETTINGS_SCHEMA) {
    assert.ok(['toggle', 'select', 'color'].includes(e.type), `${e.key}: tipo`);
    if (e.tab !== 'header') assert.ok(sectionIds.has(e.section), `${e.key}: sección`);
    if (e.parent) assert.equal(byKey[e.parent]?.type, 'toggle', `${e.key}: padre`);
    if (e.type === 'toggle') assert.equal(typeof e.default, 'boolean', `${e.key}: default booleano`);
    if (e.type === 'select') {
      assert.ok(e.options.some((o) => o.value === String(e.default)), `${e.key}: default en opciones`);
      // El componente serializa las opciones como "valor:etiqueta,…".
      e.options.forEach((o) => assert.ok(!/[,:]/.test(o.value + o.label), `${e.key}: separadores`));
    }
  }
});

test('el reset solo cubre Editor y Herramientas', () => {
  const resetKeys = Object.keys(getSchemaDefaults(['editor', 'tools']));
  ['ui-language', 'global-enable', 'ai-autocomplete', 'ide-dark-mode', 'aiResponseLanguage']
    .forEach((k) => assert.equal(resetKeys.includes(k), false, k));
  ['fontSize', 'gas-folders', 'debug-mode'].forEach((k) => assert.ok(resetKeys.includes(k), k));
});

test('normalizeSearchText ignora mayúsculas y tildes', () => {
  assert.equal(normalizeSearchText('  Tipografía ÁRBOL '), 'tipografia arbol');
  assert.equal(normalizeSearchText(null), '');
});

// ── i18n ───────────────────────────────────────────────────────────────

test('cada clave i18n del esquema y de las secciones existe en EN y ES', () => {
  const keys = [
    ...SETTINGS_SCHEMA.flatMap((e) => [e.i18n.title, e.i18n.description]),
    ...SETTINGS_SECTIONS.map((s) => s.i18n),
  ];
  assert.deepEqual(keys.filter((k) => !EN[k]), [], 'faltan en en');
  assert.deepEqual(keys.filter((k) => !ES[k]), [], 'faltan en es');
});

test('las claves data-search-i18n del popup existen en EN y ES', () => {
  const missing = [];
  for (const m of read('src/html/index.html').matchAll(/data-search-i18n="([^"]+)"/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((k) => { if (!EN[k] || !ES[k]) missing.push(k); });
  }
  assert.deepEqual(missing, []);
});

// ── Tokens de diseño (gas-ui.js) ───────────────────────────────────────

test('gas-ui.js define todos los --gt-* usados en src/', () => {
  const { TOKENS_CSS } = loadGasUi();
  const defined = new Set([...TOKENS_CSS.matchAll(/(--gt-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const missing = [];
  for (const file of walk('src', ['.js', '.css', '.html'])) {
    for (const m of read(file).matchAll(/var\(\s*(--gt-[a-z0-9-]+)/g)) {
      if (!defined.has(m[1])) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('el modo oscuro redefine todos los colores del modo claro', () => {
  const { TOKENS_CSS } = loadGasUi();
  const [light, dark] = TOKENS_CSS.split('body.qc__is-dark-mode');
  const colorTokens = (css) => new Set(
    [...css.matchAll(/(--gt-[a-z0-9-]+)\s*:\s*(#|rgba?\()/g)].map((m) => m[1]),
  );
  const darkTokens = colorTokens(dark);
  assert.deepEqual([...colorTokens(light)].filter((t) => !darkTokens.has(t)), []);
});

test('GasUi se instala una sola vez y installTokens es idempotente', () => {
  const nodes = [];
  const doc = {
    head: { firstChild: null, insertBefore: (el) => nodes.push(el) },
    createElement: () => ({}),
    getElementById: (id) => nodes.find((n) => n.id === id) || null,
  };
  const GasUi = loadGasUi();
  assert.equal(GasUi.installTokens(doc), true);
  assert.equal(GasUi.installTokens(doc), true);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, GasUi.STYLE_ID);
  assert.equal(GasUi.installTokens(null), false);

  const existing = { marker: true };
  assert.equal(loadGasUi({ GasUi: existing }), existing, 'respeta una instalación previa');
});

test('el popup carga gas-ui.js (ruta válida) antes del módulo principal', () => {
  const html = read('src/html/index.html');
  const src = html.match(/<script src="([^"]*gas-ui\.js)"><\/script>/)?.[1];
  assert.ok(src, 'falta el <script> de gas-ui.js');
  assert.ok(fs.existsSync(path.resolve(ROOT, 'src/html', src)), `ruta inexistente: ${src}`);
  assert.ok(html.indexOf(src) < html.indexOf('type="module"'), 'debe ir antes del módulo');
});

test('src/ y extension/ no cargan Google Fonts ni usan la clase material-symbols', () => {
  // Única excepción: la fuente monoespaciada que el usuario elige para Monaco (gas-tools.js).
  const FONT_ALLOW = new Set([path.join('extension', 'js', 'gas-tools.js')]);
  const offenders = [];
  for (const file of [...walk('src', ['.js', '.html', '.css']), ...walk('extension', ['.js', '.html', '.css'])]) {
    const src = read(file);
    if (/material-symbols/.test(src)) offenders.push(`${file}: clase material-symbols`);
    if (/fonts\.(googleapis|gstatic)\.com/.test(src) && !FONT_ALLOW.has(file)) offenders.push(`${file}: Google Fonts`);
  }
  assert.deepEqual(offenders, []);
});

test('cada icono usado en src/ existe en el registro de GasUi', () => {
  const names = new Set(loadGasUi().ICON_NAMES);
  const used = new Map();
  const patterns = [
    /data-icon(?:-active)?="([^"]+)"/g,
    /\b(?:icon|createIcon)\(\s*'([^']+)'/g,
    /\bicon:\s*'([^']+)'/g,
  ];
  for (const file of walk('src', ['.js', '.html'])) {
    const src = read(file);
    for (const re of patterns) {
      for (const m of src.matchAll(re)) used.set(m[1], file);
    }
  }
  const cssIcons = read('src/js/utils/Icons.js').match(/CSS_ICONS = \{([^}]*)\}/)?.[1] || '';
  for (const m of cssIcons.matchAll(/:\s*'([^']+)'/g)) used.set(m[1], 'src/js/utils/Icons.js');
  for (const s of SETTINGS_SECTIONS) used.set(s.icon, 'Variables.js');
  assert.ok(used.size > 20, 'no se detectaron usos de iconos');
  const missing = [...used].filter(([name]) => !names.has(name)).map(([n, f]) => `${f}: ${n}`);
  assert.deepEqual(missing, []);
});
