// Tests del post-procesado y del contexto de extension/js/services/gas-ai-autocomplete.js.
// El archivo es un script clásico del MAIN world: se carga en un contexto vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../extension/js/services/gas-ai-autocomplete.js', import.meta.url), 'utf8');
const sandbox = { window: {}, document: {}, console };
vm.runInNewContext(src, sandbox);
const { GasAiAutocomplete } = sandbox.window;
const ac = new GasAiAutocomplete(null);

/** Modelo Monaco mínimo a partir de un texto con `|` marcando el cursor. */
function fakeModel(textWithCursor) {
  const offset = textWithCursor.indexOf('|');
  const text = textWithCursor.replace('|', '');
  const lines = text.split('\n');
  const before = text.slice(0, offset).split('\n');
  return {
    model: {
      getValue: () => text,
      getOffsetAt: () => offset,
      getLanguageId: () => 'javascript',
      getLineContent: (n) => lines[n - 1],
      uri: 'inmemory://Config/GlobalParams.gs',
    },
    position: { lineNumber: before.length, column: before[before.length - 1].length + 1 },
  };
}

function ctxFor(textWithCursor, isExplicit = false) {
  const { model, position } = fakeModel(textWithCursor);
  return ac._buildContext_(model, position, isExplicit);
}

// Reproduce el caso de la captura: línea vacía tras `{`, con el cuerpo ya escrito debajo.
const GLOBAL_PARAMS = `(function (thisRef_) {
  |
  /** @const {Object} Configuración centralizada del complemento */
  thisRef_.globalParams = {
    appName: 'Agrocity DocTools',
    colors: {
      primary: '#2F5597',
      accent: '#5E7F1E',
    },
  };
})(this);`;

test('no hay trigger automático en una línea vacía justo antes de un JSDoc existente', () => {
  assert.equal(ctxFor(GLOBAL_PARAMS), null);
  assert.ok(ctxFor(GLOBAL_PARAMS, true), 'a demanda (Ctrl+Shift+Espacio) sí');
});

test('el contexto expone modo, líneas vecinas y nombre de archivo', () => {
  const ctx = ctxFor('function f() {\n  |\n}', false);
  assert.equal(ctx.mode, 'block');
  assert.equal(ctx.prevLine, 'function f() {');
  assert.equal(ctx.nextLine, '}');
  assert.equal(ctxFor('const total = calc|', false).mode, 'inline');
});

test('_completionMode_ distingue los tres casos', () => {
  assert.equal(ac._completionMode_('  const x = foo(', '', '', false), 'inline');
  assert.equal(ac._completionMode_('  if (ok) {', '', '}', false), 'block');
  assert.equal(ac._completionMode_('  const x = fo', '', '', false), 'inline');
  assert.equal(ac._completionMode_('  ', 'function a() {', '}', false), 'block');
  assert.equal(ac._completionMode_('  ', 'foo();', 'bar();', false), 'line');
  assert.equal(ac._completionMode_('  ', 'foo();', 'bar();', true), 'block');
});

test('rechaza una sugerencia que redefine una propiedad existente (accent:)', () => {
  const ctx = ctxFor(GLOBAL_PARAMS, true);
  const out = ac._postProcessCode_(`accent: '#70AD47',       // Verde Agrocity\n  warn: '#FFC000',`, ctx);
  assert.equal(out, '');
});

test('corta en la primera línea que ya existe cerca del cursor', () => {
  const ctx = {
    mode: 'block', linePrefix: '  ',
    prefix: 'function a() {\n  ',
    suffix: '\n  return total;\n}',
  };
  const out = ac._postProcessCode_('let total = 0;\n  total += 1;\n  return total;\n}', ctx);
  assert.equal(out, 'let total = 0;\n  total += 1;');
});

test('en modo line/inline solo deja una línea', () => {
  const ctx = { mode: 'line', linePrefix: '  ', prefix: 'foo();\n  ', suffix: '\nbar();' };
  assert.equal(ac._postProcessCode_('  baz();\n  qux();', ctx), 'baz();');
  const inline = { mode: 'inline', linePrefix: '  const x = ', prefix: '  const x = ', suffix: '' };
  assert.equal(ac._postProcessCode_('compute(1);\nmore();', inline), 'compute(1);');
});

test('en modo block corta donde un cierre excede lo abierto (ya existe en el suffix)', () => {
  const ctx = { mode: 'block', linePrefix: '  ', prefix: 'if (ok) {\n  ', suffix: '\n}' };
  const out = ac._postProcessCode_('log(1);\n  if (x) {\n    y();\n  }\n}\nextra();', ctx);
  assert.equal(out, 'log(1);\n  if (x) {\n    y();\n  }');
});

test('limita el modo block a MAX_BLOCK_LINES', () => {
  const ctx = { mode: 'block', linePrefix: '', prefix: 'function f() {\n', suffix: '\n}' };
  const many = Array.from({ length: 20 }, (_, i) => `step${i}();`).join('\n');
  const out = ac._postProcessCode_(many, ctx);
  assert.equal(out.split('\n').length, GasAiAutocomplete.MAX_BLOCK_LINES);
});

test('re-indenta las líneas siguientes respecto al cursor', () => {
  const ctx = { mode: 'block', linePrefix: '    ', prefix: 'function f() {\n    ', suffix: '\n}' };
  const out = ac._postProcessCode_('    const a = 1;\nconst b = 2;\nif (a) {\n  b++;\n}', ctx);
  assert.equal(out, 'const a = 1;\n    const b = 2;\n    if (a) {\n      b++;\n    }');
});

test('permite sugerencias legítimas que no duplican nada', () => {
  const ctx = { mode: 'inline', linePrefix: '  const sheet = SpreadsheetApp.', prefix: '  const sheet = SpreadsheetApp.', suffix: '\n' };
  assert.equal(ac._postProcessCode_('getActiveSheet();', ctx), 'getActiveSheet();');
});

test('el prompt marca el cursor, el archivo y prohíbe inventar', () => {
  const ctx = ctxFor(GLOBAL_PARAMS, true);
  const prompt = ac._buildPrompt_(ctx);
  assert.match(prompt, /<CURSOR>/);
  assert.match(prompt, /ALREADY EXISTS/);
  assert.match(prompt, /Never invent/);
});
