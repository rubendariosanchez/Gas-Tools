// Resolución y aplicación de ediciones del LLM (hunks SEARCH/REPLACE o texto completo).
// Script clásico puro (sin DOM): Side Panel, MAIN world y tests. Define el global `GasEditApplier`.
// Offsets de las ediciones: siempre sobre el texto normalizado a '\n'.
// eslint-disable-next-line no-unused-vars
const GasEditApplier = (() => {
  const FUZZY_THRESHOLD = 0.9;      // similitud normalizada mínima
  const FUZZY_MAX_LINES = 80;       // SEARCH más largo: sin fuzzy
  const FUZZY_MIN_CHARS = 24;       // SEARCH muy corto: sin fuzzy (falsos positivos)
  const FUZZY_MAX_WORK = 3000000;   // tope de líneas comparadas por hunk

  const normalizeNl_ = (s) => (s == null ? '' : String(s)).replace(/\r\n?/g, '\n');
  const leadingWs_ = (s) => s.match(/^[ \t]*/)[0];

  /** Líneas de un bloque sin el '' final producido por un salto de línea final. */
  const toLines_ = (s) => {
    const lines = s.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  /** Primera indentación no vacía de un conjunto de líneas. */
  const firstIndent_ = (lines) => {
    const l = lines.find((x) => x.trim() !== '');
    return l === undefined ? '' : leadingWs_(l);
  };

  /** Reindenta `lines` sustituyendo la indentación base `from` por `to`. */
  const reindent_ = (lines, from, to) => lines.map((l) => {
    if (l.trim() === '') return '';
    if (from && l.startsWith(from)) return to + l.slice(from.length);
    const ws = leadingWs_(l);
    return to + (ws.length >= from.length ? l.slice(from.length) : l.slice(ws.length));
  });

  /** Índice de líneas del texto (una vez por resolución). */
  const index_ = (text) => {
    const lines = text.split('\n');
    const starts = new Array(lines.length);
    let o = 0;
    for (let i = 0; i < lines.length; i++) { starts[i] = o; o += lines[i].length + 1; }
    const norms = new Map();
    /** Líneas normalizadas con `fn` (caché por tier). */
    const normalized = (key, fn) => {
      if (!norms.has(key)) norms.set(key, lines.map(fn));
      return norms.get(key);
    };
    return { text, lines, starts, normalized };
  };

  /** Primera línea cuyo inicio es >= offset. */
  const lineFrom_ = (starts, offset) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < offset) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  /** Edición por offsets que reemplaza las líneas [at, at+n) por `out`. */
  const lineEdit_ = (idx, at, n, out) => {
    const { lines, starts, text } = idx;
    const start = starts[at];
    const lastEnd = starts[at + n - 1] + lines[at + n - 1].length;
    if (out.length) return { start, end: lastEnd, text: out.join('\n') };
    // Borrado de líneas completas: se lleva un salto de línea
    if (at + n < lines.length) return { start, end: starts[at + n], text: '' };
    if (at > 0) return { start: start - 1, end: lastEnd, text: '' };
    return { start: 0, end: text.length, text: '' };
  };

  const overlaps_ = (taken, s, e) => taken.some((t) => s < t.end && t.start < e);

  /** Levenshtein con corte: devuelve `max + 1` si se supera `max`. */
  const lev_ = (a, b, max) => {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  };

  const fuzzyNorm_ = (l) => l.trim().replace(/\s+/g, ' ');

  /** Similitud de la ventana [at, at+n) con el SEARCH, o -1 si queda bajo el umbral. */
  const windowScore_ = (hay, needle, at) => {
    let total = 0;
    for (let k = 0; k < needle.length; k++) total += Math.max(hay[at + k].length, needle[k].length);
    if (!total) return 1;
    let budget = Math.floor((1 - FUZZY_THRESHOLD) * total);
    let dist = 0;
    for (let k = 0; k < needle.length; k++) {
      const d = lev_(hay[at + k], needle[k], budget);
      if (d > budget) return -1;
      budget -= d;
      dist += d;
    }
    return 1 - dist / total;
  };

  /** Hasta dos coincidencias por líneas desde `from` (sin solapar ediciones previas). */
  const findLineMatches_ = (idx, sLines, key, fn, from, taken) => {
    const hay = idx.normalized(key, fn);
    const needle = sLines.map(fn);
    const n = needle.length;
    const found = [];
    outer: for (let i = from; i + n <= hay.length && found.length < 2; i++) {
      for (let k = 0; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
      const s = idx.starts[i];
      const e = idx.starts[i + n - 1] + idx.lines[i + n - 1].length;
      if (!overlaps_(taken, s, e)) found.push(i);
    }
    return found;
  };

  /** Ventana fuzzy única desde `from`, `{at}` | `{ambiguous:true}` | null. */
  const findFuzzy_ = (idx, sLines, from, taken) => {
    const n = sLines.length;
    const needle = sLines.map(fuzzyNorm_);
    if (n > FUZZY_MAX_LINES || needle.join('').length < FUZZY_MIN_CHARS) return null;
    if ((idx.lines.length - from) * n > FUZZY_MAX_WORK) return null;
    const hay = idx.normalized('fuzzy', fuzzyNorm_);
    const hits = [];
    for (let i = from; i + n <= hay.length; i++) {
      const score = windowScore_(hay, needle, i);
      if (score < 0) continue;
      const s = idx.starts[i];
      const e = idx.starts[i + n - 1] + idx.lines[i + n - 1].length;
      if (!overlaps_(taken, s, e)) hits.push({ at: i, score });
    }
    if (!hits.length) return null;
    const best = hits.reduce((m, h) => (h.score > m.score ? h : m), hits[0]);
    // Otra ventana válida que no solapa la mejor: no es única
    const rival = hits.some((h) => h !== best && (Math.abs(h.at - best.at) >= n || h.score === best.score));
    return rival ? { ambiguous: true } : { at: best.at };
  };

  /**
   * Localiza un hunk desde `fromOffset`: exacto → sin espacios finales →
   * sin indentación (reindenta) → fuzzy acotado.
   * @returns {{edit:object}|{reason:'not-found'|'ambiguous'}}
   */
  const locate_ = (idx, search, replace, fromOffset, taken) => {
    const { text } = idx;
    // 1) Exacto (subcadena)
    const exact = [];
    for (let i = text.indexOf(search, fromOffset); i >= 0 && exact.length < 2; i = text.indexOf(search, i + 1)) {
      if (!overlaps_(taken, i, i + search.length)) exact.push(i);
    }
    if (exact.length > 1) return { reason: 'ambiguous' };
    if (exact.length) return { edit: { start: exact[0], end: exact[0] + search.length, text: replace, tier: 'exact' } };

    const sLines = toLines_(search);
    const rLines = replace === '' ? [] : toLines_(replace);
    const from = lineFrom_(idx.starts, fromOffset);
    const n = sLines.length;

    // 2) Línea a línea ignorando espacios finales
    let hits = findLineMatches_(idx, sLines, 'trail', (l) => l.replace(/\s+$/, ''), from, taken);
    if (hits.length > 1) return { reason: 'ambiguous' };
    if (hits.length) return { edit: { ...lineEdit_(idx, hits[0], n, rLines), tier: 'trailing-ws' } };

    // 3) Ignorando indentación: se reindenta el reemplazo según lo encontrado
    const reindented = (at) => reindent_(rLines, firstIndent_(sLines), firstIndent_(idx.lines.slice(at, at + n)));
    hits = findLineMatches_(idx, sLines, 'trim', (l) => l.trim(), from, taken);
    if (hits.length > 1) return { reason: 'ambiguous' };
    if (hits.length) return { edit: { ...lineEdit_(idx, hits[0], n, reindented(hits[0])), tier: 'indent' } };

    // 4) Fuzzy: ventanas del mismo número de líneas, solo si es única
    const fz = findFuzzy_(idx, sLines, from, taken);
    if (fz?.ambiguous) return { reason: 'ambiguous' };
    if (fz) return { edit: { ...lineEdit_(idx, fz.at, n, reindented(fz.at)), tier: 'fuzzy' } };
    return { reason: 'not-found' };
  };

  /** Aplica ediciones por offsets (sin solapes) sobre un texto con '\n'. */
  const applyEdits = (text, edits) => {
    const list = (edits || []).slice().sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const e of list) {
      out += text.slice(pos, e.start) + e.text;
      pos = e.end;
    }
    return out + text.slice(pos);
  };

  /**
   * Resuelve los hunks sobre el texto, en orden y sin solapes (sin LCS).
   * @param {string} text
   * @param {Array<{search:string, replace:string}>} hunks
   * @returns {{edits:Array<{start:number,end:number,text:string,tier:string,index:number}>,
   *   failed:Array<{index:number,search:string,reason:string}>, proposed:string}}
   */
  const resolveHunks = (text, hunks) => {
    const src = text == null ? '' : String(text);
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const idx = index_(normalizeNl_(src));
    const edits = [];
    const failed = [];
    let cursor = 0;

    (hunks || []).forEach((h, index) => {
      const search = normalizeNl_(h && h.search);
      const replace = normalizeNl_(h && h.replace);
      if (search.trim() === '') {
        if (idx.text.trim() === '' && !edits.length) {
          edits.push({ start: 0, end: idx.text.length, text: replace, tier: 'exact', index });
          cursor = idx.text.length;
        } else {
          failed.push({ index, search, reason: 'empty-search' });
        }
        return;
      }
      let res = locate_(idx, search, replace, cursor, edits);
      // Solo si no aparece en la zona restante se busca en todo el texto
      if (res.reason === 'not-found' && cursor > 0) res = locate_(idx, search, replace, 0, edits);
      if (res.edit) {
        edits.push({ ...res.edit, index });
        cursor = Math.max(cursor, res.edit.end);
      } else {
        failed.push({ index, search, reason: res.reason });
      }
    });

    edits.sort((a, b) => a.start - b.start);
    const out = applyEdits(idx.text, edits);
    return { edits, failed, proposed: eol === '\n' ? out : out.split('\n').join(eol) };
  };

  /**
   * Ediciones mínimas por rangos de líneas entre `original` y `proposed`
   * (antes `_buildLineEdits_` de gas-tools). `null` si no hay diff o no cuadra.
   * @param {string} original
   * @param {string} proposed
   * @param {Function} diffFn `GasLineDiff.diffLines`.
   * @returns {Array<{range:object, text:string}>|null}
   */
  const fromFullText = (original, proposed, diffFn) => {
    if (typeof diffFn !== 'function') return null;
    const lines = normalizeNl_(original).split('\n');
    const next = normalizeNl_(proposed);
    let ops;
    try { ops = diffFn(lines.join('\n'), next); } catch (_) { return null; }
    if (!Array.isArray(ops)) return null;

    // Las ops deben reconstruir exactamente ambos textos
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
        // Borrado hasta el final: absorbe el salto de línea anterior
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
      edits.push({ range, text });
    }
    return edits.length ? edits : null;
  };

  /** Texto del modelo normalizado a '\n'. */
  const liveText_ = (model) => (typeof model.getLinesContent === 'function'
    ? model.getLinesContent().join('\n')
    : normalizeNl_(model.getValue()));

  /** Rango completo del modelo. */
  const fullRange_ = (model) => {
    if (typeof model.getFullModelRange === 'function') return model.getFullModelRange();
    const lines = liveText_(model).split('\n');
    return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 };
  };

  /**
   * Ediciones de Monaco: offsets (texto '\n') → posiciones; el texto usa el
   * EOL del modelo (CRLF). `forceMoveMarkers:false` conserva el cursor.
   */
  const toMonacoEdits = (model, edits) => {
    const eol = model.getEOL?.() || '\n';
    const conv = (t) => (eol === '\n' ? t : t.replace(/\n/g, eol));
    let starts = null;
    const posAt = (offset) => {
      if (eol === '\n' && typeof model.getPositionAt === 'function') return model.getPositionAt(offset);
      if (!starts) starts = index_(liveText_(model)).starts;
      const line = Math.max(0, lineFrom_(starts, offset + 1) - 1);
      return { lineNumber: line + 1, column: offset - starts[line] + 1 };
    };
    return (edits || []).map((e) => {
      if (e.range) return { range: e.range, text: conv(e.text), forceMoveMarkers: false };
      const s = posAt(e.start);
      const en = posAt(e.end);
      return {
        range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: en.lineNumber, endColumn: en.column },
        text: conv(e.text),
        forceMoveMarkers: false,
      };
    });
  };

  /** Versión alternativa del modelo (deshacer vuelve al mismo id) o null. */
  const versionOf_ = (model) => {
    try { return typeof model.getAlternativeVersionId === 'function' ? model.getAlternativeVersionId() : null; } catch (_) { return null; }
  };

  /**
   * Texto propuesto sobre el texto vivo. Hunks: se vuelven a resolver (rebase);
   * archivo completo: conflicto si `versionId` no coincide.
   * @param {string} live Texto actual.
   * @param {{mode?:string, batches?:Array, proposed?:string, baseVersionId?:number}} spec
   * @param {number|null} version `getAlternativeVersionId()` actual.
   * @returns {{proposed:string, edits:Array|null, fuzzy:number}|{conflict:{reason:'hunks'|'changed', failed:Array}}}
   */
  const rebase = (live, spec, version) => {
    const text0 = normalizeNl_(live);
    const target = normalizeNl_(spec?.proposed);
    const batches = Array.isArray(spec?.batches) ? spec.batches.filter((b) => Array.isArray(b) && b.length) : [];
    if (spec?.mode === 'hunks' && batches.length) {
      let text = text0;
      let edits = null;
      let fuzzy = 0;
      const failed = [];
      batches.forEach((batch, b) => {
        const r = resolveHunks(text, batch);
        failed.push(...r.failed.map(({ index, search, reason }) => ({ index, search, reason, batch: b })));
        fuzzy += r.edits.filter((e) => e.tier === 'fuzzy').length;
        text = r.proposed;
        edits = batches.length === 1 ? r.edits : null;
      });
      return failed.length ? { conflict: { reason: 'hunks', failed } } : { proposed: text, edits, fuzzy };
    }
    if (spec?.baseVersionId != null && version != null && spec.baseVersionId !== version && text0 !== target) {
      return { conflict: { reason: 'changed', failed: [] } };
    }
    return { proposed: target, edits: null, fuzzy: 0 };
  };

  /**
   * Valida un archivo contra el modelo vivo y prepara sus ediciones.
   * status: 'ready' | 'unchanged' | 'conflict' | 'not-found'.
   */
  const planFile_ = (spec, deps) => {
    const name = String(spec?.name ?? '');
    const model = deps.findModel(name);
    if (!model) return { name, status: 'not-found' };
    const live = liveText_(model);
    const version = versionOf_(model);
    const base = { name, model, live, key: spec.key || '' };

    // Idempotencia: reintento tras un timeout o archivo ya con el cambio
    const prior = base.key && deps.applied?.get?.(base.key);
    if (prior && prior.model === model && prior.version === version) return { ...base, status: 'unchanged' };
    if (live === normalizeNl_(spec.proposed)) return { ...base, status: 'unchanged' };

    const r = rebase(live, spec, version);
    if (r.conflict) return { ...base, status: 'conflict', ...r.conflict };
    if (r.proposed === live) return { ...base, status: 'unchanged' };
    return { ...base, status: 'ready', text: r.proposed, fuzzy: r.fuzzy, edits: r.edits || fromFullText(live, r.proposed, deps.diff) };
  };

  /** Deshace lo aplicado a un modelo; si no cuadra, restaura el texto. */
  const rollback_ = async (plan, deps) => {
    try { await deps.undo(plan.model); } catch (_) { /* se fuerza abajo */ }
    if (liveText_(plan.model) === plan.live) return true;
    try {
      deps.applyEdits(plan.model, toMonacoEdits(plan.model, [{ range: fullRange_(plan.model), text: plan.live }]));
    } catch (_) { return false; }
    return liveText_(plan.model) === plan.live;
  };

  /** Resultado público (sin modelos ni textos). */
  const publicResult_ = (p) => {
    const out = { name: p.name, status: p.status };
    if (p.reason) out.reason = p.reason;
    if (p.failed?.length) out.failed = p.failed.map(({ index, search, reason, batch }) => ({ index, search, reason, batch }));
    if (p.fuzzy) out.fuzzy = p.fuzzy;
    if (p.error) out.error = p.error;
    return out;
  };

  /**
   * Aplica un ChangeSet todo o nada: valida todo primero (rebase de hunks /
   * versionId en archivo completo) y, si algo falla al aplicar, deshace lo ya aplicado.
   * @param {Array<{name:string, mode?:'hunks'|'full', batches?:Array, proposed:string, baseVersionId?:number, key?:string}>} files
   * @param {{findModel:Function, applyEdits:Function, undo:Function, diff?:Function, applied?:Map}} deps
   * @returns {Promise<{ok:boolean, error?:string, results:Array<object>}>}
   */
  const applyChangeSet = async (files, deps) => {
    const plans = (Array.isArray(files) ? files : []).map((spec) => {
      try { return planFile_(spec || {}, deps); } catch (err) {
        return { name: String(spec?.name ?? ''), status: 'error', error: String(err?.message || err) };
      }
    });
    if (!plans.length) return { ok: false, error: 'no-files', results: [] };
    const blocked = plans.find((p) => p.status === 'conflict')
      || plans.find((p) => p.status === 'not-found')
      || plans.find((p) => p.status === 'error');
    if (blocked) return { ok: false, error: blocked.status, results: plans.map(publicResult_) };

    const touched = [];
    try {
      for (const p of plans) {
        if (p.status !== 'ready') continue;
        const edits = p.edits || [{ range: fullRange_(p.model), text: p.text }];
        touched.push(p);
        deps.applyEdits(p.model, toMonacoEdits(p.model, edits));
        if (liveText_(p.model) !== p.text) throw new Error('verify-failed');
        p.status = 'applied';
      }
    } catch (err) {
      const error = String(err?.message || err);
      for (const p of touched.reverse()) {
        const restored = await rollback_(p, deps);
        p.status = restored ? 'rolled-back' : 'error';
        if (!restored) p.error = 'rollback-failed';
      }
      plans.forEach((p) => { if (p.status === 'ready') p.status = 'skipped'; });
      return { ok: false, error: 'apply-failed', detail: error, results: plans.map(publicResult_) };
    }
    plans.forEach((p) => {
      if (p.status === 'applied' && p.key) deps.applied?.set?.(p.key, { model: p.model, version: versionOf_(p.model) });
    });
    return { ok: true, results: plans.map(publicResult_) };
  };

  return Object.freeze({
    FUZZY_THRESHOLD, resolveHunks, applyEdits, fromFullText, toMonacoEdits, rebase, applyChangeSet,
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasEditApplier };
