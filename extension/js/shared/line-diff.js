// Diff por líneas (Myers O((N+M)·D), memoria lineal) compartido entre el editor (MAIN world), el Side Panel y los tests.
// Script clásico: define un único global `GasLineDiff` sin dependencias ni DOM.
// eslint-disable-next-line no-unused-vars
const GasLineDiff = (() => {
  // Tope de distancia de edición y de trabajo; por encima, diff de "bloque reemplazado".
  const MAX_EDIT_DISTANCE = 10000;
  const MAX_DIFF_COST = 40000000;
  const OVER_BUDGET = { overBudget: true };

  const EQ = 0;
  const DEL = 1;
  const ADD = 2;

  /** Divide un texto en líneas aceptando '\r\n', '\n' y '\r'. */
  const splitLines_ = (text) => {
    const s = text == null ? '' : String(text);
    if (s === '') return [];
    return s.replace(/\r\n?/g, '\n').split('\n');
  };

  /**
   * Middle snake de Myers (búsqueda bidireccional) sobre a[aLo..aHi) y b[bLo..bHi).
   * Devuelve el punto de corte [x, y] relativo al tramo, o null si no hay nada en común.
   */
  const bisect_ = (a, aLo, aHi, b, bLo, bHi, budget) => {
    const N = aHi - aLo;
    const M = bHi - bLo;
    const natural = Math.ceil((N + M) / 2);
    const capped = Math.ceil(MAX_EDIT_DISTANCE / 2) + 1;
    const maxD = Math.min(natural, capped);
    const vOffset = maxD;
    const vLength = 2 * maxD + 2;
    const v1 = new Int32Array(vLength).fill(-1);
    const v2 = new Int32Array(vLength).fill(-1);
    v1[vOffset + 1] = 0;
    v2[vOffset + 1] = 0;
    const delta = N - M;
    const front = (delta & 1) !== 0;
    let k1start = 0;
    let k1end = 0;
    let k2start = 0;
    let k2end = 0;

    for (let d = 0; d < maxD; d++) {
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const k1Offset = vOffset + k1;
        let x1 = (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1]))
          ? v1[k1Offset + 1]
          : v1[k1Offset - 1] + 1;
        let y1 = x1 - k1;
        const x0 = x1;
        while (x1 < N && y1 < M && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
        budget.left -= 1 + x1 - x0;
        v1[k1Offset] = x1;
        if (x1 > N) k1end += 2;
        else if (y1 > M) k1start += 2;
        else if (front) {
          const k2Offset = vOffset + delta - k1;
          if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1 && x1 >= N - v2[k2Offset]) return [x1, y1];
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const k2Offset = vOffset + k2;
        let x2 = (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1]))
          ? v2[k2Offset + 1]
          : v2[k2Offset - 1] + 1;
        let y2 = x2 - k2;
        const x0 = x2;
        while (x2 < N && y2 < M && a[aLo + N - x2 - 1] === b[bLo + M - y2 - 1]) { x2++; y2++; }
        budget.left -= 1 + x2 - x0;
        v2[k2Offset] = x2;
        if (x2 > N) k2end += 2;
        else if (y2 > M) k2start += 2;
        else if (!front) {
          const k1Offset = vOffset + delta - k2;
          if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
            const x1 = v1[k1Offset];
            const y1 = vOffset + x1 - k1Offset;
            if (x1 >= N - x2) return [x1, y1];
          }
        }
      }
      if (budget.left < 0) throw OVER_BUDGET;
    }
    if (maxD < natural) throw OVER_BUDGET;
    return null;
  };

  /** Script de edición (EQ/DEL/ADD + índices) del tramo, recursivo sobre el middle snake. */
  const diffRange_ = (a, aLo, aHi, b, bLo, bHi, out, budget) => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { out.push(EQ, aLo, bLo); aLo++; bLo++; }
    let suf = 0;
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; suf++; }

    if (aLo === aHi || bLo === bHi) {
      for (let i = aLo; i < aHi; i++) out.push(DEL, i, -1);
      for (let j = bLo; j < bHi; j++) out.push(ADD, -1, j);
    } else {
      const split = bisect_(a, aLo, aHi, b, bLo, bHi, budget);
      if (!split) {
        for (let i = aLo; i < aHi; i++) out.push(DEL, i, -1);
        for (let j = bLo; j < bHi; j++) out.push(ADD, -1, j);
      } else {
        diffRange_(a, aLo, aLo + split[0], b, bLo, bLo + split[1], out, budget);
        diffRange_(a, aLo + split[0], aHi, b, bLo + split[1], bHi, out, budget);
      }
    }
    for (let k = 0; k < suf; k++) out.push(EQ, aHi + k, bHi + k);
  };

  /**
   * Diff por líneas entre dos textos. Si agota el presupuesto, `ops.overBudget === true`.
   * @returns {{type:'equal'|'add'|'del', text:string, aLine?:number, bLine?:number}[]}
   */
  const diffLines = (a, b) => {
    const A = splitLines_(a);
    const B = splitLines_(b);

    // Líneas → enteros para comparar más rápido
    const ids = new Map();
    const idOf = (s) => {
      let v = ids.get(s);
      if (v === undefined) { v = ids.size; ids.set(s, v); }
      return v;
    };
    const ai = Int32Array.from(A, idOf);
    const bi = Int32Array.from(B, idOf);

    let script = [];
    let overBudget = false;
    try {
      diffRange_(ai, 0, ai.length, bi, 0, bi.length, script, { left: MAX_DIFF_COST });
    } catch (err) {
      if (err !== OVER_BUDGET) throw err;
      overBudget = true;
      // Fallback: prefijo/sufijo común y bloque central reemplazado
      script = [];
      let pre = 0;
      while (pre < ai.length && pre < bi.length && ai[pre] === bi[pre]) pre++;
      let suf = 0;
      while (suf < ai.length - pre && suf < bi.length - pre && ai[ai.length - 1 - suf] === bi[bi.length - 1 - suf]) suf++;
      for (let k = 0; k < pre; k++) script.push(EQ, k, k);
      for (let i = pre; i < ai.length - suf; i++) script.push(DEL, i, -1);
      for (let j = pre; j < bi.length - suf; j++) script.push(ADD, -1, j);
      for (let k = suf; k > 0; k--) script.push(EQ, ai.length - k, bi.length - k);
    }

    // Ops finales: en cada bloque de cambios, los borrados antes que las altas
    const ops = [];
    let dels = [];
    let adds = [];
    const flush = () => {
      for (const i of dels) ops.push({ type: 'del', text: A[i], aLine: i + 1 });
      for (const j of adds) ops.push({ type: 'add', text: B[j], bLine: j + 1 });
      dels = [];
      adds = [];
    };
    for (let p = 0; p < script.length; p += 3) {
      const t = script[p];
      if (t === DEL) dels.push(script[p + 1]);
      else if (t === ADD) adds.push(script[p + 2]);
      else {
        flush();
        ops.push({ type: 'equal', text: A[script[p + 1]], aLine: script[p + 1] + 1, bLine: script[p + 2] + 1 });
      }
    }
    flush();
    // Marca no enumerable: el resultado es el respaldo de "bloque reemplazado".
    if (overBudget) Object.defineProperty(ops, 'overBudget', { value: true });
    return ops;
  };

  /** Cuenta líneas añadidas y eliminadas. */
  const stats = (ops) => {
    let added = 0;
    let removed = 0;
    for (const op of ops || []) {
      if (op.type === 'add') added++;
      else if (op.type === 'del') removed++;
    }
    return { added, removed };
  };

  /**
   * Agrupa los cambios en hunks con `context` líneas iguales alrededor.
   * aStart/bStart son las líneas (1-based) donde empieza el hunk en cada lado.
   */
  const hunks = (ops, context = 3) => {
    const list = ops || [];
    const ctx = Math.max(0, context | 0);
    const result = [];

    // Posición (1-based) en a/b antes de cada op
    const posA = new Array(list.length);
    const posB = new Array(list.length);
    let ca = 1;
    let cb = 1;
    list.forEach((op, i) => {
      posA[i] = ca; posB[i] = cb;
      if (op.type !== 'add') ca++;
      if (op.type !== 'del') cb++;
    });

    let i = 0;
    while (i < list.length) {
      if (list[i].type === 'equal') { i++; continue; }
      const start = Math.max(0, i - ctx);
      // Extender mientras el siguiente cambio esté a <= 2*ctx líneas iguales
      let end = i;
      let k = i;
      while (k < list.length) {
        if (list[k].type !== 'equal') { end = k; k++; continue; }
        let run = 0;
        while (k + run < list.length && list[k + run].type === 'equal') run++;
        if (k + run >= list.length || run > 2 * ctx) break;
        k += run;
      }
      const stop = Math.min(list.length - 1, end + ctx);
      // Si el hunk previo se solapa (no debería tras la extensión), fusionar
      const prev = result[result.length - 1];
      if (prev && prev._last >= start - 1) {
        for (let x = prev._last + 1; x <= stop; x++) prev.ops.push(list[x]);
        prev._last = stop;
      } else {
        result.push({ aStart: posA[start], bStart: posB[start], ops: list.slice(start, stop + 1), _last: stop });
      }
      i = stop + 1;
    }
    return result.map(({ aStart, bStart, ops: o }) => ({ aStart, bStart, ops: o }));
  };

  return Object.freeze({ diffLines, stats, hunks, MAX_EDIT_DISTANCE });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasLineDiff };
