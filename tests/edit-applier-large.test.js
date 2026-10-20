// Casos combinados de la fase 4 (QA fase 5): archivo grande + CRLF + rebase,
// modo archivo completo con ediciones mínimas y fallo de "Accept all" con rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console });
for (const rel of ['extension/js/shared/line-diff.js', 'extension/js/shared/edit-applier.js']) {
  vm.runInContext(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'), ctx);
}
vm.runInContext('globalThis.__out = { GasEditApplier, GasLineDiff };', ctx);
const { GasEditApplier: A, GasLineDiff } = ctx.__out;
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

/** Modelo Monaco simulado con EOL configurable, versión y deshacer. */
function fakeModel(text, { eol = '\n', failOn = null } = {}) {
  let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let version = 1; let next = 2; const stack = [];
  const off = (l, c) => lines.slice(0, l - 1).reduce((n, x) => n + x.length + 1, 0) + c - 1;
  const m = {
    edits: 0, lastEdits: [],
    getValue: () => lines.join(eol),
    getLinesContent: () => lines.slice(),
    getEOL: () => eol,
    getAlternativeVersionId: () => version,
    getPositionAt(o) {
      for (let i = 0; i < lines.length; i++) {
        if (o <= lines[i].length) return { lineNumber: i + 1, column: o + 1 };
        o -= lines[i].length + eol.length;
      }
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 }),
    pushStackElement() {},
    pushEditOperations(_s, edits) {
      if (failOn && failOn(m)) throw new Error('monaco rejected');
      stack.push({ lines: lines.slice(), version });
      let flat = lines.join('\n');
      edits.map((e) => ({ s: off(e.range.startLineNumber, e.range.startColumn), e: off(e.range.endLineNumber, e.range.endColumn), t: String(e.text).replace(/\r\n?/g, '\n') }))
        .sort((a, b) => b.s - a.s).forEach((op) => { flat = flat.slice(0, op.s) + op.t + flat.slice(op.e); });
      m.lastEdits = edits; lines = flat.split('\n'); version = next++; m.edits++;
    },
    undo() { const p = stack.pop(); if (p) { lines = p.lines; version = p.version; } },
    userEdit(t) { stack.push({ lines: lines.slice(), version }); lines = t.replace(/\r\n?/g, '\n').split('\n'); version = next++; },
  };
  return m;
}
const deps = (models) => ({
  findModel: (n) => models[n] || null,
  applyEdits: (m, edits) => m.pushEditOperations([], edits, () => null),
  undo: (m) => m.undo(),
  diff: GasLineDiff.diffLines,
  applied: new Map(),
});

/** Archivo de N funciones (3 líneas cada una + blanco). */
const bigSource = (n, eol = '\n') => Array.from({ length: n }, (_, i) => `function f${i}() {${eol}  return ${i};${eol}}${eol}`).join(eol);

test('3500+ líneas CRLF: rebase de un hunk final tras editar el principio, ediciones mínimas', async () => {
  const src = bigSource(900, '\r\n');            // ~3600 líneas
  const model = fakeModel(src, { eol: '\r\n' });
  assert.ok(model.getLinesContent().length > 3500);
  const batches = [[{ search: 'function f899() {\n  return 899;\n}', replace: 'function f899() {\n  return 8990;\n}' }]];
  const res0 = A.resolveHunks(model.getValue(), batches[0]);
  assert.ok(!res0.failed?.length, 'el hunk LF encuentra el texto CRLF');
  const base = model.getAlternativeVersionId();
  model.userEdit(`// cabecera del usuario\r\n${model.getValue()}`);
  const t0 = Date.now();
  const res = await A.applyChangeSet([{ name: 'Big', mode: 'hunks', batches, proposed: res0.proposed, baseVersionId: base }], deps({ Big: model }));
  const ms = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  const value = model.getValue();
  assert.ok(value.startsWith('// cabecera del usuario\r\n'), 'conserva la edición del usuario');
  assert.ok(value.includes('return 8990;'));
  assert.ok(!/[^\r]\n/.test(value), 'sin LF sueltos: el EOL del modelo se conserva');
  assert.equal(model.edits, 1);
  assert.ok(model.lastEdits.length <= 2, `ediciones mínimas, no reemplazo completo (${model.lastEdits.length})`);
  assert.ok(ms < 1500, `rápido (${ms} ms)`);
});

test('3000+ líneas en modo archivo completo: un cambio genera una edición acotada', async () => {
  const src = bigSource(800);
  const model = fakeModel(src);
  const proposed = src.replace('return 400;', 'return 4000;');
  const res = await A.applyChangeSet([{ name: 'Big', mode: 'full', proposed, baseVersionId: model.getAlternativeVersionId() }], deps({ Big: model }));
  assert.equal(res.ok, true);
  assert.equal(model.getValue(), proposed);
  assert.equal(model.lastEdits.length, 1);
  const r = model.lastEdits[0].range;
  assert.ok(r.endLineNumber - r.startLineNumber <= 1, 'la edición toca solo la línea cambiada');
});

test('Accept all: conflicto en el tercer archivo no toca los dos primeros; tras resolverlo aplica todo', async () => {
  const a = fakeModel('a1\na2'); const b = fakeModel('b1\nb2'); const c = fakeModel('c1\nc2');
  const specs = [
    { name: 'A', mode: 'full', proposed: 'a1\nA2' },
    { name: 'B', mode: 'hunks', batches: [[{ search: 'b2', replace: 'B2' }]], proposed: 'b1\nB2' },
    { name: 'C', mode: 'hunks', batches: [[{ search: 'c2', replace: 'C2' }]], proposed: 'c1\nC2' },
  ];
  c.userEdit('c1\nzz');
  const blocked = await A.applyChangeSet(specs, deps({ A: a, B: b, C: c }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'conflict');
  assert.equal(a.edits + b.edits + c.edits, 0, 'todo o nada');
  assert.equal(blocked.results[2].status, 'conflict');
  c.userEdit('c1\nc2');
  const ok = await A.applyChangeSet(specs, deps({ A: a, B: b, C: c }));
  assert.equal(ok.ok, true);
  assert.deepEqual([a.getValue(), b.getValue(), c.getValue()], ['a1\nA2', 'b1\nB2', 'c1\nC2']);
});

test('ambiguo: el mismo SEARCH en dos sitios no se aplica a ciegas', async () => {
  const src = 'function x() {\n  log();\n}\nfunction y() {\n  log();\n}';
  const model = fakeModel(src);
  const res = await A.applyChangeSet([{ name: 'F', mode: 'hunks', batches: [[{ search: '  log();', replace: '  warn();' }]], proposed: '?' }], deps({ F: model }));
  assert.equal(res.ok, false);
  assert.equal(model.getValue(), src);
  assert.match(JSON.stringify(res.results[0]), /ambiguous/);
});
