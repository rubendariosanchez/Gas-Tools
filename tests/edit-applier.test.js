// Tests de la resolución/aplicación de ediciones (extension/js/shared/edit-applier.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Carga scripts clásicos en un mismo contexto vm. */
function loadClassic(rels, globals) {
  const ctx = vm.createContext({ console });
  for (const rel of rels) vm.runInContext(fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'), ctx);
  vm.runInContext(`globalThis.__out = { ${globals.join(', ')} };`, ctx);
  return ctx.__out;
}

const { GasEditApplier: A, GasLineDiff } = loadClassic(
  ['extension/js/shared/line-diff.js', 'extension/js/shared/edit-applier.js'],
  ['GasEditApplier', 'GasLineDiff'],
);
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

// ── Modelo Monaco simulado ─────────────────────────────────────────────

/** Modelo mínimo: texto por líneas, EOL, versión alternativa y pila de deshacer. */
function fakeModel(text, { eol = '\n', failOn = null } = {}) {
  let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let version = 1;
  let nextVersion = 2;
  const undoStack = [];
  const offsetOf = (ln, col) => {
    let o = 0;
    for (let i = 0; i < ln - 1; i++) o += lines[i].length + 1;
    return o + col - 1;
  };
  const model = {
    edits: 0,
    getValue: () => lines.join(eol),
    getLinesContent: () => lines.slice(),
    getEOL: () => eol,
    getAlternativeVersionId: () => version,
    getPositionAt(offset) {
      // Offset sobre getValue() (con el EOL del modelo)
      let o = offset;
      for (let i = 0; i < lines.length; i++) {
        if (o <= lines[i].length) return { lineNumber: i + 1, column: o + 1 };
        o -= lines[i].length + eol.length;
      }
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 }),
    pushStackElement() {},
    pushEditOperations(_sel, edits) {
      if (failOn && failOn(model)) throw new Error('monaco rejected');
      undoStack.push({ lines: lines.slice(), version });
      let flat = lines.join('\n');
      const ops = edits.map((e) => ({
        start: offsetOf(e.range.startLineNumber, e.range.startColumn),
        end: offsetOf(e.range.endLineNumber, e.range.endColumn),
        text: String(e.text).replace(/\r\n?/g, '\n'),
        raw: e.text,
      })).sort((x, y) => y.start - x.start);
      for (const op of ops) flat = flat.slice(0, op.start) + op.text + flat.slice(op.end);
      model.lastEdits = edits;
      lines = flat.split('\n');
      version = nextVersion++;
      model.edits++;
    },
    undo() {
      const prev = undoStack.pop();
      if (!prev) return;
      lines = prev.lines;
      version = prev.version;
    },
    /** Edición del usuario fuera del agente. */
    userEdit(newText) {
      undoStack.push({ lines: lines.slice(), version });
      lines = newText.split('\n');
      version = nextVersion++;
    },
  };
  return model;
}

function depsFor(models, extra = {}) {
  return {
    findModel: (n) => models[n] || null,
    applyEdits: (m, edits) => m.pushEditOperations([], edits, () => null),
    undo: (m) => m.undo(),
    diff: GasLineDiff.diffLines,
    applied: new Map(),
    ...extra,
  };
}

// ── resolveHunks ───────────────────────────────────────────────────────

const SRC = [
  'function a() {',
  '  return 1;',
  '}',
  '',
  'function b() {',
  '  return 2;',
  '}',
].join('\n');

test('resolveHunks: en orden, offsets ordenados y sin solapes', () => {
  const r = A.resolveHunks(SRC, [
    { search: 'function a() {', replace: 'function a2() {' },
    { search: '  return 2;', replace: '  return 20;' },
  ]);
  eq(r.failed, []);
  assert.equal(r.proposed, SRC.replace('a()', 'a2()').replace('return 2;', 'return 20;'));
  assert.ok(r.edits.every((e, i) => i === 0 || r.edits[i - 1].end <= e.start));
  eq(r.edits.map((e) => e.tier), ['exact', 'exact']);
});

test('resolveHunks: el hunk que no está tras el cursor se busca en todo el texto', () => {
  const r = A.resolveHunks(SRC, [
    { search: '  return 2;', replace: '  return 20;' },
    { search: '  return 1;', replace: '  return 10;' },
  ]);
  eq(r.failed, []);
  assert.ok(r.proposed.includes('return 10;') && r.proposed.includes('return 20;'));
  eq(r.edits.map((e) => e.index), [1, 0], 'edits ordenadas por posición');
});

test('resolveHunks: varias coincidencias en la zona restante → ambiguous', () => {
  const r = A.resolveHunks(SRC, [{ search: '}', replace: '};' }]);
  eq(r.failed, [{ index: 0, search: '}', reason: 'ambiguous' }]);
  assert.equal(r.proposed, SRC);
  // Tras el primer hunk solo queda una aparición: deja de ser ambiguo
  const r2 = A.resolveHunks(SRC, [{ search: '  return 2;', replace: '  return 3;' }, { search: '}', replace: '};' }]);
  eq(r2.failed, []);
  assert.ok(r2.proposed.endsWith('  return 3;\n};'));
});

test('resolveHunks: hunks solapados no se aplican dos veces', () => {
  const r = A.resolveHunks('abc\ndef\nghi', [
    { search: 'abc\ndef', replace: 'X' },
    { search: 'def\nghi', replace: 'Y' },
  ]);
  assert.equal(r.edits.length, 1);
  eq(r.failed, [{ index: 1, search: 'def\nghi', reason: 'not-found' }]);
  assert.equal(r.proposed, 'X\nghi');
});

const FUZZY_SRC = [
  'function total(items) {',
  '  const sum = items.reduce((acc, x) => acc + x.price, 0);',
  '  return Math.round(sum * 100) / 100;',
  '}',
].join('\n');

test('resolveHunks: fuzzy único con similitud alta (y reindentado)', () => {
  const r = A.resolveHunks(FUZZY_SRC, [{
    search: 'const sum = items.reduce((acc,x) => acc + x.price, 0)\nreturn Math.round(sum * 100) / 100;',
    replace: 'const sum = items.reduce((acc, x) => acc + x.price * x.qty, 0);\nreturn Math.round(sum * 100) / 100;',
  }]);
  eq(r.failed, []);
  assert.equal(r.edits[0].tier, 'fuzzy');
  assert.ok(r.proposed.includes('  const sum = items.reduce((acc, x) => acc + x.price * x.qty, 0);'));
});

test('resolveHunks: fuzzy no único → ambiguous; muy distinto → not-found', () => {
  const twice = `${FUZZY_SRC}\n\n${FUZZY_SRC.replace('total', 'total2')}`;
  const search = 'const sum = items.reduce((acc,x) => acc + x.price, 0)\nreturn Math.round(sum * 100) / 100;';
  eq(A.resolveHunks(twice, [{ search, replace: 'x' }]).failed.map((f) => f.reason), ['ambiguous']);
  eq(A.resolveHunks(FUZZY_SRC, [{ search: 'const other = compute(items, 42);\nreturn other;', replace: 'x' }]).failed.map((f) => f.reason), ['not-found']);
});

test('resolveHunks: CRLF se conserva en proposed; offsets sobre el texto con \\n', () => {
  const crlf = SRC.replace(/\n/g, '\r\n');
  const r = A.resolveHunks(crlf, [{ search: '  return 2;', replace: '  return 22;' }]);
  assert.equal(r.proposed, crlf.replace('return 2;', 'return 22;'));
  const lf = SRC;
  assert.equal(lf.slice(r.edits[0].start, r.edits[0].end), '  return 2;');
});

// ── toMonacoEdits ──────────────────────────────────────────────────────

test('toMonacoEdits: posiciones correctas y texto con el EOL del modelo (CRLF)', () => {
  for (const eol of ['\n', '\r\n']) {
    const model = fakeModel(SRC, { eol });
    const r = A.resolveHunks(model.getLinesContent().join('\n'), [
      { search: 'function b() {\n  return 2;', replace: 'function b() {\n  const v = 2;\n  return v;' },
    ]);
    const edits = A.toMonacoEdits(model, r.edits);
    assert.equal(edits[0].forceMoveMarkers, false);
    eq(edits[0].range, { startLineNumber: 5, startColumn: 1, endLineNumber: 6, endColumn: 12 });
    assert.equal(edits[0].text.includes('\r\n'), eol === '\r\n');
    model.pushEditOperations([], edits);
    assert.equal(model.getValue(), r.proposed.split('\n').join(eol));
  }
});

// ── fromFullText: paridad con el antiguo _buildLineEdits_ ──────────────

/** Copia literal del antiguo `GasCustomEditor._buildLineEdits_` (referencia). */
function legacyBuildLineEdits(model, next, diff) {
  const lines = model.getLinesContent();
  let ops;
  try { ops = diff(lines.join('\n'), next); } catch (_) { return null; }
  if (!Array.isArray(ops)) return null;
  const aSide = ops.filter((o) => o.type !== 'add').map((o) => o.text);
  const bSide = ops.filter((o) => o.type !== 'del').map((o) => o.text);
  if (aSide.length !== lines.length || aSide.some((t, i) => t !== lines[i])) return null;
  if (bSide.join('\n') !== next || (next === '' && bSide.length)) return null;
  const lineCount = lines.length;
  const maxCol = (n) => lines[n - 1].length + 1;
  const edits = [];
  let aLine = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') { aLine++; i++; continue; }
    const start = aLine + 1;
    const added = [];
    let deleted = 0;
    while (i < ops.length && ops[i].type !== 'equal') {
      if (ops[i].type === 'del') deleted++;
      else added.push(ops[i].text);
      i++;
    }
    const end = start + deleted - 1;
    if (deleted) aLine = end;
    let range;
    let text;
    if (deleted && end < lineCount) {
      range = { startLineNumber: start, startColumn: 1, endLineNumber: end + 1, endColumn: 1 };
      text = added.map((t) => `${t}\n`).join('');
    } else if (deleted && start > 1) {
      range = { startLineNumber: start - 1, startColumn: maxCol(start - 1), endLineNumber: end, endColumn: maxCol(end) };
      text = added.map((t) => `\n${t}`).join('');
    } else if (deleted) {
      return null;
    } else if (start <= lineCount) {
      range = { startLineNumber: start, startColumn: 1, endLineNumber: start, endColumn: 1 };
      text = added.map((t) => `${t}\n`).join('');
    } else {
      range = { startLineNumber: lineCount, startColumn: maxCol(lineCount), endLineNumber: lineCount, endColumn: maxCol(lineCount) };
      text = added.map((t) => `\n${t}`).join('');
    }
    edits.push({ range, text, forceMoveMarkers: true });
  }
  return edits.length ? edits : null;
}

/** PRNG determinista (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Muta un texto: borra, inserta y cambia líneas al azar. */
function mutate(lines, rand) {
  const out = [];
  for (const l of lines) {
    const r = rand();
    if (r < 0.1) continue;
    if (r < 0.2) out.push(`new ${Math.floor(rand() * 5)}`);
    out.push(r < 0.3 ? `${l}!` : l);
  }
  if (rand() < 0.3) out.push('tail');
  return out;
}

test('fromFullText: paridad con _buildLineEdits_ y reconstruye el propuesto', () => {
  const rand = rng(42);
  const cases = [['', 'a'], ['a', ''], ['a\nb', 'a'], ['a\nb', 'b'], ['a', 'a\nb'], ['x\ny\nz', 'y']];
  for (let k = 0; k < 120; k++) {
    const a = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => `l${Math.floor(rand() * 6)}`);
    cases.push([a.join('\n'), mutate(a, rand).join('\n')]);
  }
  for (const [orig, next] of cases) {
    const model = fakeModel(orig);
    const legacy = legacyBuildLineEdits(model, next, GasLineDiff.diffLines);
    const mine = A.fromFullText(orig, next, GasLineDiff.diffLines);
    eq(mine, legacy && legacy.map(({ range, text }) => ({ range, text })), `${JSON.stringify(orig)} → ${JSON.stringify(next)}`);
    if (mine) {
      model.pushEditOperations([], A.toMonacoEdits(model, mine));
      assert.equal(model.getValue(), next);
    }
  }
});

// ── applyChangeSet (modelo simulado) ───────────────────────────────────

test('applyChangeSet: rebase de hunks sobre un archivo editado tras la propuesta', async () => {
  const model = fakeModel(SRC);
  const batches = [[{ search: '  return 2;', replace: '  return 20;' }]];
  const proposed = A.resolveHunks(SRC, batches[0]).proposed;
  const base = model.getAlternativeVersionId();
  model.userEdit(`// header\n${SRC}`);   // el usuario edita otra zona
  const res = await A.applyChangeSet([{ name: 'Code', mode: 'hunks', batches, proposed, baseVersionId: base }], depsFor({ Code: model }));
  assert.equal(res.ok, true);
  eq(res.results, [{ name: 'Code', status: 'applied' }]);
  assert.equal(model.getValue(), `// header\n${proposed}`, 'conserva el trabajo del usuario');
});

