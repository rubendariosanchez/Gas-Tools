/**
 * @fileoverview GasMarkdown - Renderer Markdown seguro + resaltado de sintaxis.
 *
 * Script clásico (MAIN world, sin import/export). Define un único global:
 *   GasMarkdown.render(markdownText) → string HTML
 *   GasMarkdown.highlight(code, lang) → string HTML
 *
 * Parser: markdown-it 14.1.0 (vendorizado en src/vendor/markdown-it, global
 * `markdownit`), configurado sin HTML crudo, con enlaces solo http(s)/mailto
 * y sin <img>. Los bloques de código usan el mismo markup (barra de acciones
 * Copy/Insert/Replace/Apply) que espera gas-chat-panel.js.
 * Si `markdownit` no está cargado se usa el renderer propio (`renderLegacy_`)
 * como FALLBACK. No depende de DomUtils para poder testearse en Node.
 */

const GasMarkdown = (() => {
  // ──────────────────────────────────────────────────────────────────
  // UTILIDADES
  // ──────────────────────────────────────────────────────────────────

  /** Escapa texto para interpolarlo en HTML (mismo contrato que DomUtils.escapeHtml). */
  const escapeHtml_ = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  /** Envuelve texto (escapado) en un `<span>` con la clase indicada. */
  const wrap_ = (cls, text) => `<span class="${cls}">${escapeHtml_(text)}</span>`;

  /**
   * Recorre `src` con `regex` (global), pasa cada match al callback y escapa
   * los segmentos que no matchearon.
   */
  const tokenize_ = (src, regex, cb) => {
    const out = [];
    let lastIndex = 0;
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(src)) !== null) {
      if (match.index > lastIndex) out.push(escapeHtml_(src.slice(lastIndex, match.index)));
      out.push(cb(match[0], match.slice(1)));
      lastIndex = match.index + match[0].length;
      // Evitar bucles infinitos si el regex matchea cadena vacía.
      if (match[0].length === 0) regex.lastIndex++;
    }
    if (lastIndex < src.length) out.push(escapeHtml_(src.slice(lastIndex)));
    return out.join('');
  };

  // ──────────────────────────────────────────────────────────────────
  // HIGHLIGHTERS (trabajan sobre texto CRUDO; cada token se escapa al envolver)
  // ──────────────────────────────────────────────────────────────────

  const JS_KEYWORDS = new Set([
    'const','let','var','function','return','if','else','for','while','do',
    'switch','case','break','continue','default','try','catch','finally',
    'throw','new','delete','typeof','instanceof','in','of','class','extends',
    'super','this','async','await','yield','import','export','from','as',
    'static','get','set','true','false','null','undefined','void',
  ]);
  const JS_BUILTINS = new Set([
    'console','Math','JSON','Object','Array','String','Number','Boolean',
    'Date','RegExp','Map','Set','Promise','Error','Symbol','Logger',
    'SpreadsheetApp','DocumentApp','DriveApp','GmailApp','CalendarApp',
    'PropertiesService','UrlFetchApp','Utilities','HtmlService',
    'ScriptApp','Session','document','window',
  ]);

  const highlightJs_ = (s) => {
    const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(\.\s*[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)/g;
    return tokenize_(s, re, (m, groups) => {
      const [comment, str, num, prop, ident] = groups;
      if (comment) return wrap_('hl-comment', comment);
      if (str)     return wrap_('hl-string',  str);
      if (num)     return wrap_('hl-number',  num);
      if (prop)    return prop[0] + wrap_('hl-prop', prop.slice(1).trim());
      if (ident) {
        if (JS_KEYWORDS.has(ident)) return wrap_('hl-keyword', ident);
        if (JS_BUILTINS.has(ident)) return wrap_('hl-builtin', ident);
        return escapeHtml_(ident);
      }
      return escapeHtml_(m);
    });
  };

  const highlightCss_ = (s) => {
    const UNITS = 'px|em|rem|vh|vw|vmin|vmax|%|ms|s|deg|fr|ch|ex|pt|pc|cm|mm|in';
    const re = new RegExp(
      `(\\/\\*[\\s\\S]*?\\*\\/)` +
      `|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')` +
      `|(@[\\w-]+)` +
      `|(#[0-9a-fA-F]{3,8})\\b` +
      `|(\\d+(?:\\.\\d+)?)(${UNITS})?\\b` +
      `|(^|[\\s;{}])([\\w-]+)(?=\\s*:)`,
      'gm'
    );
    return tokenize_(s, re, (m, groups) => {
      const [comment, str, atRule, hex, num, unit, lead, prop] = groups;
      if (comment) return wrap_('hl-comment', comment);
      if (str)     return wrap_('hl-string',  str);
      if (atRule)  return wrap_('hl-keyword', atRule);
      if (hex)     return wrap_('hl-number',  hex);
      if (num !== undefined && num !== '') {
        const u = unit ? wrap_('hl-unit', unit) : '';
        return `<span class="hl-number">${escapeHtml_(num)}${u}</span>`;
      }
      if (prop)    return escapeHtml_(lead) + wrap_('hl-prop', prop);
      return escapeHtml_(m);
    });
  };

  const highlightHtml_ = (s) => {
    const re = /(<!--[\s\S]*?-->)|(<\/?)([\w-]+)([^<>]*?)(\/?>)/g;
    const attrRe = /([\w-]+)(=)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
    return tokenize_(s, re, (m, groups) => {
      const [comment, open, name, attrs, close] = groups;
      if (comment) return wrap_('hl-comment', comment);
      if (open) {
        // Atributos clave="valor" coloreados; los huecos (espacios, atributos
        // booleanos) se escapan siempre vía tokenize_.
        const attrsHl = tokenize_(String(attrs || ''), attrRe, (_, [k, eq, v]) =>
          wrap_('hl-prop', k) + escapeHtml_(eq) + wrap_('hl-string', v)
        );
        return wrap_('hl-keyword', open + name) + attrsHl + wrap_('hl-keyword', close);
      }
      return escapeHtml_(m);
    });
  };

  const highlightJson_ = (s) => {
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/g;
    return tokenize_(s, re, (m, groups) => {
      const [str, colon, num, lit] = groups;
      if (str) {
        return colon
          ? wrap_('hl-prop', str) + escapeHtml_(colon)
          : wrap_('hl-string', str);
      }
      if (num) return wrap_('hl-number',  num);
      if (lit) return wrap_('hl-keyword', lit);
      return escapeHtml_(m);
    });
  };

  /**
   * Resalta un fragmento de código (JS/TS/GAS, CSS, HTML/XML, JSON).
   * Para otros lenguajes devuelve el texto escapado.
   * @param {string} code
   * @param {string} [lang]
   * @returns {string}
   */
  const highlight = (code, lang) => {
    const src = String(code ?? '');
    const id  = String(lang || '').toLowerCase().trim();
    if (['js', 'javascript', 'ts', 'typescript', 'gas', 'google-apps-script'].includes(id)) return highlightJs_(src);
    if (['css', 'scss', 'less'].includes(id)) return highlightCss_(src);
    if (['html', 'xml', 'svg'].includes(id))  return highlightHtml_(src);
    if (['json', 'jsonc'].includes(id))       return highlightJson_(src);
    return escapeHtml_(src);
  };

  // ──────────────────────────────────────────────────────────────────
  // MARKDOWN — PIEZAS COMUNES Y RENDERER LEGACY (FALLBACK sin markdown-it)
  // ──────────────────────────────────────────────────────────────────

  /** Convierte un bloque de tabla GFM (ya escapado) a `<table>`. */
  const renderTable_ = (block) => {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) return block;
    const splitRow = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const header = splitRow(lines[0]);
    const align  = splitRow(lines[1]).map((c) => {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c))  return 'right';
      if (/^:-+$/.test(c))  return 'left';
      return '';
    });
    const cellAttr = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');
    const th  = header.map((h, i) => `<th${cellAttr(i)}>${h}</th>`).join('');
    const trs = lines.slice(2).map(splitRow).map((r) =>
      '<tr>' + r.map((c, i) => `<td${cellAttr(i)}>${c}</td>`).join('') + '</tr>'
    ).join('');
    return `<table class="gc__table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>\n`;
  };

  /**
   * Texto traducido y escapado para la barra de acciones. Usa `DomUtils.t`
   * si está cargado (MAIN world); en tests sin DomUtils devuelve el inglés.
   */
  const t_ = (key, fallback) => escapeHtml_(
    (typeof DomUtils !== 'undefined' && typeof DomUtils.t === 'function') ? DomUtils.t(key, fallback) : fallback
  );

  /** Botón compacto icono (registro GasUi, si está cargado) + texto de la barra de acciones. */
  const codeBtn_ = (action, tipKey, tipFallback, labelKey, labelFallback) => `
              <button type="button" class="gc__codeBtn" data-action="${action}" title="${t_(tipKey, tipFallback)}">${globalThis.GasUi?.icon(action, 13) ?? ''}<span class="gc__codeBtnLabel">${t_(labelKey, labelFallback)}</span></button>`;

  /** HTML de un bloque de código con barra de acciones (Copy/Insert/Replace/Apply). */
  const renderCodeBlock_ = (lang, code) => {
    const trimmed = code.replace(/\n+$/, '');
    return `
        <div class="gc__codeWrap">
          <div class="gc__codeBar">
            <span class="gc__codeLang">${escapeHtml_(lang || 'code')}</span>
            <div class="gc__codeBarBtns">${codeBtn_('copy', 'edMdCopyTip', 'Copy to clipboard', 'edMdCopy', 'Copy')}${codeBtn_('insert', 'edMdInsertTip', 'Insert at editor cursor', 'edMdInsert', 'Insert')}${codeBtn_('replace', 'edMdReplaceTip', 'Replace editor selection', 'edMdReplace', 'Replace')}${codeBtn_('apply', 'edMdApplyTip', 'Apply to the active file: review the diff in the editor', 'edMdApply', 'Apply')}
            </div>
          </div>
          <pre class="gc__codeBlock"><code>${highlight(trimmed, lang)}</code></pre>
        </div>`;
  };

  /**
   * FALLBACK: renderer propio basado en regex (subset GFM). Solo se usa si
   * el global `markdownit` no está disponible. Tiene limitaciones conocidas
   * (listas sueltas/anidadas), por eso no es el camino principal.
   * @param {string} markdownText
   * @returns {string}
   */
  const renderLegacy_ = (markdownText) => {
    // Los placeholders usan \u0000: se elimina del input para que no se puedan falsificar.
    const text = String(markdownText ?? '').replace(/\u0000/g, '');

    // 1. Aislar bloques de código (```lang ... ```). Un bloque sin cerrar
    //    (típico durante streaming) también se aísla hasta el final.
    const codeBlocks = [];
    let work = text.replace(/```([\w+#.-]*)[^\S\r\n]*\r?\n?([\s\S]*?)(?:```|$(?![\s\S]))/g, (_, lang, code) => {
      codeBlocks.push({ lang: (lang || '').trim(), code });
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

    // 2. Aislar inline code para que su contenido no se procese.
    const inlines = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlines.push(code);
      return `\u0000INL${inlines.length - 1}\u0000`;
    });

    // 3. Escapar HTML de todo lo demás.
    work = escapeHtml_(work);

    // 3b. Aislar enlaces (ya escapados) en placeholders antes de negrita/cursiva,
    //     para que `_` o `*` dentro de las URLs no se conviertan en <em>/<strong>.
    //     Solo http(s): `javascript:` y similares quedan como texto plano.
    const links = [];
    const pushLink_ = (html) => {
      links.push(html);
      return `\u0000LNK${links.length - 1}\u0000`;
    };
    work = work.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label, url) => pushLink_(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    );
    work = work.replace(
      /(^|[\s(])(https?:\/\/[^\s<)\u0000]+)/g,
      (_, lead, url) => lead + pushLink_(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    );

    // 4. Reglas horizontales.
    work = work.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr>');

    // 5. Encabezados.
    work = work.replace(/^(#{1,6}) (.*)$/gm, (_, hashes, body) => {
      const n = hashes.length;
      return `<h${n}>${body}</h${n}>`;
    });

    // 6. Tablas GFM: línea header + separadora |---|---|.
    work = work.replace(/(^\|[^\n]+\|\r?\n\|[\s|:-]+\|(?:\r?\n\|[^\n]+\|)+)/gm, renderTable_);

    // 7. Citas: líneas consecutivas que empiezan con ">" (ya escapado).
    work = work.replace(/(?:^&gt; ?.*(?:\r?\n|$))+/gm, (block) => {
      const inner = block.replace(/^&gt; ?/gm, '').replace(/\s+$/, '');
      return `<blockquote>${inner}</blockquote>\n`;
    });

    // 8. Listas ordenadas.
    work = work.replace(/(?:^\d+\. .+(?:\r?\n|$))+/gm, (block) => {
      const items = block.trim().split(/\r?\n/).map((l) => l.replace(/^\d+\.\s+/, ''));
      return '<ol>' + items.map((i) => `<li>${i}</li>`).join('') + '</ol>\n';
    });

    // 9. Listas no ordenadas.
    work = work.replace(/(?:^[-*] .+(?:\r?\n|$))+/gm, (block) => {
      const items = block.trim().split(/\r?\n/).map((l) => l.replace(/^[-*]\s+/, ''));
      return '<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>\n';
    });

    // 10. Negrita, cursiva, tachado.
    work = work
      .replace(/\*\*([^*\n]+)\*\*/g,     '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g,         '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g,         '<del>$1</del>');

    // 11. Párrafos: separar por dobles saltos, omitir bloques estructurales.
    work = work.split(/\n{2,}/).map((para) => {
      const t = para.trim();
      if (!t) return '';
      if (/^(<(h[1-6]|ul|ol|pre|blockquote|table|hr|div)|\u0000CODE\d+\u0000$)/.test(t)) return t;
      return `<p>${t.replace(/\r?\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('\n');

    // 12. Reinyectar enlaces (antes del inline code, que puede ir en su texto).
    work = work.replace(/\u0000LNK(\d+)\u0000/g, (_, idx) => links[Number(idx)]);

    // 13. Reinyectar inline code.
    work = work.replace(/\u0000INL(\d+)\u0000/g,
      (_, idx) => `<code class="gc__inlineCode">${escapeHtml_(inlines[Number(idx)])}</code>`);

    // 14. Reinyectar bloques de código con barra de acciones y highlight.
    work = work.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
      const { lang, code } = codeBlocks[Number(idx)];
      return renderCodeBlock_(lang, code);
    });

    return work;
  };

  // ──────────────────────────────────────────────────────────────────
  // MARKDOWN — markdown-it (camino principal)
  // ──────────────────────────────────────────────────────────────────

  /** Solo se permiten enlaces http(s) y mailto (salida del LLM no confiable). */
  const SAFE_LINK_RE_ = /^\s*(?:https?:|mailto:)/i;

  /** Prefijo de tarea GFM al inicio de un ítem: `[ ] ` / `[x] `. */
  const TASK_RE_ = /^\[([ xX])\](?:[ \t]+|$)/;

  /**
   * Regla core: convierte `- [ ] texto` / `- [x] texto` en un checkbox
   * deshabilitado (token `gc_task`) y marca el <li> con `gc__taskItem`.
   * Corre al final (tras `text_join`) para ver el texto ya unido.
   */
  const taskListRule_ = (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const first = tok.children && tok.children[0];
      if (!first || first.type !== 'text') continue;
      const m = TASK_RE_.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('gc_task', 'input', 0);
      box.meta = { checked: m[1] !== ' ' };
      tok.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'gc__taskItem');
    }
  };

  /** Crea y configura la instancia de markdown-it (una sola vez). */
  const createMd_ = () => {
    const md = globalThis.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
    // Sin enlaces "fuzzy" (dominios sin protocolo): evita que `Code.gs` o
    // `utils.js` se conviertan en enlaces.
    md.linkify.set({ fuzzyLink: false });
    md.validateLink = (url) => SAFE_LINK_RE_.test(String(url || ''));

    const rules = md.renderer.rules;

    rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return self.renderToken(tokens, idx, options);
    };

    // Imágenes: nunca <img> (no cargar recursos remotos); se muestran como enlace.
    rules.image = (tokens, idx, options, env, self) => {
      const tok = tokens[idx];
      const src = tok.attrGet('src') || '';
      const alt = self.renderInlineAsText(tok.children || [], options, env) || src;
      return `<a href="${escapeHtml_(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml_(alt)}</a>`;
    };

    rules.code_inline = (tokens, idx) =>
      `<code class="gc__inlineCode">${escapeHtml_(tokens[idx].content)}</code>`;

    // Bloques de código: mismo markup que el renderer legacy (barra de acciones).
    rules.fence = (tokens, idx) => {
      const tok = tokens[idx];
      const lang = String(tok.info || '').trim().split(/\s+/)[0] || '';
      return renderCodeBlock_(lang, tok.content);
    };
    rules.code_block = (tokens, idx) => renderCodeBlock_('', tokens[idx].content);

    // Tablas envueltas en un contenedor con scroll horizontal.
    rules.table_open = () => '<div class="gc__tableWrap"><table class="gc__table">\n';
    rules.table_close = () => '</table></div>\n';

    // Tachado como <del> (mismo elemento que el legacy; la CSS del chat lo estiliza).
    rules.s_open = () => '<del>';
    rules.s_close = () => '</del>';

    rules.gc_task = (tokens, idx) =>
      `<input type="checkbox" class="gc__taskBox" disabled${tokens[idx].meta && tokens[idx].meta.checked ? ' checked' : ''}> `;

    md.core.ruler.push('gc_task_list', taskListRule_);
    return md;
  };

  let md_ = null;

  /** Instancia única de markdown-it, o `null` si el global no está cargado. */
  const getMd_ = () => {
    if (md_) return md_;
    if (typeof globalThis.markdownit !== 'function') return null;
    try {
      md_ = createMd_();
    } catch (err) {
      console.warn('[GasMarkdown] markdown-it init failed, using legacy renderer:', err);
      md_ = null;
    }
    return md_;
  };

  /**
   * Convierte Markdown (GFM) a HTML seguro. Usa markdown-it si está cargado;
   * si no, el renderer legacy.
   * @param {string} markdownText
   * @returns {string}
   */
  const render = (markdownText) => {
    const md = getMd_();
    if (!md) return renderLegacy_(markdownText);
    return md.render(String(markdownText ?? ''));
  };

  return Object.freeze({ render, highlight });
})();
