// Tests del protocolo de ediciones del LLM (extension/js/shared/edit-blocks.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Carga un script clásico en un contexto vm y devuelve el global indicado. */
function loadClassic(rel, globalName, deps = []) {
  const ctx = vm.createContext({ console });
  for (const dep of [...deps, rel]) vm.runInContext(fs.readFileSync(new URL(`../${dep}`, import.meta.url), 'utf8'), ctx);
  vm.runInContext(`globalThis.${globalName} = ${globalName};`, ctx);
  return ctx[globalName];
}

const GasEditBlocks = loadClassic('extension/js/shared/edit-blocks.js', 'GasEditBlocks', ['extension/js/shared/edit-applier.js']);
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

const SINGLE = [
  'I will rename the function.',
  '',
  '<<<FILE path="Core/CalcTools.gs" action="edit">>>',
  '<<<<<<< SEARCH',
  'function sum(a, b) {',
  '=======',
  'function add(a, b) {',
  '>>>>>>> REPLACE',
  '<<<END>>>',
  '',
  'Done.',
].join('\n');

// ── FORMAT_INSTRUCTIONS ────────────────────────────────────────────────

test('FORMAT_INSTRUCTIONS describe el formato y las reglas', () => {
  const t = GasEditBlocks.FORMAT_INSTRUCTIONS;
  for (const s of ['<<<FILE path="Core/CalcTools.gs" action="edit">>>', '<<<<<<< SEARCH', '=======',
    '>>>>>>> REPLACE', '<<<END>>>', 'action="create"', 'verbatim', 'unique', 'empty', 'fences']) {
    assert.ok(t.includes(s), `falta: ${s}`);
  }
  assert.ok(Object.isFrozen(GasEditBlocks));
});

// ── parse ──────────────────────────────────────────────────────────────

test('parse: bloque único con prosa', () => {
  const r = GasEditBlocks.parse(SINGLE);
  eq(r, {
    prose: 'I will rename the function.\n\nDone.',
    files: [{ path: 'Core/CalcTools.gs', action: 'edit', hunks: [{ search: 'function sum(a, b) {', replace: 'function add(a, b) {' }], content: '' }],
    partial: false,
  });
});

test('parse: varios archivos, varios hunks, create y REPLACE vacío', () => {
  const text = [
    'Intro',
    '<<<FILE path="A.gs" action="edit">>>',
    '<<<<<<< SEARCH',
    '  const x = 1;',
    '  const y = 2;',
    '=======',
    '  const x = 10;',
    '>>>>>>> REPLACE',
    '<<<<<<< SEARCH',
    'log();',
    '=======',
    '>>>>>>> REPLACE',
    '<<<END>>>',
    'Middle',
    '<<<FILE path="Utils/Dates.gs" action="create">>>',
    'function today() {',
    '  return new Date();',
    '}',
    '<<<END>>>',
  ].join('\n');
  const r = GasEditBlocks.parse(text);
  assert.equal(r.partial, false);
  assert.equal(r.prose, 'Intro\nMiddle');
  eq(r.files[0].hunks, [
    { search: '  const x = 1;\n  const y = 2;', replace: '  const x = 10;' },
    { search: 'log();', replace: '' },
  ]);
  eq(r.files[1], { path: 'Utils/Dates.gs', action: 'create', hunks: [], content: 'function today() {\n  return new Date();\n}' });
});

test('parse: tolera vallas markdown que solo envuelven bloques', () => {
  const text = `Explanation here.\n\n\`\`\`\n${SINGLE.split('\n').slice(2, 9).join('\n')}\n\`\`\`\n\nBye`;
  const r = GasEditBlocks.parse(text);
  assert.equal(r.prose, 'Explanation here.\n\nBye');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].hunks[0].replace, 'function add(a, b) {');
});

test('parse: vallas con lenguaje y varias vallas consecutivas', () => {
  const blk = (p) => `<<<FILE path="${p}" action="create">>>\nx\n<<<END>>>`;
  const text = `\`\`\`javascript\n${blk('A.gs')}\n\`\`\`\n\`\`\`\n${blk('B.gs')}\n\`\`\``;
  const r = GasEditBlocks.parse(text);
  assert.equal(r.prose, '');
  eq(r.files.map((f) => f.path), ['A.gs', 'B.gs']);
});

test('parse: no elimina bloques de código normales en la prosa', () => {
  const text = 'Example:\n```js\nconst a = 1;\n```\n' + SINGLE.split('\n').slice(2, 9).join('\n');
  const r = GasEditBlocks.parse(text);
  assert.equal(r.prose, 'Example:\n```js\nconst a = 1;\n```');
  assert.equal(r.files.length, 1);
});

test('parse: CRLF, espacios extra en marcadores y comillas simples', () => {
  const text = [
    "<<< FILE  path = 'Core/X.gs'   action = 'edit' >>>",
    '<<<<<<<  SEARCH  ',
    'a',
    '=======  ',
    'b',
    '>>>>>>>   REPLACE',
    '<<< END >>>',
  ].join('\r\n');
  const r = GasEditBlocks.parse(text);
  eq(r.files, [{ path: 'Core/X.gs', action: 'edit', hunks: [{ search: 'a', replace: 'b' }], content: '' }]);
});

test('parse: sin action → edit si hay SEARCH, create si no', () => {
  const text = [
    '<<<FILE path="A.gs">>>', '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', '<<<END>>>',
    '<<<FILE path="B.gs">>>', 'full', '<<<END>>>',
  ].join('\n');
  const r = GasEditBlocks.parse(text);
  eq(r.files.map((f) => f.action), ['edit', 'create']);
  assert.equal(r.files[1].content, 'full');
});

test('parse: create envuelto en valla interna se desenvuelve', () => {
  const r = GasEditBlocks.parse('<<<FILE path="A.gs" action="create">>>\n```javascript\nconst a = 1;\n```\n<<<END>>>');
  assert.equal(r.files[0].content, 'const a = 1;');
});

test('parse: streaming parcial incluye hunks completos y marca partial', () => {
  const text = [
    'Working on it',
    '<<<FILE path="A.gs" action="edit">>>',
    '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE',
    '<<<<<<< SEARCH', 'c', '=======', 'd',
  ].join('\n');
  const r = GasEditBlocks.parse(text);
  assert.equal(r.partial, true);
  assert.equal(r.prose, 'Working on it');
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].partial, true);
  eq(r.files[0].hunks, [{ search: 'a', replace: 'b' }]);
});

test('parse: streaming parcial dentro de valla', () => {
  const r = GasEditBlocks.parse('```\n<<<FILE path="N.gs" action="create">>>\nline1\nline2');
  assert.equal(r.partial, true);
  assert.equal(r.files[0].content, 'line1\nline2');
  assert.equal(r.prose, '');
});

test('parse: texto sin bloques devuelve solo prosa', () => {
  eq(GasEditBlocks.parse('Hello\n\n\n\nWorld\n'), { prose: 'Hello\n\nWorld', files: [], partial: false });
  eq(GasEditBlocks.parse(''), { prose: '', files: [], partial: false });
});

test('hasBlocks y pendingPath', () => {
  assert.equal(GasEditBlocks.hasBlocks(SINGLE), true);
  assert.equal(GasEditBlocks.hasBlocks('plain text <<< nothing'), false);
  assert.equal(GasEditBlocks.pendingPath(SINGLE), null);
  assert.equal(GasEditBlocks.pendingPath('no blocks'), null);
  assert.equal(GasEditBlocks.pendingPath(`${SINGLE}\n<<<FILE path='Next/File.gs' action="edit">>>\n<<<<<<< SEARCH`), 'Next/File.gs');
});

// ── applyHunks ─────────────────────────────────────────────────────────

const ORIGINAL = [
  'function main() {',
  '  const a = 1;',
  '  const b = 2;',
  '  return a + b;',
  '}',
].join('\n');

test('applyHunks: coincidencia exacta', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [{ search: '  const b = 2;', replace: '  const b = 3;' }]);
  assert.equal(r.applied, 1);
  eq(r.failed, []);
  assert.ok(r.proposed.includes('  const b = 3;'));
});

test('applyHunks: varios hunks secuenciales', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [
    { search: 'function main() {', replace: 'function run() {' },
    { search: '  return a + b;', replace: '  return a * b;' },
  ]);
  assert.equal(r.applied, 2);
  assert.equal(r.proposed, ORIGINAL.replace('main', 'run').replace('a + b', 'a * b'));
});

test('applyHunks: ignora espacios finales', () => {
  const orig = 'line one   \nline two\t\nline three';
  const r = GasEditBlocks.applyHunks(orig, [{ search: 'line one\nline two', replace: 'LINE' }]);
  assert.equal(r.applied, 1);
  assert.equal(r.proposed, 'LINE\nline three');
});

test('applyHunks: ignora indentación y reindenta el reemplazo', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [{
    search: 'const a = 1;\nconst b = 2;',
    replace: 'const a = 1;\nif (a) {\n  log(a);\n}',
  }]);
  assert.equal(r.applied, 1);
  assert.equal(r.proposed, [
    'function main() {',
    '  const a = 1;',
    '  if (a) {',
    '    log(a);',
    '  }',
    '  return a + b;',
    '}',
  ].join('\n'));
});

test('applyHunks: reindentación con indentación base distinta (4 espacios → 2)', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [{
    search: '    const a = 1;',
    replace: '    const a = 5;\n      // nested',
  }]);
  assert.equal(r.applied, 1);
  assert.ok(r.proposed.includes('  const a = 5;\n    // nested\n  const b = 2;'));
});

test('applyHunks: borrado con REPLACE vacío', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [{ search: '  const b = 2;\n', replace: '' }]);
  assert.equal(r.applied, 1);
  assert.ok(!r.proposed.includes('const b'));
  assert.equal(r.proposed.split('\n').length, 4);
});

test('applyHunks: borrado de líneas en modo indentación', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [{ search: 'const b = 2;', replace: '' }].map((h) => ({ ...h, search: `\t${h.search}` })));
  assert.equal(r.applied, 1);
  assert.equal(r.proposed, 'function main() {\n  const a = 1;\n  return a + b;\n}');
});

test('applyHunks: reporta fallos sin interrumpir los demás', () => {
  const r = GasEditBlocks.applyHunks(ORIGINAL, [
    { search: 'does not exist', replace: 'x' },
    { search: '  return a + b;', replace: '  return 0;' },
    { search: '', replace: 'y' },
  ]);
  assert.equal(r.applied, 1);
  eq(r.failed, [
    { index: 0, search: 'does not exist', reason: 'not-found' },
    { index: 2, search: '', reason: 'empty-search' },
  ]);
  assert.ok(r.proposed.includes('return 0;'));
});

test('applyHunks: SEARCH vacío en archivo vacío reemplaza todo', () => {
  const r = GasEditBlocks.applyHunks('', [{ search: '', replace: 'new content' }]);
  eq(r, { proposed: 'new content', applied: 1, failed: [] });
});

test('applyHunks: preserva CRLF del original', () => {
  const orig = ORIGINAL.replace(/\n/g, '\r\n');
  const r = GasEditBlocks.applyHunks(orig, [{ search: 'const a = 1;\r\n  const b = 2;', replace: 'const a = 7;\n  const b = 8;' }]);
  assert.equal(r.applied, 1);
  assert.equal(r.proposed, ORIGINAL.replace('1;', '7;').replace('2;', '8;').replace(/\n/g, '\r\n'));
  assert.ok(!/[^\r]\n/.test(r.proposed));
});

test('applyHunks: original LF y reemplazo CRLF se normaliza a LF', () => {
  const r = GasEditBlocks.applyHunks('a\nb', [{ search: 'b', replace: 'c\r\nd' }]);
  assert.equal(r.proposed, 'a\nc\nd');
});

// Fase 4: un SEARCH con varias apariciones ya no toma la primera en silencio.
test('applyHunks: con múltiples apariciones es ambiguo y no se aplica', () => {
  const r = GasEditBlocks.applyHunks('x\nx\n', [{ search: 'x', replace: 'y' }]);
  assert.equal(r.proposed, 'x\nx\n');
  eq(r.failed, [{ index: 0, search: 'x', reason: 'ambiguous' }]);
});

test('applyHunks: el segundo hunk se busca después del primero', () => {
  const r = GasEditBlocks.applyHunks('a\nx\nb\nx\n', [{ search: 'b', replace: 'B' }, { search: 'x', replace: 'X' }]);
  assert.equal(r.proposed, 'a\nx\nB\nX\n');
  eq(r.failed, []);
});

test('formatFeedback: explica los SEARCH ambiguos', () => {
  const txt = GasEditBlocks.formatFeedback([{ index: 0, search: 'x', reason: 'ambiguous' }], 'x\nx');
  assert.match(txt, /add more surrounding context/);
});

// ── formatFeedback ─────────────────────────────────────────────────────

test('formatFeedback: lista los SEARCH fallidos y sugiere líneas cercanas', () => {
  const failed = [{ index: 1, search: 'const b = 3;', reason: 'not-found' }];
  const txt = GasEditBlocks.formatFeedback(failed, ORIGINAL);
  assert.ok(txt.includes('1 SEARCH block(s)'));
  assert.ok(txt.includes('Block #2'));
  assert.ok(txt.includes('const b = 3;'));
  assert.ok(txt.includes('exactly'));
  assert.equal(GasEditBlocks.formatFeedback([], ORIGINAL), '');
});

test('formatFeedback: incluye región cercana cuando la primera línea existe', () => {
  const failed = [{ index: 0, search: 'const a = 1;\nconst c = 9;', reason: 'not-found' }];
  const txt = GasEditBlocks.formatFeedback(failed, ORIGINAL);
  assert.ok(txt.includes('Closest lines in the current file:'));
  assert.ok(txt.includes('  const b = 2;'));
});
