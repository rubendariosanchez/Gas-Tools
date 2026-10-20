// Tests del pegamento de `GasCustomEditor._applyChangeSet_` (gas-tools.js) con un editor Monaco simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
const ctx = vm.createContext({ console, window, document: { addEventListener() {}, removeEventListener() {} } });
for (const rel of ['extension/js/shared/line-diff.js', 'extension/js/shared/edit-applier.js', 'extension/js/gas-tools.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'), ctx);
}
vm.runInContext('globalThis.__E = GasCustomEditor;', ctx);
const GasCustomEditor = ctx.__E;

/** Modelo con pila de deshacer y versión alternativa. */
function fakeModel(name, text) {
  let lines = text.split('\n');
  let version = 1;
  let next = 2;
  const stack = [];
  return {
    name,
    uri: { scheme: 'inmemory', toString: () => `inmemory://${name}` },
    isDisposed: () => false,
    getValue: () => lines.join('\n'),
    getLinesContent: () => lines.slice(),
    getEOL: () => '\n',
    getAlternativeVersionId: () => version,
    getPositionAt(o) {
      for (let i = 0; i < lines.length; i++) {
        if (o <= lines[i].length) return { lineNumber: i + 1, column: o + 1 };
        o -= lines[i].length + 1;
      }
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 }),
    _apply(edits) {
      stack.push({ lines: lines.slice(), version });
      const off = (l, c) => lines.slice(0, l - 1).reduce((n, x) => n + x.length + 1, 0) + c - 1;
      let flat = lines.join('\n');
      edits.map((e) => ({ s: off(e.range.startLineNumber, e.range.startColumn), e: off(e.range.endLineNumber, e.range.endColumn), t: e.text }))
        .sort((a, b) => b.s - a.s)
        .forEach((op) => { flat = flat.slice(0, op.s) + op.t + flat.slice(op.e); });
      lines = flat.split('\n');
      version = next++;
    },
    pushStackElement() {},
    pushEditOperations(_s, edits) { this._apply(edits); },
    undo() { const p = stack.pop(); if (p) { lines = p.lines; version = p.version; } },
  };
}

/** Editor simulado: setModel, executeEdits, view state. */
function fakeEditor(model) {
  const log = [];
  return {
    log,
    current: model,
    getModel() { return this.current; },
    setModel(m) { log.push(`setModel:${m.name}`); this.current = m; },
    saveViewState: () => ({ scroll: 42 }),
    restoreViewState(v) { log.push(`restore:${v.scroll}`); },
    pushUndoStop() {},
    executeEdits(_src, edits) {
      if (edits.some((e) => e.forceMoveMarkers !== false)) throw new Error('forceMoveMarkers debe ser false');
      this.current._apply(edits);
    },
  };
}

function setup() {
  const a = fakeModel('A.gs', 'function a() {\n  return 1;\n}');
  const b = fakeModel('B.gs', 'const b = 1;');
  const inst = Object.create(GasCustomEditor.prototype);
  inst.editor = fakeEditor(a);
  inst._findModelByName_ = (n) => ({ 'A.gs': a, 'B.gs': b }[n] || null);
  return { inst, a, b };
}

test('_applyChangeSet_: aplica en archivos no activos y vuelve al original con su view state', async () => {
  const { inst, a, b } = setup();
  const res = await inst._applyChangeSet_([
    { name: 'A.gs', mode: 'hunks', batches: [[{ search: '  return 1;', replace: '  return 2;' }]], proposed: 'function a() {\n  return 2;\n}' },
    { name: 'B.gs', mode: 'full', proposed: 'const b = 2;', baseVersionId: 1 },
  ]);
  assert.equal(res.ok, true);
  assert.equal(a.getValue(), 'function a() {\n  return 2;\n}');
  assert.equal(b.getValue(), 'const b = 2;');
  assert.deepEqual(inst.editor.log, ['setModel:B.gs', 'setModel:A.gs', 'restore:42']);
  assert.equal(inst.editor.getModel(), a);
});

test('_applyChangeSet_: conflicto en archivo completo no toca nada; reintento idempotente', async () => {
  const { inst, a, b } = setup();
  const blocked = await inst._applyChangeSet_([
    { name: 'A.gs', mode: 'full', proposed: 'x', baseVersionId: 1 },
    { name: 'B.gs', mode: 'full', proposed: 'y', baseVersionId: 99 },
  ]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'conflict');
  assert.equal(a.getValue(), 'function a() {\n  return 1;\n}');

  const spec = { name: 'B.gs', mode: 'hunks', batches: [[{ search: 'const b = 1;', replace: 'const b = 1;\nconst c = 1;' }]], proposed: 'const b = 1;\nconst c = 1;', key: 'k' };
  assert.equal((await inst._applyChangeSet_([spec])).ok, true);
  const again = await inst._applyChangeSet_([spec]);
  assert.equal(again.results[0].status, 'unchanged');
  assert.equal(b.getValue(), 'const b = 1;\nconst c = 1;');
});

test('_applyChangeSet_: si falla el segundo archivo se deshace el primero', async () => {
  const { inst, a, b } = setup();
  const exec = inst.editor.executeEdits.bind(inst.editor);
  inst.editor.executeEdits = (src, edits) => {
    if (inst.editor.current === b) throw new Error('boom');
    exec(src, edits);
  };
  const res = await inst._applyChangeSet_([
    { name: 'A.gs', mode: 'full', proposed: 'changed' },
    { name: 'B.gs', mode: 'full', proposed: 'also' },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'apply-failed');
  assert.equal(a.getValue(), 'function a() {\n  return 1;\n}');
  assert.equal(inst.editor.getModel(), a);
});

test('_applyFileEdits_: adaptador legado conserva { ok, unchanged } y not-found', async () => {
  const { inst } = setup();
  assert.deepEqual({ ...(await inst._applyFileEdits_('B.gs', 'const b = 5;')) }, { ok: true });
  assert.deepEqual({ ...(await inst._applyFileEdits_('B.gs', 'const b = 5;')) }, { ok: true, unchanged: true });
  assert.deepEqual({ ...(await inst._applyFileEdits_('Nope.gs', 'x')) }, { ok: false, error: 'not-found' });
});
