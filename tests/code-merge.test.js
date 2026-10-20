// Tests de extension/js/shared/code-merge.js ("Apply" de bloques de código
// normales sobre el archivo actual).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../extension/js/shared/code-merge.js', import.meta.url), 'utf8');
const ctx = { console };
vm.runInNewContext(`${src}\n;globalThis.GasCodeMerge = GasCodeMerge;`, ctx);
const { GasCodeMerge } = ctx;
const names = (text) => JSON.parse(JSON.stringify(GasCodeMerge.findUnits(text).map((u) => [u.name, u.kind])));

// Archivo real del usuario (dos funciones con JSDoc).
const FILE = `/**
 * Inserta texto en la posición del cursor (o al final si no hay cursor).
 *
 * @private
 * @param {string} text_ - Texto a insertar.
 * @returns {{success: boolean, usedCursor: boolean}}
 */
function insertTextAtCursor_(text_) {
  const document_ = DocumentApp.getActiveDocument();
  const cursor_ = document_.getCursor();

  // Sin cursor activo, anexamos al final del cuerpo y avisamos al cliente
  if (!cursor_) {
    document_.getBody().appendParagraph(text_);
    return { success: true, usedCursor: false };
  }

  const inserted_ = cursor_.insertText(text_);
  if (!inserted_) throw new Error('No fue posible insertar en la posición del cursor.');
  return { success: true, usedCursor: true };
}

/**
 * Inserta una tabla nueva debajo del cursor (o al final si no hay cursor).
 */
function insertSummaryTable_(cells_) {
  if (!Array.isArray(cells_) || !cells_.length) throw new Error('No hay datos para insertar la tabla.');
  return { success: true };
}
`;

test('findUnits detecta funciones con su JSDoc y no confunde llaves en strings', () => {
  assert.deepEqual(names(FILE), [['insertTextAtCursor_', 'function'], ['insertSummaryTable_', 'function']]);
  const [first] = GasCodeMerge.findUnits(FILE);
  assert.ok(FILE.slice(first.start, first.end).startsWith('/**'));
  assert.ok(FILE.slice(first.start, first.end).trimEnd().endsWith('}'));
});

test('caso real: la IA devuelve la función completa modificada → reemplaza solo esa función', () => {
  const block = `/**
 * Inserta texto en la posición del cursor (o al final si no hay cursor).
 *
 * @private
 * @param {string} text_ - Texto a insertar.
 * @returns {{success: boolean, usedCursor: boolean}}
 */
function insertTextAtCursor_(text_) {
  if (typeof text_ !== 'string' || text_.trim() === '') {
    throw new Error('El texto a insertar debe ser un string no vacío.');
  }
  const document_ = DocumentApp.getActiveDocument();
  const cursor_ = document_.getCursor();
  if (!cursor_) {
    document_.getBody().appendParagraph(text_);
    return { success: true, usedCursor: false };
  }
  const inserted_ = cursor_.insertText(text_);
  if (!inserted_) throw new Error('No fue posible insertar en la posición del cursor.');
  return { success: true, usedCursor: true };
}

// Ejemplo de uso:
insertTextAtCursor_('Hola');`;
  const res = GasCodeMerge.merge(FILE, block);
  assert.deepEqual([...res.replaced], ['insertTextAtCursor_']);
  assert.deepEqual([...res.added], []);
  assert.match(res.proposed, /debe ser un string no vacío/);
  assert.match(res.proposed, /function insertSummaryTable_\(cells_\)/, 'la otra función se conserva');
  assert.equal((res.proposed.match(/function insertTextAtCursor_/g) || []).length, 1);
  assert.ok(!res.proposed.includes("insertTextAtCursor_('Hola')"), 'el código suelto de ejemplo no se añade');
});

test('sin JSDoc en el bloque se conserva el del archivo', () => {
  const res = GasCodeMerge.merge(FILE, 'function insertSummaryTable_(cells_) {\n  return { success: false };\n}');
  assert.match(res.proposed, /\* Inserta una tabla nueva debajo del cursor/);
  assert.match(res.proposed, /return \{ success: false \};/);
});

test('funciones nuevas de nivel superior se añaden al final', () => {
  const res = GasCodeMerge.merge(FILE, 'function getDocumentContext_() {\n  return {};\n}');
  assert.deepEqual([...res.added], ['getDocumentContext_']);
  assert.ok(res.proposed.trimEnd().endsWith('function getDocumentContext_() {\n  return {};\n}'));
});

test('métodos de objeto (format: function) se reemplazan con la indentación del archivo', () => {
  const original = `const Formatters = {
  /** Formatea. */
  format: function (value_, decimals_) {
    return String(value_);
  },

  other: function () { return 1; },
};`;
  const block = `format: function (value_, decimals_) {
  if (value_ === '') return '0.00';
  return String(value_);
},`;
  const res = GasCodeMerge.merge(original, block);
  assert.deepEqual([...res.replaced], ['format']);
  assert.match(res.proposed, /\n  format: function \(value_, decimals_\) \{\n    if \(value_ === ''\) return '0\.00';/);
  assert.match(res.proposed, /\/\*\* Formatea\. \*\//);
  assert.match(res.proposed, /other: function/);
});

test('llaves dentro de strings, template literals y regex no rompen el emparejado', () => {
  const tricky = 'function a_() {\n  const s = "}{";\n  const t = `x ${ {k: 1}.k } }`;\n  const r = /\\}{2}/g;\n  return s + t;\n}\nfunction b_() { return 2; }\n';
  assert.deepEqual(names(tricky), [['a_', 'function'], ['b_', 'function']]);
  const res = GasCodeMerge.merge(tricky, 'function b_() { return 3; }');
  assert.match(res.proposed, /function b_\(\) \{ return 3; \}/);
  assert.match(res.proposed, /const r = \/\\\}\{2\}\/g;/);
});

test('const con arrow function y preservación de CRLF', () => {
  const original = 'const sum_ = (a, b) => {\r\n  return a + b;\r\n};\r\n';
  const res = GasCodeMerge.merge(original, 'const sum_ = (a, b) => {\n  return Number(a) + Number(b);\n};');
  assert.deepEqual([...res.replaced], ['sum_']);
  assert.ok(res.proposed.includes('\r\n'));
  assert.match(res.proposed, /Number\(a\) \+ Number\(b\)/);
});

test('bloques sin unidades con nombre devuelven null', () => {
  assert.equal(GasCodeMerge.merge(FILE, "Logger.log('hola');"), null);
  assert.equal(GasCodeMerge.merge(FILE, ''), null);
});
