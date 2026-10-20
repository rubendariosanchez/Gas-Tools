// Tests de los helpers puros del chat (GasChatContext en gas-chat-panel.js):
// elegibilidad del botón "Preview" y recorte a la ventana de contexto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Carga un script clásico en un contexto vm (con stubs mínimos del DOM). */
function loadClassic(rel, globals, ctx) {
  const src = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  vm.runInNewContext(`${src}\n;${globals.map((g) => `globalThis.${g} = ${g};`).join('')}`, ctx);
}

const ctx = {
  console,
  HTMLElement: class {},
  customElements: { get: () => true, define: () => {} },
  DomUtils: { t: (k, f) => f },
};
loadClassic('extension/js/shared/line-diff.js', ['GasLineDiff'], ctx);
loadClassic('extension/js/components/gas-chat-panel.js', ['GasChatContext'], ctx);
const { GasChatContext: C, GasLineDiff } = ctx;

const FILE = [
  '/** Parámetros globales. */',
  'const SHEET_ID = "abc";',
  'function getConfig() {',
  '  const props = PropertiesService.getScriptProperties();',
  '  return props.getProperties();',
  '}',
  '',
  'function saveConfig(cfg) {',
  '  PropertiesService.getScriptProperties().setProperties(cfg);',
  '}',
  '',
  'function resetConfig() {',
  '  PropertiesService.getScriptProperties().deleteAllProperties();',
  '}',
].join('\n');

test('isFullFileCandidate: versión editada del archivo → true', () => {
  const edited = FILE.replace('return props.getProperties();', 'return props.getProperties() || {};');
  assert.equal(C.isFullFileCandidate(FILE, edited, GasLineDiff), true);
});

test('isFullFileCandidate: snippet genérico no relacionado → false', () => {
  const snippet = [
    'function calculateAverage(values) {',
    '  const sum = values.reduce((a, b) => a + b, 0);',
    '  return sum / values.length;',
    '}',
    '',
    'function sendEmail(to, subject, body) {',
    '  MailApp.sendEmail(to, subject, body);',
    '}',
  ].join('\n');
  assert.equal(C.isFullFileCandidate(FILE, snippet, GasLineDiff), false);
});

test('isFullFileCandidate: fragmento corto del propio archivo → false (menos del 50 %)', () => {
  const part = FILE.split('\n').slice(2, 6).join('\n');
  assert.equal(C.isFullFileCandidate(FILE, part, GasLineDiff), false);
});

test('isFullFileCandidate: sin archivo o sin GasLineDiff → false', () => {
  assert.equal(C.isFullFileCandidate('', 'a()', GasLineDiff), false);
  assert.equal(C.isFullFileCandidate(FILE, FILE, null), false);
});

test('budgetTokens: 85 % de la ventana; vacío/0 = sin límite', () => {
  assert.equal(C.budgetTokens(4096), 3481);
  assert.equal(C.budgetTokens(''), 0);
  assert.equal(C.budgetTokens(0), 0);
});

test('truncateAround: conserva el principio con marcador', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = C.truncateAround(text, 60);
  assert.ok(out.startsWith('line 0\n'));
  assert.ok(out.endsWith(`\n${C.TRUNCATED_MARKER}`));
  assert.ok(out.length <= 60 + C.TRUNCATED_MARKER.length + 2);
});

test('truncateAround: centra la ventana en la selección', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const out = C.truncateAround(text, 80, 'line 150');
  assert.ok(out.includes('line 150'));
  assert.ok(out.startsWith(C.TRUNCATED_MARKER));
  assert.ok(out.endsWith(C.TRUNCATED_MARKER));
});

test('truncateAround: texto que cabe se devuelve intacto', () => {
  assert.equal(C.truncateAround('abc', 10), 'abc');
});

const agentCtx = () => ({
  head: ['ROLE', 'RULES'],
  listing: Array.from({ length: 30 }, (_, i) => `- Folder/File${i}.gs (120 lines)`).join('\n'),
  listingCompact: Array.from({ length: 30 }, (_, i) => `Folder/File${i}.gs`).join(', '),
  files: [
    { label: 'Config.gs', text: 'x'.repeat(3000), active: true },
    { label: 'Other.gs', text: 'y'.repeat(2000) },
  ],
  omitted: [],
});

test('shrinkAgentContext: si cabe no cambia nada', () => {
  const c = agentCtx();
  const res = C.shrinkAgentContext(c, 100000);
  assert.equal(res.trimmed, false);
  assert.equal(res.system, C.composeAgentSystem(c));
});

test('shrinkAgentContext: primero quita archivos no activos', () => {
  const c = agentCtx();
  const full = C.composeAgentSystem(c).length;
  const res = C.shrinkAgentContext(c, full - 1500);
  assert.deepEqual([...res.steps], ['files']);
  assert.ok(!res.system.includes('yyyy'));
  assert.ok(res.system.includes('Other.gs not included'));
  assert.ok(res.system.includes('x'.repeat(3000)));
  assert.equal(res.fits, true);
});

test('shrinkAgentContext: después compacta la lista y recorta el archivo activo', () => {
  const res = C.shrinkAgentContext(agentCtx(), 2000);
  assert.deepEqual([...res.steps], ['files', 'listing', 'active']);
  assert.ok(res.system.includes('[Active file: Config.gs]'));
  assert.ok(res.system.includes(C.TRUNCATED_MARKER));
  assert.ok(!res.system.includes('(120 lines)'));
  assert.equal(res.fits, true);
});

test('shrinkAgentContext: si no cabe ni recortando, fits=false', () => {
  const res = C.shrinkAgentContext(agentCtx(), 50);
  assert.equal(res.trimmed, true);
  assert.equal(res.fits, false);
});
