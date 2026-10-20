// Protocolo de ediciones propuestas por el LLM (bloques FILE + SEARCH/REPLACE).
// Script clásico: define el global `GasEditBlocks` (sin DOM); `applyHunks` requiere `GasEditApplier` cargado antes.
// eslint-disable-next-line no-unused-vars
const GasEditBlocks = (() => {
  const FORMAT_INSTRUCTIONS = [
    'When you propose changes to the project files, use EXACTLY this edit-block format:',
    '',
    '<<<FILE path="Core/CalcTools.gs" action="edit">>>',
    '<<<<<<< SEARCH',
    'existing lines',
    '=======',
    'new lines',
    '>>>>>>> REPLACE',
    '<<<END>>>',
    '<<<FILE path="Utils/Dates.gs" action="create">>>',
    'full content',
    '<<<END>>>',
    '',
    'Rules:',
    '- The path must match the project file name exactly as listed (e.g. "Core/CalcTools.gs"), including folders and extension.',
    '- Every SEARCH section must copy existing lines from the current file verbatim, including indentation and comments.',
    '- Keep each SEARCH section as small as possible while still being unique within the file.',
    '- A single FILE block may contain several SEARCH/REPLACE pairs, in the order they appear in the file.',
    '- To delete code, leave the REPLACE section empty.',
    '- To create a new file, use action="create" with the full file content and no SEARCH/REPLACE markers.',
    '- Close every FILE block with <<<END>>>.',
    '- Outside the blocks, write only a brief explanation of the changes.',
    '- Never wrap the blocks in markdown code fences (```).',
  ].join('\n');

  // Marcadores tolerantes a espacios extra
  const RE_FILE_OPEN = /^[ \t]*<<<[ \t]*FILE\b(.*?)>>>[ \t]*$/i;
  const RE_FILE_END = /^[ \t]*<<<[ \t]*END[ \t]*>>>[ \t]*$/i;
  const RE_SEARCH = /^[ \t]*<{5,9}[ \t]*SEARCH[ \t]*$/i;
  const RE_DIVIDER = /^[ \t]*={5,9}[ \t]*$/;
  const RE_REPLACE = /^[ \t]*>{5,9}[ \t]*REPLACE[ \t]*$/i;
  const RE_FENCE = /^[ \t]*(```|~~~)/;
  const RE_ATTR = /(\w+)[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  const normalizeNl_ = (s) => (s == null ? '' : String(s)).replace(/\r\n?/g, '\n');

  /** Lee atributos `clave="valor"` de la línea de apertura. */
  const parseAttrs_ = (raw) => {
    const attrs = {};
    let m;
    RE_ATTR.lastIndex = 0;
    while ((m = RE_ATTR.exec(raw)) !== null) {
      attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    }
    return attrs;
  };

  /** Extrae los pares SEARCH/REPLACE completos de las líneas de un bloque. */
  const parseHunks_ = (lines) => {
    const out = [];
    let state = 'idle';
    let search = [];
    let replace = [];
    for (const line of lines) {
      if (state === 'idle') {
        if (RE_SEARCH.test(line)) { state = 'search'; search = []; replace = []; }
      } else if (state === 'search') {
        if (RE_DIVIDER.test(line)) state = 'replace';
        else search.push(line);
      } else if (RE_REPLACE.test(line)) {
        out.push({ search: search.join('\n'), replace: replace.join('\n') });
        state = 'idle';
      } else {
        replace.push(line);
      }
    }
    return out;
  };

  /** Quita una valla markdown que envuelva todo el contenido de un `create`. */
  const unwrapFence_ = (lines) => {
    let s = 0;
    let e = lines.length - 1;
    while (s <= e && lines[s].trim() === '') s++;
    while (e >= s && lines[e].trim() === '') e--;
    if (e > s && RE_FENCE.test(lines[s]) && /^[ \t]*(```|~~~)[ \t]*$/.test(lines[e])) {
      return lines.slice(s + 1, e);
    }
    return lines;
  };

  /** Construye la entrada de archivo a partir de sus líneas crudas. */
  const buildFile_ = (attrs, bodyLines, partial) => {
    const hasMarkers = bodyLines.some((l) => RE_SEARCH.test(l));
    let action = (attrs.action || '').toLowerCase();
    if (action !== 'edit' && action !== 'create') action = hasMarkers ? 'edit' : 'create';
    const file = { path: (attrs.path || attrs.file || '').trim(), action, hunks: [], content: '' };
    if (action === 'edit') file.hunks = parseHunks_(bodyLines);
    else file.content = unwrapFence_(bodyLines).join('\n');
    if (partial) file.partial = true;
    return file;
  };

  /** Índice de la siguiente línea no vacía a partir de `from`, o -1. */
  const nextNonBlank_ = (lines, from) => {
    for (let k = from; k < lines.length; k++) if (lines[k].trim() !== '') return k;
    return -1;
  };

  /**
   * Analiza la respuesta del modelo.
   * @returns {{ prose: string, files: object[], partial: boolean }}
   */
  const parse = (text) => {
    const lines = normalizeNl_(text).split('\n');
    const prose = [];
    const files = [];
    let current = null; // { attrs, body }
    let blockFence = false; // dentro de una valla que solo envuelve bloques
    let proseFence = false; // dentro de un bloque de código normal de la prosa

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (current) {
        if (RE_FILE_END.test(line)) {
          files.push(buildFile_(current.attrs, current.body, false));
          current = null;
        } else {
          current.body.push(line);
        }
        continue;
      }

      const open = line.match(RE_FILE_OPEN);
      if (open) {
        current = { attrs: parseAttrs_(open[1]), body: [] };
        continue;
      }

      if (RE_FENCE.test(line)) {
        if (blockFence) {
          // Cierre de la valla que envolvía bloques (o reapertura antes de otro bloque)
          const nx = nextNonBlank_(lines, i + 1);
          blockFence = nx >= 0 && RE_FILE_OPEN.test(lines[nx]) && /^[ \t]*(```|~~~)\S/.test(line);
          continue;
        }
        const nx = nextNonBlank_(lines, i + 1);
        if (!proseFence && nx >= 0 && RE_FILE_OPEN.test(lines[nx])) {
          blockFence = true;
          continue;
        }
        // Valla normal de la prosa: alternar apertura/cierre
        proseFence = !proseFence;
      }
      prose.push(line);
    }

    let partial = false;
    if (current) {
      // Bloque sin <<<END>>> (streaming): se descarta una valla de cierre colgante
      const body = current.body.slice();
      if (blockFence) {
        let e = body.length - 1;
        while (e >= 0 && body[e].trim() === '') e--;
        if (e >= 0 && /^[ \t]*(```|~~~)[ \t]*$/.test(body[e])) body.length = e;
      }
      files.push(buildFile_(current.attrs, body, true));
      partial = true;
    }

    const proseText = prose.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { prose: proseText, files, partial };
  };

  /** Comprobación barata de si el texto contiene algún bloque FILE. */
  const hasBlocks = (text) => /<<<[ \t]*FILE\b/i.test(String(text || ''));

  /** Ruta del último bloque abierto sin <<<END>>>, o null. */
  const pendingPath = (text) => {
    const s = normalizeNl_(text);
    const re = /^[ \t]*<<<[ \t]*FILE\b(.*?)>>>[ \t]*$/gim;
    let last = null;
    let m;
    while ((m = re.exec(s)) !== null) last = { attrs: m[1], end: re.lastIndex };
    if (!last) return null;
    if (/^[ \t]*<<<[ \t]*END[ \t]*>>>[ \t]*$/im.test(s.slice(last.end))) return null;
    const attrs = parseAttrs_(last.attrs);
    return (attrs.path || attrs.file || '').trim() || null;
  };

  // ── Aplicación de hunks ───────────────────────────────────────────────

  /** Líneas de un bloque SEARCH/REPLACE sin el '' final producido por un salto de línea final. */
  const toLines_ = (s) => {
    const lines = s.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  /**
   * Aplica los hunks en orden sobre el original (delegado en `GasEditApplier.resolveHunks`).
   * @returns {{ proposed: string, applied: number, failed: {index:number, search:string, reason:string}[] }}
   */
  const applyHunks = (original, hunkList) => {
    if (typeof GasEditApplier === 'undefined') throw new Error('GasEditApplier not loaded');
    const { edits, failed, proposed } = GasEditApplier.resolveHunks(original, hunkList);
    return { proposed, applied: edits.length, failed };
  };

  /** Busca en el original la zona más parecida al SEARCH fallido (por su primera línea). */
  const nearestRegion_ = (search, original) => {
    const first = toLines_(search).map((l) => l.trim()).find((l) => l.length >= 3);
    if (!first) return '';
    const lines = normalizeNl_(original).split('\n');
    const at = lines.findIndex((l) => l.includes(first) || (l.trim().length >= 3 && first.includes(l.trim())));
    if (at < 0) return '';
    const n = Math.min(Math.max(toLines_(search).length, 1) + 2, 15);
    return lines.slice(Math.max(0, at - 1), at - 1 + n).join('\n');
  };

  const truncate_ = (s, maxLines = 30) => {
    const lines = s.split('\n');
    return lines.length <= maxLines ? s : `${lines.slice(0, maxLines).join('\n')}\n…`;
  };

  /** Texto en inglés para pedir al modelo que reintente los SEARCH fallidos. */
  const formatFeedback = (failed, original) => {
    const list = failed || [];
    if (!list.length) return '';
    const parts = [
      `${list.length} SEARCH block(s) of your previous edit could not be applied because they do not match the current file.`,
    ];
    list.forEach((f) => {
      const why = {
        'empty-search': 'empty SEARCH on a non-empty file',
        ambiguous: 'matches several places; add more surrounding context so it is unique',
      }[f.reason] || 'lines not found';
      parts.push('', `Block #${f.index + 1} (${why}). Your SEARCH was:`, '```', truncate_(f.search || ''), '```');
      const near = original ? nearestRegion_(f.search || '', original) : '';
      if (near) parts.push('Closest lines in the current file:', '```', truncate_(near), '```');
    });
    parts.push(
      '',
      'Please resend only the failed edits using the same FILE/SEARCH/REPLACE format, copying the SEARCH lines exactly as they appear in the current file (including indentation).',
    );
    return parts.join('\n');
  };

  return Object.freeze({ FORMAT_INSTRUCTIONS, parse, hasBlocks, pendingPath, applyHunks, formatFeedback });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasEditBlocks };
