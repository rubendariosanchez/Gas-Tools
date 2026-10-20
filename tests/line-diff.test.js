// Tests del diff por líneas compartido (extension/js/shared/line-diff.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Carga un script clásico en un contexto vm y devuelve el global indicado. */
function loadClassic(rel, globalName) {
  const src = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const ctx = { console };
  vm.runInNewContext(`${src}\n;globalThis.${globalName} = ${globalName};`, ctx);
  return ctx[globalName];
}

const GasLineDiff = loadClassic('extension/js/shared/line-diff.js', 'GasLineDiff');
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

/** Reconstruye a y b a partir de las ops para validar coherencia. */
function rebuild(ops) {
  const a = ops.filter((o) => o.type !== 'add').map((o) => o.text);
  const b = ops.filter((o) => o.type !== 'del').map((o) => o.text);
  return { a, b };
}

test('diffLines: textos idénticos solo producen equal', () => {
  const ops = GasLineDiff.diffLines('a\nb\nc', 'a\nb\nc');
  eq(ops, [
    { type: 'equal', text: 'a', aLine: 1, bLine: 1 },
    { type: 'equal', text: 'b', aLine: 2, bLine: 2 },
    { type: 'equal', text: 'c', aLine: 3, bLine: 3 },
  ]);
});

test('diffLines: modificación en medio con números de línea correctos', () => {
  const ops = GasLineDiff.diffLines('a\nb\nc', 'a\nB\nc');
  eq(ops, [
    { type: 'equal', text: 'a', aLine: 1, bLine: 1 },
    { type: 'del', text: 'b', aLine: 2 },
    { type: 'add', text: 'B', bLine: 2 },
    { type: 'equal', text: 'c', aLine: 3, bLine: 3 },
  ]);
});

test('diffLines: inserciones y borrados con LCS en el tramo central', () => {
  const a = 'x\n1\n2\n3\n4\ny';
  const b = 'x\n1\nnew\n3\n4\n5\ny';
  const ops = GasLineDiff.diffLines(a, b);
  const r = rebuild(ops);
  eq(r.a, a.split('\n'));
  eq(r.b, b.split('\n'));
  eq(GasLineDiff.stats(ops), { added: 2, removed: 1 });
  const add5 = ops.find((o) => o.text === '5');
  eq(add5, { type: 'add', text: '5', bLine: 6 });
});

test('diffLines: CRLF y LF se consideran iguales', () => {
  const ops = GasLineDiff.diffLines('a\r\nb\r\nc', 'a\nb\nc');
  assert.ok(ops.every((o) => o.type === 'equal'));
  assert.equal(ops.length, 3);
});

test('diffLines: textos vacíos', () => {
  eq(GasLineDiff.diffLines('', ''), []);
  eq(GasLineDiff.diffLines('', 'a\nb'), [
    { type: 'add', text: 'a', bLine: 1 },
    { type: 'add', text: 'b', bLine: 2 },
  ]);
  eq(GasLineDiff.diffLines('a', ''), [{ type: 'del', text: 'a', aLine: 1 }]);
});

test('diffLines: prefijo/sufijo común en archivo grande es rápido y correcto', () => {
  const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
  const changed = base.slice();
  changed[1500] = 'CHANGED';
  const t0 = Date.now();
  const ops = GasLineDiff.diffLines(base.join('\n'), changed.join('\n'));
  assert.ok(Date.now() - t0 < 1000);
  eq(GasLineDiff.stats(ops), { added: 1, removed: 1 });
  const del = ops.find((o) => o.type === 'del');
  eq(del, { type: 'del', text: 'line 1500', aLine: 1501 });
  const last = ops[ops.length - 1];
  eq(last, { type: 'equal', text: 'line 2999', aLine: 3000, bLine: 3000 });
});

test('diffLines: sufijo sin solaparse con el prefijo (líneas repetidas)', () => {
  const ops = GasLineDiff.diffLines('a\na', 'a\na\na');
  eq(GasLineDiff.stats(ops), { added: 1, removed: 0 });
  const r = rebuild(ops);
  eq(r.b, ['a', 'a', 'a']);
});

test('diffLines: fallback de bloque reemplazado si el tramo central es enorme', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n');
  const ops = GasLineDiff.diffLines(a, b);
  eq(GasLineDiff.stats(ops), { added: 2000, removed: 2000 });
  assert.equal(ops[0].type, 'del');
  assert.equal(ops[2000].type, 'add');
});

test('diffLines: 3000 líneas con muchos cambios dispersos termina en tiempo razonable', () => {
  const a = Array.from({ length: 1500 }, (_, i) => `l${i}`);
  const b = a.map((l, i) => (i % 10 === 0 ? `${l}!` : l));
  const t0 = Date.now();
  const ops = GasLineDiff.diffLines(a.join('\n'), b.join('\n'));
  assert.ok(Date.now() - t0 < 3000);
  eq(GasLineDiff.stats(ops), { added: 150, removed: 150 });
  const r = rebuild(ops);
  eq(r.a, a);
  eq(r.b, b);
});

test('stats: cuenta altas y bajas', () => {
  eq(GasLineDiff.stats([{ type: 'add' }, { type: 'add' }, { type: 'del' }, { type: 'equal' }]), { added: 2, removed: 1 });
  eq(GasLineDiff.stats([]), { added: 0, removed: 0 });
});

test('hunks: sin cambios no hay hunks', () => {
  eq(GasLineDiff.hunks(GasLineDiff.diffLines('a\nb', 'a\nb')), []);
});

