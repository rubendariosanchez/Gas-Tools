// Tests de Error Lens: reglas personalizadas (puras) y selección de markers inline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '..', 'extension', 'js', 'services', 'gas-error-lens.js'),
  'utf8'
);

/** Carga el script clásico en un contexto aislado con stubs mínimos. */
function loadLens_() {
  const listeners = {};
  const context = {
    setTimeout, clearTimeout, console,
    document: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      getElementById: () => null,
    },
    DomUtils: { debounce: (fn) => Object.assign(fn, { cancel() {} }) },
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'gas-error-lens.js' });
  const lens = context.window.gasErrorLens;
  return { lens, GasErrorLens: lens.constructor, context, listeners };
}

const { lens, GasErrorLens } = loadLens_();
const lint = (code) => Array.from(lens.lintText(code));
const codes = (code) => lint(code).map((m) => m.code);

// ── Sin falsos positivos ────────────────────────────────────────────────────

test('const from = 0 no se marca', () => {
  assert.deepEqual(codes('const from = 0;'), []);
});

test('if (x) return; foo(); no es código inalcanzable', () => {
  assert.deepEqual(codes('function f(x) {\n  if (x) return; foo();\n}'), []);
});

test('.then() encadenado en la línea siguiente no pide punto y coma', () => {
  const code = [
    'function f() {',
    '  fetchData()',
    '    .then((r) => r.json())',
    '    .then((d) => use(d));',
    '}',
  ].join('\n');
  assert.deepEqual(codes(code), []);
});

test('regex literals no generan falsos positivos', () => {
  const code = [
    'const re = /[{(]\\/"\'`=/g;',
    'const ok = /a==b/.test(s);',
  ].join('\n');
  assert.deepEqual(codes(code), []);
});

test('template strings (incluso multilínea) no generan falsos positivos', () => {
  const code = [
    'const name = "x";',
    'const html = `<div class="${name}">',
    '  { ( [ == const = 1',
    '</div>`;',
  ].join('\n');
  assert.deepEqual(codes(code), []);
});

test('jQuery $(\'#a\').on(...) no genera falsos positivos', () => {
  const code = [
    "$('#a').on('click', function (e) {",
    '  e.preventDefault();',
    '});',
  ].join('\n');
  assert.deepEqual(codes(code), []);
});

test('objetos literales multilínea no piden punto y coma', () => {
  const code = [
    'const cfg = {',
    '  a: 1,',
    '  b: { c: 2 },',
    '  d: [1, 2]',
    '};',
  ].join('\n');
  assert.deepEqual(codes(code), []);
});

// ── Positivos reales ────────────────────────────────────────────────────────

test('reasignación de const se detecta', () => {
  const markers = lint('const LIMIT = 5;\nLIMIT = 6;');
  const hit = markers.find((m) => m.code === 'const-reassignment');
  assert.ok(hit, 'debe reportar const-reassignment');
  assert.equal(hit.startLineNumber, 2);
  assert.equal(hit.severity, GasErrorLens.SEVERITY.Error);
});

test('código tras un return; independiente es inalcanzable', () => {
  const markers = lint('function f() {\n  return; foo();\n}');
  const hit = markers.find((m) => m.code === 'unreachable');
  assert.ok(hit, 'debe reportar unreachable');
  assert.equal(hit.startLineNumber, 2);
});

// ── Selección de markers inline ─────────────────────────────────────────────

const mk = (line, severity, message, col = 1) => ({
  startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + 1,
  severity, message,
});

test('selectInlineMarkers escoge el de mayor severidad por línea', () => {
  const S = GasErrorLens.SEVERITY;
  const selected = Array.from(GasErrorLens.selectInlineMarkers([
    mk(3, S.Hint, 'hint 3'),
    mk(1, S.Warning, 'warn 1'),
    mk(1, S.Error, "';' expected"),
    mk(1, S.Info, 'info 1'),
    mk(3, S.Warning, 'warn 3'),
  ]));
  assert.deepEqual(selected.map((m) => [m.startLineNumber, m.message]), [
    [1, "';' expected"],
    [3, 'warn 3'],
  ]);
});

test('selectInlineMarkers devuelve un solo mensaje por línea con duplicados', () => {
  const S = GasErrorLens.SEVERITY;
  const selected = Array.from(GasErrorLens.selectInlineMarkers([
    mk(2, S.Error, "';' expected"),
    mk(2, S.Error, "';' expected"),
  ]));
  assert.equal(selected.length, 1);
});

test('dedupeMarkers elimina el mismo diagnóstico reportado por varios owners', () => {
  const S = GasErrorLens.SEVERITY;
  const out = GasErrorLens.dedupeMarkers([
    mk(2, S.Error, "';' expected."),
    mk(2, S.Error, "';' expected"),
    mk(2, S.Error, 'Other', 5),
  ]);
  assert.equal(out.length, 2);
});

// ── API de reglas personalizadas ────────────────────────────────────────────

test('setCustomRulesEnabled es seguro sin Monaco y por defecto está desactivado', () => {
  const { lens: fresh } = loadLens_();
  assert.equal(fresh.isCustomRulesEnabled(), false);
  fresh.setCustomRulesEnabled(true);
  assert.equal(fresh.isCustomRulesEnabled(), true);
  fresh.setCustomRulesEnabled(false);
  assert.equal(fresh.isCustomRulesEnabled(), false);
});

test('al desactivar reglas se limpian los markers propios', () => {
  const { lens: fresh, context, GasErrorLens: Cls } = loadLens_();
  const calls = [];
  const model = {
    uri: 'inmemory://model/1',
    getLanguageId: () => 'javascript',
    getLineCount: () => 2,
    getLineContent: (n) => ['const A = 1;', 'A = 2;'][n - 1],
    onDidChangeContent: () => ({ dispose() {} }),
  };
  const noop = () => ({ dispose() {} });
  context.monaco = {
    editor: {
      onDidChangeMarkers: noop, onWillDisposeModel: noop,
      onDidCreateModel: noop, onDidCreateEditor: noop,
      getModels: () => [model],
      getModelMarkers: () => [],
      setModelMarkers: (m, owner, markers) => calls.push([owner, markers.length]),
    },
  };
  context.document.head = { appendChild() {} };
  context.document.createElement = () => ({});
  fresh.enable();
  assert.equal(calls.length, 0, 'sin reglas no se publica nada');
  fresh.setCustomRulesEnabled(true);
  assert.deepEqual(calls.at(-1), [Cls.MARKER_SOURCE, 1]);
  fresh.setCustomRulesEnabled(false);
  assert.deepEqual(calls.at(-1), [Cls.MARKER_SOURCE, 0]);
  fresh.disable();
});
