"use strict";

/**
 * @fileoverview Vista previa inline de cambios propuestos (estilo Gemini)
 * dentro del editor Monaco de Apps Script. Script clásico en MAIN world.
 *
 * Muestra el texto propuesto en un modelo temporal (`gas-preview:`) de solo
 * lectura: líneas añadidas en verde, líneas eliminadas como view zones rojas
 * tachadas, y una barra flotante con navegación, Aceptar y Rechazar.
 *
 * Emite `GAS_EDITOR_EVENT` (detail JSON) con
 * `previewAccept` | `previewReject` | `previewNavigate` | `previewClosed`.
 *
 * Depende (opcionalmente) de `GasLineDiff` (`extension/js/shared/line-diff.js`);
 * sin él cae a un diff de prefijo/sufijo común.
 */
class GasDiffPreview {
  static SCHEME = 'gas-preview';
  static STYLE_ID = 'qc__dp-styles';
  // Ancho del editor (px) por debajo del cual la barra se compacta.
  static COMPACT_WIDTH = 520;
  static BAR_HEIGHT = 44;

  constructor() {
    /** Sesión activa (null si no hay vista previa). */
    this._session = null;
    /** `true` mientras cambiamos el modelo nosotros (ignora onDidChangeModel). */
    this._switching = false;
  }

  // ── API pública ────────────────────────────────────────────────────────

  /**
   * Abre la vista previa.
   * @param {{files:Array<{name:string, kind:'edit'|'create', original:string, proposed:string}>,
   *          index?:number, editor:object, getModelByName?:Function, applyFile?:Function}} opts
   *   `applyFile(name, proposed)` aplica el cambio al archivo real y devuelve `{ok, error?}`.
   */
  open(opts = {}) {
    const editor = opts.editor || window.jsWireMonacoEditor;
    const files = Array.isArray(opts.files) ? opts.files.filter(Boolean) : [];
    if (!editor || !window.monaco?.editor || !files.length) {
      throw new Error(!files.length ? 'no-files' : 'no-editor');
    }

    // Reabrir sobre una sesión previa: conservamos el modelo del usuario.
    let restore = null;
    if (this._session && this._session.editor === editor) {
      restore = { model: this._session.restoreModel, viewState: this._session.restoreViewState };
      this._clearView_();
      this._unbindEditor_();
    } else if (this._session) {
      this.close();
    }
    const userModel = editor.getModel?.();
    if (!restore && userModel?.uri?.scheme === GasDiffPreview.SCHEME) {
      throw new Error('preview-active');
    }

    this._session = {
      editor,
      files: files.map((f) => ({
        name:     String(f.name || ''),
        kind:     f.kind === 'create' ? 'create' : 'edit',
        original: String(f.original ?? ''),
        proposed: String(f.proposed ?? ''),
        status:   'pending',
      })),
      index:            0,
      getModelByName:   typeof opts.getModelByName === 'function' ? opts.getModelByName : null,
      applyFile:        typeof opts.applyFile === 'function' ? opts.applyFile : null,
      restoreModel:     restore ? restore.model : userModel,
      restoreViewState: restore ? restore.viewState : (editor.saveViewState?.() || null),
      prevPadding:      this._readPadding_(editor),
      previewModel:     null,
      decorationIds:    [],
      zoneIds:          [],
      bar:              null,
      modelSub:         null,
    };

    GasDiffPreview._injectStyles_();
    this._bindEditor_();
    this._show_(this._clampIndex_(opts.index));
  }

  /** Muestra el archivo `index` de la sesión. */
  navigate(index) {
    if (!this._session) return;
    const i = this._clampIndex_(index);
    this._show_(i);
    this._emit_('previewNavigate', i);
  }

  /** Cierra la vista previa y restaura el modelo, el view state y la edición. */
  close() {
    const s = this._session;
    if (!s) return;
    const index = s.index;
    const name = s.files[index]?.name || '';
    this._clearView_({ restore: true });
    this._unbindEditor_();
    s.barResize?.disconnect();
    s.bar?.remove();
    s.bar = null;
    this._writePadding_(s.editor, s.prevPadding);
    this._session = null;
    this._emit_('previewClosed', index, name);
  }

  /** `true` si hay una vista previa abierta. */
  isActive() {
    return !!this._session;
  }

  /** Modelo real del usuario que se restaurará al cerrar (o null). */
  userModel() {
    const m = this._session?.restoreModel;
    return m && !m.isDisposed?.() ? m : null;
  }

  /** Estado actual (sin textos) o null. */
  current() {
    const s = this._session;
    if (!s) return null;
    return {
      index: s.index,
      total: s.files.length,
      name:  s.files[s.index]?.name || '',
      files: s.files.map(({ name, kind, status }) => ({ name, kind, status })),
    };
  }

  // ── Diff ───────────────────────────────────────────────────────────────

  /**
   * Diff por líneas: usa `GasLineDiff` si está cargado; si no, un diff de
   * prefijo/sufijo común (un único bloque reemplazado).
   * @returns {Array<{type:'equal'|'add'|'del', text:string, aLine?:number, bLine?:number}>}
   */
  static diffLines(a, b) {
    try {
      if (typeof GasLineDiff !== 'undefined' && GasLineDiff?.diffLines) {
        return GasLineDiff.diffLines(a, b);
      }
    } catch (_) { /* cae al fallback */ }
    return GasDiffPreview._fallbackDiff_(a, b);
  }

  /** Diff mínimo de prefijo/sufijo común. @private */
  static _fallbackDiff_(a, b) {
    const split = (t) => {
      const s = String(t ?? '');
      return s === '' ? [] : s.replace(/\r\n?/g, '\n').split('\n');
    };
    const A = split(a);
    const B = split(b);
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre &&
           A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ type: 'equal', text: A[i], aLine: i + 1, bLine: i + 1 });
    for (let i = pre; i < A.length - suf; i++) ops.push({ type: 'del', text: A[i], aLine: i + 1 });
    for (let j = pre; j < B.length - suf; j++) ops.push({ type: 'add', text: B[j], bLine: j + 1 });
    for (let k = suf; k > 0; k--) {
      ops.push({ type: 'equal', text: A[A.length - k], aLine: A.length - k + 1, bLine: B.length - k + 1 });
    }
    return ops;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  /** Pinta el archivo `index` (modelo temporal + decoraciones + barra). @private */
  _show_(index) {
    const s = this._session;
    if (!s) return;
    const file = s.files[index];
    if (!file) return;
    s.index = index;
    this._clearView_();

    const editor = s.editor;
    const monaco = window.monaco;
    const uri = monaco.Uri.parse(`${GasDiffPreview.SCHEME}:/${encodeURIComponent(file.name || 'untitled')}?${Date.now()}`);
    s.previewModel = monaco.editor.createModel(file.proposed, this._languageFor_(file), uri);

    this._switching = true;
    try {
      editor.setModel(s.previewModel);
    } finally {
      this._switching = false;
    }
    if (s.orphanModel && s.orphanModel !== s.previewModel) {
      try { s.orphanModel.dispose(); } catch (_) { /* ya liberado */ }
      s.orphanModel = null;
    }
    editor.updateOptions({ readOnly: true });
    this._writePadding_(editor, { ...(s.prevPadding || {}), top: GasDiffPreview.BAR_HEIGHT + 8 });

    // Ops cacheadas por archivo durante la sesión (navigate no recalcula el diff).
    if (!file.ops) file.ops = GasDiffPreview.diffLines(file.original, file.proposed);
    const firstChange = this._decorate_(file.ops);
    this._renderBar_();

    if (firstChange) {
      editor.revealLineInCenter?.(firstChange);
      editor.setPosition?.({ lineNumber: firstChange, column: 1 });
    } else {
      editor.setScrollTop?.(0);
    }
  }

  /**
   * Aplica decoraciones de líneas añadidas y view zones de eliminadas.
   * @returns {number} Primera línea (del modelo propuesto) con cambios, o 0.
   * @private
   */
  _decorate_(ops) {
    const s = this._session;
    const monaco = window.monaco;
    const decorations = [];
    const deletedBlocks = []; // { after, lines[] }
    let bLine = 0;
    let firstChange = 0;
    let pendingDel = null;

    for (const op of ops || []) {
      if (op.type === 'del') {
        if (!pendingDel) {
          pendingDel = { after: bLine, lines: [] };
          deletedBlocks.push(pendingDel);
        }
        pendingDel.lines.push(String(op.text ?? ''));
        if (!firstChange) firstChange = Math.max(1, bLine);
        continue;
      }
      pendingDel = null;
      bLine++;
      if (op.type === 'add') {
        if (!firstChange) firstChange = bLine;
        decorations.push({
          range: new monaco.Range(bLine, 1, bLine, 1),
          options: {
            isWholeLine:               true,
            className:                 'qc__dp-added-line',
            linesDecorationsClassName: 'qc__dp-added-gutter',
            overviewRuler:             { color: 'rgba(46,160,67,0.8)', position: monaco.editor.OverviewRulerLane?.Left ?? 1 },
          },
        });
      }
    }

    s.decorationIds = s.editor.deltaDecorations([], decorations);

    const fontInfo = this._fontInfo_();
    let decorationsLeft = 0;
    try { decorationsLeft = s.editor.getLayoutInfo?.()?.decorationsLeft || 0; } catch (_) { /* layout no disponible */ }
    s.editor.changeViewZones((accessor) => {
      for (const block of deletedBlocks) {
        const dom = document.createElement('div');
        dom.className = 'qc__dp-deleted';
        dom.style.fontFamily = fontInfo.fontFamily;
        dom.style.fontSize = `${fontInfo.fontSize}px`;
        dom.style.lineHeight = `${fontInfo.lineHeight}px`;
        for (const text of block.lines) {
          const line = document.createElement('div');
          line.className = 'qc__dp-deleted-line';
          // textContent: el texto eliminado nunca se interpreta como HTML.
          line.textContent = text === '' ? ' ' : text;
          dom.appendChild(line);
        }
        // Monaco fija el tamaño del marginDomNode: la barra roja va en un hijo
        // alineado con la columna de decoraciones (igual que la verde).
        const margin = document.createElement('div');
        margin.className = 'qc__dp-deleted-margin';
        const gutterBar = document.createElement('div');
        gutterBar.className = 'qc__dp-deleted-gutter';
        gutterBar.style.left = `${decorationsLeft + 3}px`;
        margin.appendChild(gutterBar);
        s.zoneIds.push(accessor.addZone({
          afterLineNumber: block.after,
          heightInLines:   block.lines.length,
          domNode:         dom,
          marginDomNode:   margin,
          suppressMouseDown: true,
        }));
      }
    });
    return firstChange;
  }

  /** Crea o actualiza la barra flotante. @private */
  _renderBar_() {
    const s = this._session;
    const host = s.editor.getDomNode?.();
    if (!host) return;
    if (!s.bar || !host.contains(s.bar)) {
      s.barResize?.disconnect();
      s.bar?.remove();
      s.bar = this._buildBar_();
      host.appendChild(s.bar);
      s.barResize = this._watchBarWidth_(host, s.bar);
    }
    const file = s.files[s.index];
    const total = s.files.length;
    const bar = s.bar;
    bar.querySelector('.qc__dp-name').textContent = file.name;
    bar.querySelector('.qc__dp-name').title = file.name;
    const badge = bar.querySelector('.qc__dp-badge');
    badge.hidden = file.kind !== 'create';
    const count = bar.querySelector('.qc__dp-count');
    count.textContent = DomUtils.t('edDpSuggestionOf', 'Suggestion $1 of $2', s.index + 1, total);
    count.dataset.short = `${s.index + 1}/${total}`;
    bar.querySelector('[data-dp="prev"]').disabled = s.index <= 0;
    bar.querySelector('[data-dp="next"]').disabled = s.index >= total - 1;
    const done = file.status !== 'pending';
    bar.querySelector('[data-dp="accept"]').disabled = done;
    bar.querySelector('[data-dp="reject"]').disabled = done;
    const status = bar.querySelector('.qc__dp-status');
    status.hidden = !done;
    status.textContent = file.status === 'accepted'
      ? DomUtils.t('edDpAccepted', 'Accepted')
      : DomUtils.t('edDpRejected', 'Rejected');
  }

  /** Compacta la barra cuando el editor es estrecho. @private */
  _watchBarWidth_(host, bar) {
    const apply = (w) => bar.classList.toggle('qc__dp-bar--compact', w < GasDiffPreview.COMPACT_WIDTH);
    apply(host.clientWidth);
    if (typeof ResizeObserver === 'undefined') return null;
    const ro = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? host.clientWidth));
    ro.observe(host);
    return ro;
  }

  /** Construye el DOM de la barra (sin innerHTML). @private */
  _buildBar_() {
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const button = (action, cls, label, title, iconPath) => {
      const b = el('button', `qc__dp-btn ${cls}`);
      b.type = 'button';
      b.dataset.dp = action;
      if (title) { b.title = title; b.setAttribute('aria-label', title); }
      if (iconPath) b.appendChild(GasDiffPreview._icon_(iconPath));
      if (label) b.appendChild(el('span', '', label));
      return b;
    };

    const bar = el('div', 'qc__dp-bar');
    bar.setAttribute('role', 'toolbar');

    const info = el('div', 'qc__dp-info');
    const eye = GasDiffPreview._icon_('M12 5C6.5 5 2.7 9.1 1.5 12c1.2 2.9 5 7 10.5 7s9.3-4.1 10.5-7C21.3 9.1 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z');
    eye.classList.add('qc__dp-eye');
    info.appendChild(eye);
    info.appendChild(el('span', 'qc__dp-label', DomUtils.t('edDpPreviewing', 'Previewing')));
    info.appendChild(el('span', 'qc__dp-name'));
    const badge = el('span', 'qc__dp-badge', DomUtils.t('edDpNewFile', 'New file'));
    badge.title = badge.textContent;
    info.appendChild(badge);
    bar.appendChild(info);

    const nav = el('div', 'qc__dp-nav');
    nav.appendChild(button('prev', 'qc__dp-icon', '', DomUtils.t('edDpPrevious', 'Previous suggestion'), 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z'));
    nav.appendChild(el('span', 'qc__dp-count'));
    nav.appendChild(button('next', 'qc__dp-icon', '', DomUtils.t('edDpNext', 'Next suggestion'), 'M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z'));
    bar.appendChild(nav);

    const actions = el('div', 'qc__dp-actions');
    actions.appendChild(el('span', 'qc__dp-status'));
    // Iconos solo visibles en modo compacto (sin texto).
    const reject = DomUtils.t('edDpReject', 'Reject');
    const accept = DomUtils.t('edDpAccept', 'Accept');
    actions.appendChild(button('reject', 'qc__dp-secondary', reject, reject, 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A7.9 7.9 0 0 1 4 12zm8 8a7.9 7.9 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z'));
    actions.appendChild(button('accept', 'qc__dp-primary', accept, accept, 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'));
    actions.appendChild(button('close', 'qc__dp-icon', '', DomUtils.t('edDpClose', 'Close preview'), 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z'));
    bar.appendChild(actions);

    // Evita que Monaco robe el foco/selección al pulsar la barra.
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest?.('[data-dp]');
      if (!btn || btn.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      this._onAction_(btn.dataset.dp);
    });
    return bar;
  }

  /** SVG de un único path (24x24). @private */
  static _icon_(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  // ── Acciones ───────────────────────────────────────────────────────────

  /** Despacha los botones de la barra. @private */
  _onAction_(action) {
    const s = this._session;
    if (!s) return;
    switch (action) {
      case 'prev':   this.navigate(s.index - 1); break;
      case 'next':   this.navigate(s.index + 1); break;
      case 'close':  this.close(); break;
      case 'accept': this._accept_(); break;
      case 'reject': this._reject_(); break;
      default: break;
    }
  }

  /** Aplica el archivo actual y avanza al siguiente pendiente. @private */
  async _accept_() {
    const s = this._session;
    const index = s.index;
    const file = s.files[index];
    if (!file || file.status !== 'pending') return;

    // Volvemos al modelo del usuario antes de editar el archivo real.
    this._clearView_({ restore: true });
    let result = { ok: false, error: 'no-apply-handler' };
    // `applying`: el cambio de modelo que hace applyFile no debe cerrar la sesión.
    s.applying = true;
    try {
      if (s.applyFile) result = (await s.applyFile(file.name, file.proposed, file)) || { ok: true };
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    } finally {
      s.applying = false;
    }
    if (this._session !== s) return;
    if (result.ok) file.status = 'accepted';
    this._emit_('previewAccept', index, file.name, {
      kind: file.kind,
      ok: !!result.ok,
      ...(result.ok ? {} : { error: result.error || 'apply-failed' }),
    });
    this._advance_(result.ok ? index : -1, index);
  }

  /** Marca el archivo actual como rechazado y avanza. @private */
  _reject_() {
    const s = this._session;
    const index = s.index;
    const file = s.files[index];
    if (!file || file.status !== 'pending') return;
    file.status = 'rejected';
    this._emit_('previewReject', index, file.name, { kind: file.kind });
    this._advance_(index, index);
  }

  /**
   * Pasa al siguiente archivo pendiente (circular) o cierra si no quedan.
   * @param {number} doneIndex  Índice resuelto (-1 si falló: se reintenta mostrarlo).
   * @param {number} fromIndex
   * @private
   */
  _advance_(doneIndex, fromIndex) {
    const s = this._session;
    if (!s) return;
    if (doneIndex < 0) { this._show_(fromIndex); return; }
    const n = s.files.length;
    for (let k = 1; k <= n; k++) {
      const i = (fromIndex + k) % n;
      if (s.files[i].status === 'pending') { this._show_(i); return; }
    }
    this.close();
  }

  // ── Limpieza ───────────────────────────────────────────────────────────

  /**
   * Quita decoraciones, view zones y el modelo temporal.
   * @param {{restore?:boolean}} [opts] Con `restore` vuelve al modelo del usuario.
   * @private
   */
  _clearView_(opts = {}) {
    const s = this._session;
    if (!s) return;
    const editor = s.editor;
    try {
      if (s.zoneIds.length) {
        editor.changeViewZones((accessor) => s.zoneIds.forEach((id) => accessor.removeZone(id)));
      }
    } catch (_) { /* editor destruido */ }
    s.zoneIds = [];
    try { s.decorationIds = editor.deltaDecorations(s.decorationIds, []); } catch (_) { /* idem */ }
    s.decorationIds = [];

    if (opts.restore) {
      this._switching = true;
      try {
        const target = s.restoreModel && !s.restoreModel.isDisposed?.() ? s.restoreModel : null;
        if (target && editor.getModel?.() !== target) editor.setModel(target);
        if (target && s.restoreViewState) editor.restoreViewState?.(s.restoreViewState);
      } catch (_) { /* editor destruido */ }
      finally { this._switching = false; }
      try { editor.updateOptions({ readOnly: false }); } catch (_) { /* idem */ }
    }

    const preview = s.previewModel;
    s.previewModel = null;
    // Solo se libera si ya no está montado (si no, Monaco queda sin modelo).
    if (preview && !preview.isDisposed?.() && editor.getModel?.() !== preview) {
      try { preview.dispose(); } catch (_) { /* ya liberado */ }
    } else if (preview) {
      s.orphanModel = preview;
    }
    if (s.orphanModel && editor.getModel?.() !== s.orphanModel) {
      try { s.orphanModel.dispose(); } catch (_) { /* ya liberado */ }
      s.orphanModel = null;
    }
  }

  /** Cierra la vista previa si GAS cambia de archivo por su cuenta. @private */
  _bindEditor_() {
    const s = this._session;
    s.modelSub = s.editor.onDidChangeModel?.(() => {
      if (this._switching || s.applying || this._session !== s) return;
      const current = s.editor.getModel?.();
      if (current && current === s.previewModel) return;
      // El usuario abrió otro archivo: cerramos sin forzar el modelo anterior.
      s.restoreModel = current || s.restoreModel;
      s.restoreViewState = null;
      this.close();
    }) || null;
  }

  /** @private */
  _unbindEditor_() {
    const s = this._session;
    try { s?.modelSub?.dispose?.(); } catch (_) { /* ignore */ }
    if (s) s.modelSub = null;
  }

  // ── Utilidades ─────────────────────────────────────────────────────────

  /** @private */
  _clampIndex_(index) {
    const n = this._session?.files.length || 0;
    const i = Number.isInteger(Number(index)) ? Number(index) : 0;
    return Math.min(Math.max(0, i), Math.max(0, n - 1));
  }

  /** Lenguaje del archivo original (o deducido de la extensión). @private */
  _languageFor_(file) {
    const s = this._session;
    try {
      const model = file.kind === 'edit' && s.getModelByName ? s.getModelByName(file.name) : null;
      const lang = model?.getLanguageId?.();
      if (lang) return lang;
    } catch (_) { /* deducimos por nombre */ }
    const name = String(file.name || '').toLowerCase();
    if (name.endsWith('.html')) return 'html';
    if (name.endsWith('.json')) return 'json';
    return 'javascript';
  }

  /** Fuente del editor para que las líneas eliminadas se alineen. @private */
  _fontInfo_() {
    const fallback = { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 };
    try {
      const opt = window.monaco.editor.EditorOption?.fontInfo;
      const info = opt != null ? this._session.editor.getOption(opt) : null;
      return info ? { fontFamily: info.fontFamily || 'monospace', fontSize: info.fontSize, lineHeight: info.lineHeight } : fallback;
    } catch (_) { return fallback; }
  }

  /** @private */
  _readPadding_(editor) {
    try {
      const opt = window.monaco.editor.EditorOption?.padding;
      const p = opt != null ? editor.getOption(opt) : null;
      return p ? { top: p.top || 0, bottom: p.bottom || 0 } : { top: 0, bottom: 0 };
    } catch (_) { return { top: 0, bottom: 0 }; }
  }

  /** @private */
  _writePadding_(editor, padding) {
    try { editor.updateOptions({ padding: padding || { top: 0, bottom: 0 } }); } catch (_) { /* ignore */ }
  }

  /** Emite `GAS_EDITOR_EVENT` hacia el content script. @private */
  _emit_(type, index, name, extra = {}) {
    const s = this._session;
    document.dispatchEvent(new CustomEvent('GAS_EDITOR_EVENT', {
      detail: JSON.stringify({
        type,
        name: name ?? s?.files[index]?.name ?? '',
        index,
        ...extra,
      }),
    }));
  }

  /** Inyecta los estilos una sola vez. @private */
  static _injectStyles_() {
    if (document.getElementById(GasDiffPreview.STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GasDiffPreview.STYLE_ID;
    style.textContent = `
      /* Decoraciones: colores de diff del tema activo de Monaco con fallback. */
      .qc__dp-added-line { background: var(--vscode-diffEditor-insertedLineBackground, rgba(46, 160, 67, 0.18)); }
      .qc__dp-added-gutter {
        width: 3px !important;
        margin-left: 3px;
        background: var(--vscode-editorGutter-addedBackground, #2ea043);
      }
      .qc__dp-deleted {
        background: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.14));
        color: var(--vscode-editor-foreground, #b42318);
        white-space: pre;
        overflow: hidden;
        pointer-events: none;
      }
      .qc__dp-deleted-line {
        text-decoration: line-through;
        text-decoration-color: var(--vscode-editorGutter-deletedBackground, rgba(180, 35, 24, 0.6));
        opacity: 0.85;
      }
      .qc__dp-deleted-margin { background: var(--vscode-diffEditorGutter-removedLineBackground, rgba(248, 81, 73, 0.08)); }
      .qc__dp-deleted-gutter {
        position: absolute; top: 0; bottom: 0; width: 3px;
        background: var(--vscode-editorGutter-deletedBackground, #f85149);
      }

      /* Barra flotante: tokens --gt-* (claro/oscuro según body.qc__is-dark-mode). */
      .qc__dp-bar {
        position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
        z-index: 50; box-sizing: border-box;
        display: flex; align-items: center; gap: var(--gt-space-3);
        max-width: calc(100% - 24px); height: ${GasDiffPreview.BAR_HEIGHT - 6}px; padding: 0 6px 0 var(--gt-space-3);
        font: 500 13px/1.2 var(--gt-font-brand);
        color: var(--gt-on-surface); background: var(--gt-surface-bright);
        border: 1px solid var(--gt-outline-variant); border-radius: var(--gt-shape-full);
        box-shadow: var(--gt-elevation-2);
        white-space: nowrap;
      }
      .qc__dp-info { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
      .qc__dp-eye { color: var(--gt-primary); flex: none; }
      .qc__dp-label,
      .qc__dp-count,
      .qc__dp-status { color: var(--gt-on-surface-variant); }
      .qc__dp-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 4ch; max-width: 220px; }
      .qc__dp-badge {
        flex: none; font-size: 11px; padding: 1px 6px; border-radius: var(--gt-shape-s);
        background: var(--gt-success-container); color: var(--gt-on-success-container);
      }
      .qc__dp-badge[hidden] { display: none; }
      .qc__dp-nav, .qc__dp-actions { display: flex; align-items: center; gap: var(--gt-space-1); flex: none; }
      .qc__dp-bar--compact { gap: var(--gt-space-1); }
      .qc__dp-bar--compact .qc__dp-label { display: none; }
      .qc__dp-bar--compact .qc__dp-badge { font-size: 0; padding: 0 5px; }
      .qc__dp-bar--compact .qc__dp-badge::before { content: '+'; font-size: 11px; font-weight: 700; }
      .qc__dp-bar--compact .qc__dp-count { font-size: 0; }
      .qc__dp-bar--compact .qc__dp-count::before { content: attr(data-short); font-size: 12px; }
      .qc__dp-secondary > svg, .qc__dp-primary > svg { display: none; }
      .qc__dp-bar--compact .qc__dp-secondary,
      .qc__dp-bar--compact .qc__dp-primary { width: 28px; padding: 0; }
      .qc__dp-bar--compact .qc__dp-secondary > span,
      .qc__dp-bar--compact .qc__dp-primary > span { display: none; }
      .qc__dp-bar--compact .qc__dp-secondary > svg,
      .qc__dp-bar--compact .qc__dp-primary > svg { display: block; }
      .qc__dp-count { font-size: 12px; padding: 0 2px; }
      .qc__dp-status { font-size: 12px; margin-right: var(--gt-space-1); }
      .qc__dp-status[hidden] { display: none; }
      .qc__dp-btn {
        flex: none; display: inline-flex; align-items: center; justify-content: center; gap: var(--gt-space-1);
        height: 28px; border: 1px solid transparent; border-radius: var(--gt-shape-full);
        font: inherit; cursor: pointer; background: transparent; color: inherit;
      }
      .qc__dp-btn:disabled { opacity: 0.38; cursor: default; }
      .qc__dp-icon { width: 28px; padding: 0; }
      .qc__dp-icon:not(:disabled):hover { background: var(--gt-state-hover); }
      .qc__dp-secondary { padding: 0 var(--gt-space-3); border-color: var(--gt-outline); color: var(--gt-primary); }
      .qc__dp-secondary:not(:disabled):hover { background: color-mix(in srgb, var(--gt-primary) 8%, transparent); }
      .qc__dp-primary { padding: 0 14px; background: var(--gt-primary); color: var(--gt-on-primary); }
      .qc__dp-primary:not(:disabled):hover { background: color-mix(in srgb, var(--gt-primary) 92%, var(--gt-on-primary)); }

      /* Modo oscuro: Monaco va invertido. La barra (--gt-*) se contra-invierte
         y las decoraciones recuperan su tono (añadido verde, eliminado rojo). */
      body.qc__is-dark-mode .qc__dp-bar { filter: invert(1); }
      body.qc__is-dark-mode .qc__dp-added-line,
      body.qc__is-dark-mode .qc__dp-added-gutter,
      body.qc__is-dark-mode .qc__dp-deleted,
      body.qc__is-dark-mode .qc__dp-deleted-margin { filter: hue-rotate(180deg); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
}

window.GasDiffPreview = GasDiffPreview;
// Instancia única (reinyecciones reutilizan la existente si sigue viva).
if (!window.gasDiffPreview || !(window.gasDiffPreview instanceof GasDiffPreview)) {
  window.gasDiffPreview = new GasDiffPreview();
}