test('hunks: contexto alrededor de un cambio y líneas de inicio', () => {
  const a = Array.from({ length: 20 }, (_, i) => `${i + 1}`);
  const b = a.slice();
  b[9] = 'X'; // línea 10
  const hs = GasLineDiff.hunks(GasLineDiff.diffLines(a.join('\n'), b.join('\n')), 3);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].aStart, 7);
  assert.equal(hs[0].bStart, 7);
  eq(hs[0].ops.map((o) => o.text), ['7', '8', '9', '10', 'X', '11', '12', '13']);
});

test('hunks: cambios lejanos se separan y cercanos se fusionan', () => {
  const a = Array.from({ length: 40 }, (_, i) => `${i + 1}`);
  const far = a.slice();
  far[2] = 'A'; far[30] = 'B';
  const hsFar = GasLineDiff.hunks(GasLineDiff.diffLines(a.join('\n'), far.join('\n')), 3);
  assert.equal(hsFar.length, 2);
  assert.equal(hsFar[0].aStart, 1);
  assert.equal(hsFar[1].aStart, 28);

  const near = a.slice();
  near[10] = 'A'; near[15] = 'B'; // 4 líneas iguales entre medias (<= 6)
  const hsNear = GasLineDiff.hunks(GasLineDiff.diffLines(a.join('\n'), near.join('\n')), 3);
  assert.equal(hsNear.length, 1);
  eq(GasLineDiff.stats(hsNear[0].ops), { added: 2, removed: 2 });
});

test('hunks: bStart correcto tras inserciones previas', () => {
  const a = Array.from({ length: 30 }, (_, i) => `${i + 1}`);
  const b = ['n1', 'n2', ...a];
  b[25 + 2] = 'Z'; // reemplaza la línea 26 de a
  const hs = GasLineDiff.hunks(GasLineDiff.diffLines(a.join('\n'), b.join('\n')), 2);
  assert.equal(hs.length, 2);
  eq([hs[0].aStart, hs[0].bStart], [1, 1]);
  eq([hs[1].aStart, hs[1].bStart], [24, 26]);
});

test('hunks: contexto 0 devuelve solo cambios', () => {
  const hs = GasLineDiff.hunks(GasLineDiff.diffLines('a\nb\nc\nd', 'a\nB\nc\nD'), 0);
  assert.equal(hs.length, 2);
  assert.ok(hs.every((h) => h.ops.every((o) => o.type !== 'equal')));
});

// ── Myers (fase 4) ─────────────────────────────────────────────────────

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

test('diffLines: las ops reconstruyen A y B (entradas aleatorias, semilla fija)', () => {
  const rand = rng(7);
  for (let k = 0; k < 300; k++) {
    const alphabet = 2 + Math.floor(rand() * 6);
    const gen = (n) => Array.from({ length: n }, () => `t${Math.floor(rand() * alphabet)}`);
    const a = gen(Math.floor(rand() * 40));
    const b = rand() < 0.5 ? gen(Math.floor(rand() * 40)) : a.map((l) => (rand() < 0.2 ? `${l}x` : l)).filter(() => rand() > 0.1);
    const ops = GasLineDiff.diffLines(a.join('\n'), b.join('\n'));
    const r = rebuild(ops);
    eq(r.a, a.length === 1 && a[0] === '' ? [] : a, `caso ${k} (a)`);
    eq(r.b, b.length === 1 && b[0] === '' ? [] : b, `caso ${k} (b)`);
    // Números de línea consecutivos en cada lado y borrados antes que altas en cada bloque
    let ea = 1;
    let eb = 1;
    ops.forEach((o, i) => {
      if (o.type !== 'add') assert.equal(o.aLine, ea++);
      if (o.type !== 'del') assert.equal(o.bLine, eb++);
      if (o.type === 'del' && i > 0) assert.notEqual(ops[i - 1].type, 'add', 'del tras add en el mismo bloque');
    });
  }
});

test('diffLines: Myers encuentra el diff mínimo en casos pequeños', () => {
  eq(GasLineDiff.stats(GasLineDiff.diffLines('a\nb\nc\na\nb\nb\na', 'c\nb\na\nb\na\nc')), { added: 2, removed: 3 });
});

test('diffLines: 10k líneas con dos ediciones lejanas → ops pequeñas, sin fallback y rápido', () => {
  const base = Array.from({ length: 10000 }, (_, i) => `line ${i % 97} ${i}`);
  const changed = base.slice();
  changed[120] = 'EDIT A';
  changed.splice(9500, 0, 'INSERTED');
  const t0 = performance.now();
  const ops = GasLineDiff.diffLines(base.join('\n'), changed.join('\n'));
  const ms = performance.now() - t0;
  assert.ok(ms < 200, `tardó ${ms.toFixed(1)} ms`);
  eq(GasLineDiff.stats(ops), { added: 2, removed: 1 });
  eq(GasLineDiff.hunks(ops, 0).map((h) => h.ops.length), [2, 1]);
});

test('diffLines: por encima del tope de distancia cae a bloque reemplazado', () => {
  const n = GasLineDiff.MAX_EDIT_DISTANCE;
  const a = Array.from({ length: n }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: n }, (_, i) => `b${i}`).join('\n');
  const t0 = performance.now();
  const ops = GasLineDiff.diffLines(a, b);
  assert.ok(performance.now() - t0 < 3000);
  eq(GasLineDiff.stats(ops), { added: n, removed: n });
  assert.equal(ops[0].type, 'del');
  assert.equal(ops[n].type, 'add');
  assert.equal(ops.overBudget, true, 'marca no enumerable del respaldo');
  assert.ok(!Object.keys(ops).includes('overBudget'));
  assert.equal(GasLineDiff.diffLines('a\nb', 'a\nc').overBudget, undefined);
});