test('applyChangeSet: hunk que ya no coincide → conflicto sin tocar nada', async () => {
  const a = fakeModel(SRC);
  const b = fakeModel('const x = 1;');
  const batches = [[{ search: '  return 2;', replace: '  return 20;' }]];
  a.userEdit(SRC.replace('return 2;', 'return 3;'));
  const res = await A.applyChangeSet([
    { name: 'B', mode: 'full', proposed: 'const x = 2;' },
    { name: 'A', mode: 'hunks', batches, proposed: 'irrelevante' },
  ], depsFor({ A: a, B: b }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'conflict');
  eq(res.results[1], { name: 'A', status: 'conflict', reason: 'hunks', failed: [{ index: 0, search: '  return 2;', reason: 'not-found', batch: 0 }] });
  assert.equal(b.edits, 0, 'todo o nada: B no se aplica');
});

test('applyChangeSet: archivo completo con versionId distinto → conflicto; igual → aplica', async () => {
  const model = fakeModel('a\nb');
  const base = model.getAlternativeVersionId();
  model.userEdit('a\nb\nc');
  const blocked = await A.applyChangeSet([{ name: 'F', mode: 'full', proposed: 'a\nB', baseVersionId: base }], depsFor({ F: model }));
  eq(blocked.results, [{ name: 'F', status: 'conflict', reason: 'changed' }]);
  assert.equal(model.getValue(), 'a\nb\nc', 'nunca sobrescribe en silencio');
  const ok = await A.applyChangeSet([{ name: 'F', mode: 'full', proposed: 'a\nB\nc', baseVersionId: model.getAlternativeVersionId() }], depsFor({ F: model }));
  assert.equal(ok.ok, true);
  assert.equal(model.getValue(), 'a\nB\nc');
});

test('applyChangeSet: un fallo al aplicar deshace lo ya aplicado (rollback)', async () => {
  const a = fakeModel('one\ntwo');
  const b = fakeModel('three', { failOn: () => true });
  const res = await A.applyChangeSet([
    { name: 'A', mode: 'full', proposed: 'one\nTWO' },
    { name: 'B', mode: 'full', proposed: 'THREE' },
  ], depsFor({ A: a, B: b }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'apply-failed');
  assert.equal(a.getValue(), 'one\ntwo', 'A vuelve a su estado');
  assert.equal(b.getValue(), 'three');
  eq(res.results.map((r) => r.status), ['rolled-back', 'rolled-back']);
});

test('applyChangeSet: idempotente (reintento tras timeout no duplica)', async () => {
  const model = fakeModel('function f() {\n  a();\n}');
  // El REPLACE contiene el SEARCH: un reintento ingenuo lo aplicaría dos veces
  const batches = [[{ search: '  a();', replace: '  a();\n  b();' }]];
  const proposed = A.resolveHunks(model.getValue(), batches[0]).proposed;
  const deps = depsFor({ F: model });
  const spec = { name: 'F', mode: 'hunks', batches, proposed, key: 'k1' };
  assert.equal((await A.applyChangeSet([spec], deps)).ok, true);
  const again = await A.applyChangeSet([spec], deps);
  eq(again, { ok: true, results: [{ name: 'F', status: 'unchanged' }] });
  assert.equal(model.edits, 1);
  assert.equal(model.getValue(), proposed);
  // Sin clave también: el texto vivo ya es el propuesto
  eq((await A.applyChangeSet([{ ...spec, key: '' }], depsFor({ F: model }))).results[0].status, 'unchanged');
});

test('applyChangeSet: archivo inexistente → not-found y nada aplicado', async () => {
  const a = fakeModel('x');
  const res = await A.applyChangeSet([{ name: 'A', proposed: 'y' }, { name: 'Nope', proposed: 'z' }], depsFor({ A: a }));
  assert.equal(res.error, 'not-found');
  assert.equal(a.edits, 0);
});

test('rebase: conflicto por versión solo si el texto difiere del propuesto', () => {
  eq(A.rebase('a', { mode: 'full', proposed: 'b', baseVersionId: 1 }, 2), { conflict: { reason: 'changed', failed: [] } });
  eq(A.rebase('b', { mode: 'full', proposed: 'b', baseVersionId: 1 }, 2), { proposed: 'b', edits: null, fuzzy: 0 });
});
