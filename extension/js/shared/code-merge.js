"use strict";

/**
 * @fileoverview "Apply" estilo Cursor: fusiona un bloque de código devuelto
 * por la IA (markdown normal, sin formato de edición) con el archivo actual.
 *
 * Los modelos pequeños suelen responder con la función completa ya
 * modificada en vez de usar bloques SEARCH/REPLACE. Este módulo localiza en
 * el bloque las unidades de código con nombre (funciones, métodos de
 * objeto, `const x = function/arrow`) y:
 *  - reemplaza en el archivo la unidad con el mismo nombre (incluido su
 *    JSDoc si el bloque trae uno; si no, se conserva el del archivo);
 *  - añade al final las funciones de nivel superior que no existían.
 *
 * Puro y sin DOM (script clásico): lo usan el Side Panel y los tests.
 */
const GasCodeMerge = (() => {
  // Declaraciones reconocidas (al inicio de línea, con indentación):
  //   function name(        async function name(
  //   name: function (      name: async function (     name(args) {   (método)
  //   const|let|var name = function / async function / (args) => / arg =>
  const DECL_PATTERNS = [
    { kind: 'function', re: /^([ \t]*)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: 'property', re: /^([ \t]*)([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/ },
    { kind: 'variable', re: /^([ \t]*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
    { kind: 'method', re: /^([ \t]*)(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  ];

  /**
   * Índice del carácter que cierra la llave abierta en `openIdx`, saltando
   * strings, template literals, comentarios y regex literales.
   * @returns {number} índice de `}` o -1.
   */
  function matchBrace_(text, openIdx) {
    let depth = 0;
    const templateStack = [];   // profundidad de llaves al entrar a `${`
    let i = openIdx;
    let prevSignificant = '';
    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];
      if (ch === '/' && next === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? text.length : nl; continue; }
      if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
      if (ch === '"' || ch === "'") { i = skipString_(text, i, ch); prevSignificant = ch; continue; }
      if (ch === '`') { i = skipTemplate_(text, i, templateStack, depth); prevSignificant = '`'; continue; }
      if (ch === '/' && isRegexStart_(prevSignificant)) { i = skipRegex_(text, i); prevSignificant = '/'; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (templateStack.length && templateStack[templateStack.length - 1] === depth) {
          // Fin de `${ … }` dentro de un template: seguimos dentro del template.
          templateStack.pop();
          i = skipTemplate_(text, i, templateStack, depth, true);
          continue;
        }
        if (depth === 0) return i;
      }
      if (!/\s/.test(ch)) prevSignificant = ch;
      i++;
    }
    return -1;
  }

  function skipString_(text, i, quote) {
    i++;
    while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    return i + 1;
  }

  /** Avanza dentro de un template; si encuentra `${` apila y vuelve al flujo normal. */
  function skipTemplate_(text, i, stack, depth, resuming = false) {
    i = resuming ? i + 1 : i + 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '`') return i + 1;
      if (text[i] === '$' && text[i + 1] === '{') { stack.push(depth); return i + 1; }   // el `{` lo cuenta el bucle principal
      i++;
    }
    return i;
  }

  function isRegexStart_(prev) {
    return prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev);
  }

  function skipRegex_(text, i) {
    i++;
    let inClass = false;
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '[') inClass = true;
      else if (text[i] === ']') inClass = false;
      else if (text[i] === '/' && !inClass) { i++; break; }
      i++;
    }
    while (/[a-z]/i.test(text[i] || '')) i++;
    return i;
  }

  /**
   * Unidades con nombre del texto.
   * @returns {Array<{name, kind, indent, start, declStart, end}>} offsets de
   *   carácter: `start` incluye el JSDoc contiguo; `end` es exclusivo e
   *   incluye `,`/`;` final de la misma línea.
   */
  function findUnits(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const units = [];
    const lineStarts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);

    let skipUntil = -1;
    for (let li = 0; li < lineStarts.length; li++) {
      const lineStart = lineStarts[li];
      if (lineStart < skipUntil) continue;          // dentro de una unidad ya encontrada
      const lineEnd = src.indexOf('\n', lineStart);
      const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
      const decl = DECL_PATTERNS.map((p) => ({ p, m: line.match(p.re) })).find((x) => x.m);
      if (!decl) continue;

      const openIdx = src.indexOf('{', lineStart + decl.m[0].length - 1);
      if (openIdx === -1) continue;
      const closeIdx = matchBrace_(src, openIdx);
      if (closeIdx === -1) continue;

      let end = closeIdx + 1;
      const rest = src.slice(end).match(/^[ \t]*[,;)]*[ \t]*/);
      end += rest ? rest[0].length : 0;

      // JSDoc / comentario de bloque inmediatamente encima.
      let start = lineStart;
      const before = src.slice(0, lineStart);
      const doc = before.match(/(?:^|\n)([ \t]*\/\*\*[\s\S]*?\*\/[ \t]*\n)$/);
      if (doc) start = lineStart - doc[1].length;

      units.push({ name: decl.m[2], kind: decl.p.kind, indent: decl.m[1], start, declStart: lineStart, end });
      skipUntil = end;   // las unidades anidadas no se consideran por separado
    }
    return units;
  }

  /** Reindenta `text` para que su indentación base pase de `from` a `to`. */
  function reindent_(text, from, to) {
    if (from === to) return text;
    return text.split('\n').map((l) => {
      if (!l.trim()) return l;
      return l.startsWith(from) ? to + l.slice(from.length) : to + l.replace(/^[ \t]*/, '');
    }).join('\n');
  }

  /**
   * Fusiona `block` en `original`.
   * @returns {{proposed:string, replaced:string[], added:string[]}|null}
   *   `null` si el bloque no contiene unidades aplicables.
   */
  function merge(original, block) {
    const crlf = /\r\n/.test(original || '');
    const orig = String(original || '').replace(/\r\n?/g, '\n');
    const blk = String(block || '').replace(/\r\n?/g, '\n');

    const blockUnits = findUnits(blk);
    if (!blockUnits.length) return null;
    const origUnits = findUnits(orig);

    const replacements = [];
    const replaced = [];
    const added = [];
    for (const bu of blockUnits) {
      const target = origUnits.find((ou) => ou.name === bu.name && !replacements.some((r) => r.unit === ou));
      const blockHasDoc = bu.start < bu.declStart;
      if (target) {
        // Sin JSDoc en el bloque → se conserva el del archivo.
        const from = blockHasDoc ? target.start : target.declStart;
        const piece = blk.slice(blockHasDoc ? bu.start : bu.declStart, bu.end).replace(/\s+$/, '');
        const tail = orig.slice(from, target.end).match(/\s*$/)[0];
        replacements.push({ unit: target, from, to: target.end, text: reindent_(piece, bu.indent, target.indent) + tail });
        replaced.push(bu.name);
      } else if (bu.kind === 'function' || bu.kind === 'variable') {
        added.push({ name: bu.name, text: reindent_(blk.slice(bu.start, bu.end).replace(/\s+$/, ''), bu.indent, '') });
      }
    }
    if (!replacements.length && !added.length) return null;

    let proposed = orig;
    for (const r of replacements.sort((a, b) => b.from - a.from)) {
      proposed = proposed.slice(0, r.from) + r.text + proposed.slice(r.to);
    }
    if (added.length) {
      proposed = `${proposed.replace(/\s*$/, '')}\n\n${added.map((a) => a.text).join('\n\n')}\n`;
    }
    if (crlf) proposed = proposed.replace(/\n/g, '\r\n');
    return { proposed, replaced, added: added.map((a) => a.name) };
  }

  return Object.freeze({ findUnits, merge });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasCodeMerge };
