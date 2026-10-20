"use strict";

/**
 * @fileoverview Visor amplio del diff de GitHub (`window.gasDiffViewer`).
 *
 * Superposición a pantalla completa en el light DOM (`document.body`): la chrome va en un
 * Shadow DOM con tokens `--gt-*` y el contenedor del DiffEditor de Monaco es un hijo
 * *slotted* del host (light DOM), para que le apliquen los estilos de Monaco del `<head>`.
 * Modelos temporales con esquema `gas-ghdiff:` (el resto de servicios los ignoran) que se
 * liberan al cambiar de archivo y al cerrar. Sin `monaco.editor.createDiffEditor`, usa un
 * render propio en dos columnas. Izquierda = GitHub (o la base), derecha = GAS.
 * Los `.gs/.js` se abren como `plaintext`: un modelo `javascript` entraría en el mismo
 * ámbito del worker de TypeScript que los archivos del proyecto (globales duplicados).
 *
 * Script clásico (MAIN world); depende de `DomUtils`, `GasUi` y `GasLineDiff`.
 */
class GasDiffViewer {
  static SCHEME = 'gas-ghdiff';

  /** Ancho del panel por debajo del cual Monaco (y el visor) pasan a "en línea". */
  static INLINE_BREAKPOINT = 700;

  /** Widgets de Monaco abiertos: Escape es suyo. */
  static MONACO_WIDGETS = '.suggest-widget.visible, .find-widget.visible, .rename-box, .parameter-hints-widget.visible, .monaco-hover:not(.hidden)';

  /** Capas de Monaco fuera del contenedor donde el foco es legítimo. */
  static MONACO_LAYERS = '.monaco-editor, .context-view, .monaco-menu-container, .monaco-aria-container';

  static CSS = `
    :host {
      position: fixed;
      inset: 0;
      z-index: var(--gt-z-modal);
      display: block;
      background: var(--gt-scrim);
      color: var(--gt-on-surface);
      font: var(--gt-type-body-m);
    }
    .dv {
      position: absolute;
      inset: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--gt-outline-variant);
      border-radius: var(--gt-shape-l);
      background: var(--gt-surface-bright);
      box-shadow: var(--gt-elevation-3);
    }
    .dv__head {
      display: flex;
      align-items: center;
      gap: var(--gt-space-2);
      min-height: 48px;
      padding: 0 var(--gt-space-2) 0 var(--gt-space-4);
      border-bottom: 1px solid var(--gt-outline-variant);
    }
    .dv__title { margin: 0; font: var(--gt-type-title-s); white-space: nowrap; }
    .dv__path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: var(--gt-on-surface-variant);
      font: 500 12px/1.4 var(--gt-font-mono);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dv__body { display: flex; flex: 1; min-height: 0; }
    .dv__list {
      flex: 0 0 240px;
      overflow: auto;
      border-right: 1px solid var(--gt-outline-variant);
      background: var(--gt-surface-container);
    }
    .dv__list ul { margin: 0; padding: var(--gt-space-1); list-style: none; }
    .dv__file {
      display: flex;
      flex-direction: column;
      gap: 3px;
      width: 100%;
      padding: 6px var(--gt-space-2);
      border: none;
      border-radius: var(--gt-shape-s);
      background: transparent;
      color: var(--gt-on-surface);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .dv__file:hover { background: var(--gt-state-hover); }
    .dv__file[aria-current="true"] { background: var(--gt-secondary-container); color: var(--gt-on-secondary-container); }
    .dv__fileName { overflow: hidden; font: 500 11.5px/1.4 var(--gt-font-mono); text-overflow: ellipsis; white-space: nowrap; }
    .dv__fileMeta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .dv__res { color: var(--gt-on-surface-variant); font-size: 11px; }
    .dv__chip { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; }
    .dv__chip--ok { color: var(--gt-success); }
    .dv__chip--todo { color: var(--gt-error); font-weight: 600; }
    .dv__pane { display: flex; flex: 1; flex-direction: column; min-width: 0; container-type: inline-size; }
    .dv__bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--gt-space-2);
      padding: var(--gt-space-2);
      border-bottom: 1px solid var(--gt-outline-variant);
    }
    .dv__group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gt-space-1); }
    .dv__count { min-width: 9ch; color: var(--gt-on-surface-variant); font-size: 12px; text-align: center; }
    .dv__state { color: var(--gt-on-surface-variant); font-size: 12px; }
    .dv__labels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--gt-outline-variant);
      background: var(--gt-surface-container);
      color: var(--gt-on-surface);
      font: 600 11.5px/1.4 var(--gt-font-plain);
    }
    .dv__labels.dv__labels--inline { grid-template-columns: 1fr; }
    .dv__labels span { padding: 4px var(--gt-space-3); }
    .dv__labels span + span { border-left: 1px solid var(--gt-outline-variant); }
    /* Monaco pasa a "en línea" por debajo de 700 px: etiquetas y conmutador lo acompañan. */
    @container (max-width: 700px) {
      .dv__pane .dv__labels { grid-template-columns: 1fr; }
      .dv__pane .dv__labels #dvRight { display: none; }
      .dv__pane .dv__labels #dvLeft::after { content: attr(data-inline); }
      .dv__pane [data-act="layout"] { display: none; }
    }
    .dv__editorWrap { position: relative; flex: 1; min-height: 220px; }
    .dv[data-mode="edit"] .dv__editorWrap { box-shadow: inset 0 0 0 2px var(--gt-primary); }
    ::slotted(.qc__dv-editor) { position: absolute; inset: 0; }
    /* Modo oscuro del IDE: GAS invierte su Monaco; el visor (fuera de .LjDxcd) hace lo mismo. */
    :host-context(body.qc__is-dark-mode) ::slotted(.qc__dv-editor) { filter: invert(1) hue-rotate(180deg); }
    .dv__fallback, .dv__message { position: absolute; inset: 0; overflow: auto; }
    .dv__message { padding: var(--gt-space-4); color: var(--gt-on-surface-variant); }
    .dv__fallback table { width: max-content; min-width: 100%; border-collapse: collapse; font: 400 11.5px/1.55 var(--gt-font-mono); }
    .dv__fallback td { padding: 0 6px; vertical-align: top; white-space: pre; }
    .dv__fallback td.dv__num { width: 1%; color: var(--gt-on-surface-variant); text-align: right; user-select: none; }
    .dv__fallback td.dv__del { background: color-mix(in srgb, var(--gt-error) 14%, var(--gt-surface-bright)); }
    .dv__fallback td.dv__add { background: color-mix(in srgb, var(--gt-success) 14%, var(--gt-surface-bright)); }
    .dv__fallback td.dv__empty { background: var(--gt-surface-container); }
    .dv__fallback tr.dv__current td { box-shadow: inset 0 1px 0 var(--gt-primary); }
    .dv__fallback .dv__unified { display: none; }
    /* Respaldo estrecho: una sola columna unificada, como Monaco en línea. */
    @container (max-width: 700px) {
      .dv__fallback .dv__split { display: none; }
      .dv__fallback .dv__unified { display: table; }
    }
    .gt-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .dv__ico { display: inline-flex; }
    .qc__gh-diffOrigin {
      display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px;
      border-radius: var(--gt-shape-xs); font: 600 10px/1.3 var(--gt-font-plain); white-space: nowrap;
    }
    .qc__gh-diffOrigin.local { background: var(--gt-primary); color: var(--gt-on-primary); }
    .qc__gh-diffOrigin.remote { background: transparent; box-shadow: inset 0 0 0 1px var(--gt-outline); color: var(--gt-on-surface); }
    .qc__gh-diffOrigin.conflict { background: var(--gt-warning-container); color: var(--gt-on-warning-container); }
    .qc__gh-diffOrigin.unknown { background: var(--gt-surface-container-high); color: var(--gt-on-surface-variant); }
    .qc__gh-diffOrigin.unavailable { background: var(--gt-error-container); color: var(--gt-on-error-container); }
    [hidden] { display: none !important; }
    @media (max-width: 640px) {
      .dv { inset: 0; border-radius: 0; }
      .dv__body { flex-direction: column; }
      .dv__list { flex: 0 0 auto; max-height: 72px; border-right: none; border-bottom: 1px solid var(--gt-outline-variant); }
      .dv__title { display: none; }
      .dv__bar { padding: var(--gt-space-1); gap: var(--gt-space-1); }
      .dv__bar .gt-btn { min-height: 28px; padding: 0 var(--gt-space-2); }
    }
  `;

  /** @type {object|null} Sesión abierta (privada: la página no puede leerla). */
  #s = null;
  /** @type {Map<string,{content:string, local:string, remote:string}>} Borradores de edición por ruta. */
  #drafts = new Map();
  #seq = 0;

  constructor() {
    this._onKeyDown_ = this._onKeyDown_.bind(this);
    this._onFocusIn_ = this._onFocusIn_.bind(this);
    this._onForceClose_ = () => this.close();
  }

  /** @returns {boolean} `true` si el visor está abierto. */
  isOpen() {
    return !!this.#s;
  }

  /**
   * Abre el visor.
   * @param {{items:Array, activePath?:string, onResolve?:Function, onClose?:Function,
   *   resolutions?:Map<string,{action:string, content?:string}>}} opts `items` = `_diffItems` con cambios.
   *   `onResolve(path, {action, content?, local, remote})` devuelve `false` si el panel la rechaza.
   * @returns {boolean} `false` si no hay nada que mostrar.
   */
  open({ items, activePath, onResolve, onClose, resolutions } = {}) {
    const list = Array.isArray(items) ? items.filter((i) => i && i.status !== 'eq') : [];
    if (!list.length) return false;
    if (this.#s) this.close();
    const monaco = window.monaco;
    this.#s = {
      items: list,
      index: Math.max(0, list.findIndex((i) => i.path === activePath)),
      onResolve: typeof onResolve === 'function' ? onResolve : null,
      onClose: typeof onClose === 'function' ? onClose : null,
      resolutions: new Map(resolutions || []),
      canDiff: typeof monaco?.editor?.createDiffEditor === 'function',
      sideBySide: true,
      mode: 'view',
      showBase: false,
      changeIndex: -1,
      diffPending: false,
      editStart: '',
      notice: '',
      editor: null,
      models: null,
      modelSubs: [],
      subs: [],
      prevFocus: document.activeElement,
    };
    const s = this.#s;
    s.ui = this._buildUi_();
    s.ui.onKeyDown?.(this._onKeyDown_);
    document.addEventListener('focusin', this._onFocusIn_, true);
    document.addEventListener('GAS_HidePanels', this._onForceClose_);
    document.addEventListener('GAS_GlobalDisable', this._onForceClose_);
    window.addEventListener('pagehide', this._onForceClose_);
    this._showFile_(s.index);
    s.ui.focusFile(s.index);
    return true;
  }

  /** Cierra el visor y libera editor, modelos y listeners (la edición pendiente queda como borrador). */
  close() {
    const s = this.#s;
    if (!s) return;
    this._keepDraft_();
    this.#s = null;
    document.removeEventListener('focusin', this._onFocusIn_, true);
    document.removeEventListener('GAS_HidePanels', this._onForceClose_);
    document.removeEventListener('GAS_GlobalDisable', this._onForceClose_);
    window.removeEventListener('pagehide', this._onForceClose_);
    [...s.subs, ...s.modelSubs].forEach((d) => { try { d.dispose(); } catch (_) { /* ya liberado */ } });
    try { s.editor?.dispose(); } catch (_) { /* ya liberado */ }
    GasDiffViewer._disposeModels_(s.models);
    s.ui.remove();
    try { s.prevFocus?.focus?.({ preventScroll: true }); } catch (_) { /* fuera del DOM */ }
    try { s.onClose?.(); } catch (err) { console.warn('[gas-diff-viewer] onClose failed:', err); }
  }

  /** `true` si hay un borrador guardado para esa ruta y contenido. */
  hasDraft(path) {
    return this.#drafts.has(path);
  }

  // ── Archivo activo ──────────────────────────────────────────────────

  /** Muestra el archivo `index` (modelos nuevos; los anteriores se liberan). @private */
  _showFile_(index) {
    const s = this.#s;
    const item = s.items[index];
    if (!item) return;
    this._keepDraft_();
    s.index = index;
    s.mode = 'view';
    s.showBase = false;
    s.changeIndex = -1;
    s.notice = '';

    if (item.unavailable) {
      this._swapModels_(null);
      s.ui.setMessage(DomUtils.t('edDvUnavailable', 'This file is not available for comparison.'));
    } else if (s.canDiff) {
      const monaco = window.monaco;
      if (!s.editor) {
        s.ui.setMessage('');
        s.editor = monaco.editor.createDiffEditor(s.ui.editorEl, {
          renderSideBySide: s.sideBySide,
          readOnly: true,
          originalEditable: false,
          automaticLayout: true,
          enableSplitViewResizing: true,
          useInlineViewWhenSpaceIsLimited: true,
          renderSideBySideInlineBreakpoint: GasDiffViewer.INLINE_BREAKPOINT,
          renderOverviewRuler: true,
          scrollBeyondLastLine: false,
          minimap: { enabled: false },
        });
        const sub = s.editor.onDidUpdateDiff?.(() => {
          if (!this.#s) return;
          this.#s.diffPending = false;
          this._refreshBar_();
        });
        if (sub) s.subs.push(sub);
      }
      const lang = GasDiffViewer._languageFor_(item.path);
      this._swapModels_({
        original: monaco.editor.createModel(item.remote || '', lang, this._uri_('github', item.path)),
        modified: monaco.editor.createModel(item.local || '', lang, this._uri_('gas', item.path)),
      });
      s.editor.updateOptions({ readOnly: true, originalEditable: false });
    } else {
      s.ui.setFallback(this._fallbackHtml_(item));
    }
    this._refreshAll_();
  }

  /**
   * Cambia los modelos del DiffEditor y libera los anteriores (nunca uno en uso).
   * @param {{original:object, modified:object, base?:object}|null} next
   * @private
   */
  _swapModels_(next) {
    const s = this.#s;
    const prev = s.models;
    s.modelSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ya liberado */ } });
    s.modelSubs = [];
    s.models = next;
    if (s.editor && next) {
      s.editor.setModel({ original: next.original, modified: next.modified });
      // Tras cada edición, el bloque a copiar no es fiable hasta que Monaco recalcule el diff.
      const sub = next.modified.onDidChangeContent?.(() => {
        if (!this.#s) return;
        this.#s.diffPending = true;
        this._refreshBar_();
      });
      if (sub) s.modelSubs.push(sub);
    }
    GasDiffViewer._disposeModels_(prev);
  }

  /** Libera los modelos temporales de una sesión. @private */
  static _disposeModels_(models) {
    if (!models) return;
    for (const m of [models.original, models.modified, models.base]) {
      try { if (m && !m.isDisposed?.()) m.dispose(); } catch (_) { /* ya liberado */ }
    }
  }

  /** URI única del esquema `gas-ghdiff:`. @private */
  _uri_(side, path) {
    return window.monaco.Uri.parse(`${GasDiffViewer.SCHEME}:/${side}/${encodeURIComponent(path)}?v=${Date.now()}-${++this.#seq}`);
  }

  /** Lenguaje de Monaco por extensión (JS como texto: sin ámbito compartido con el proyecto). @private */
  static _languageFor_(path) {
    const p = String(path || '').toLowerCase();
    if (p.endsWith('.html')) return 'html';
    if (p.endsWith('.json')) return 'json';
    return 'plaintext';
  }

  // ── Acciones ────────────────────────────────────────────────────────

  /**
   * Ejecuta una acción de la barra.
   * @param {string} act
   * @param {string} [arg]
   * @private
   */
  _act_(act, arg) {
    const s = this.#s;
    if (!s) return;
    const item = s.items[s.index];
    switch (act) {
      case 'close': this.close(); return;
      case 'file': this._showFile_(Number(arg)); s.ui.focusFile(Number(arg)); return;
      case 'prev': this._navigate_(-1); return;
      case 'next': this._navigate_(1); return;
      case 'layout':
        s.sideBySide = !s.sideBySide;
        s.editor?.updateOptions({ renderSideBySide: s.sideBySide });
        break;
      case 'base': this._toggleBase_(); break;
      case 'keep-local':
      case 'take-remote':
        if (this._canDecide_(item, act)) this._resolve_(item, { action: act });
        break;
      case 'edit': this._startEdit_(); break;
      case 'copy-block': this.copyBlockFromGithub(); break;
      case 'save-merge':
        if (s.models?.modified && this._resolve_(item, { action: 'merged', content: s.models.modified.getValue() })) {
          this.#drafts.delete(item.path);
          this._stopEdit_(false);
        }
        break;
      case 'cancel-edit':
        this.#drafts.delete(item.path);
        this._stopEdit_(true);
        break;
      default: return;
    }
    this._refreshAll_();
  }

  /**
   * Decisión aplicable al archivo: "quedarse" no tiene efecto si solo existe en GitHub
   * (el push no borra) y "traer" tampoco si solo existe en GAS (el pull no borra).
   * @param {object} item
   * @param {string} action
   * @returns {boolean}
   */
  _canDecide_(item, action) {
    if (!item || item.unavailable) return false;
    if (action === 'keep-local') return item.status !== 'del';
    if (action === 'take-remote') return item.status !== 'add';
    return item.origin === 'conflict';
  }

  /**
   * Envía la decisión con la instantánea que se mostró (GAS y GitHub); el panel la rechaza
   * (`false`) si el diff cambió entretanto.
   * @returns {boolean} `true` si quedó guardada.
   * @private
   */
  _resolve_(item, resolution) {
    const s = this.#s;
    if (!item || item.unavailable) return false;
    const payload = { ...resolution, local: item.local, remote: item.remote };
    let accepted = true;
    try { accepted = s.onResolve ? s.onResolve(item.path, payload) !== false : true; } catch (err) {
      console.warn('[gas-diff-viewer] onResolve failed:', err);
      accepted = false;
    }
    if (!accepted) {
      s.notice = DomUtils.t('edDvStale', 'The comparison changed: close the viewer and open it again.');
      return false;
    }
    s.resolutions.set(item.path, resolution);
    return true;
  }

  /** Lado derecho editable partiendo de GAS, del resultado guardado o del borrador. @private */
  _startEdit_() {
    const s = this.#s;
    const item = s.items[s.index];
    if (!s.editor || !s.models || item.origin !== 'conflict') return;
    const prev = s.resolutions.get(item.path);
    const draft = this.#drafts.get(item.path);
    if (draft && draft.local === item.local && draft.remote === item.remote) {
      s.models.modified.setValue(draft.content);
      s.notice = DomUtils.t('edDvDraftRestored', 'Unsaved edits restored.');
    } else if (prev?.action === 'merged' && typeof prev.content === 'string') {
      s.models.modified.setValue(prev.content);
    }
    s.mode = 'edit';
    s.editStart = item.local || '';
    s.editor.updateOptions({ readOnly: false, originalEditable: false });
    s.editor.getModifiedEditor?.()?.updateOptions?.({ readOnly: false });
    s.editor.getModifiedEditor?.()?.focus?.();
  }

  /** Sale de la edición; con `revert` vuelve al contenido de GAS. @private */
  _stopEdit_(revert) {
    const s = this.#s;
    const item = s.items[s.index];
    if (revert && s.models?.modified) s.models.modified.setValue(item.local || '');
    s.mode = 'view';
    s.editor?.updateOptions({ readOnly: true });
    s.editor?.getModifiedEditor?.()?.updateOptions?.({ readOnly: true });
  }

  /** Guarda la edición en curso como borrador (cambiar de archivo, cerrar o cierre forzado). @private */
  _keepDraft_() {
    const s = this.#s;
    if (!s || s.mode !== 'edit' || !s.models?.modified) return;
    const item = s.items[s.index];
    const content = s.models.modified.getValue();
    if (content !== s.editStart) this.#drafts.set(item.path, { content, local: item.local, remote: item.remote });
    s.mode = 'view';
  }

  /** Alterna el lado izquierdo entre GitHub y la base (solo conflictos con base). @private */
  _toggleBase_() {
    const s = this.#s;
    const item = s.items[s.index];
    if (!s.editor || !s.models || typeof item.base !== 'string') return;
    s.showBase = !s.showBase;
    if (s.showBase && !s.models.base) {
      s.models.base = window.monaco.editor.createModel(item.base, GasDiffViewer._languageFor_(item.path), this._uri_('base', item.path));
    }
    s.diffPending = true;
    s.editor.setModel({ original: s.showBase ? s.models.base : s.models.original, modified: s.models.modified });
  }

  /** Cambios del diff actual (Monaco o respaldo). @private */
  _changes_() {
    const s = this.#s;
    if (s.editor) return s.editor.getLineChanges?.() || [];
    return [...(s.ui.fallbackChanges?.() || [])];
  }

  /**
   * Va al cambio anterior (`-1`) o siguiente (`1`) y lo centra.
   * @param {number} dir
   * @private
   */
  _navigate_(dir) {
    const s = this.#s;
    const changes = this._changes_();
    if (!changes.length) return;
    s.changeIndex = s.changeIndex < 0
      ? (dir > 0 ? 0 : changes.length - 1)
      : (s.changeIndex + dir + changes.length) % changes.length;
    const c = changes[s.changeIndex];
    if (s.editor) {
      const line = Math.max(1, c.modifiedStartLineNumber || c.modifiedEndLineNumber || 1);
      const mod = s.editor.getModifiedEditor?.();
      mod?.revealLineInCenter?.(line);
      mod?.setPosition?.({ lineNumber: line, column: 1 });
      s.editor.getOriginalEditor?.()?.revealLineInCenter?.(Math.max(1, c.originalStartLineNumber || 1));
    } else {
      s.ui.revealFallbackChange(s.changeIndex);
    }
    this._refreshBar_();
  }

  /**
   * Bloque a copiar: el que contiene la línea del cursor del lado GAS o, si no, el de la navegación.
   * @param {Array} changes `getLineChanges()`.
   * @returns {object|null}
   * @private
   */
  _currentChange_(changes) {
    const s = this.#s;
    const line = s.editor?.getModifiedEditor?.()?.getPosition?.()?.lineNumber;
    if (line) {
      const hit = changes.find((c) => (c.modifiedEndLineNumber > 0
        ? line >= c.modifiedStartLineNumber && line <= c.modifiedEndLineNumber
        : line === c.modifiedStartLineNumber || line === c.modifiedStartLineNumber + 1));
      if (hit) return hit;
    }
    return changes.length ? changes[Math.min(Math.max(s.changeIndex, 0), changes.length - 1)] : null;
  }

  /**
   * Copia al resultado (lado GAS) el bloque del lado izquierdo (GitHub o la base).
   * @returns {boolean} `true` si aplicó la edición.
   */
  copyBlockFromGithub() {
    const s = this.#s;
    if (!s || s.mode !== 'edit' || !s.editor || !s.models || s.diffPending) return false;
    const c = this._currentChange_(this._changes_());
    if (!c) return false;
    const original = s.showBase ? s.models.base : s.models.original;
    const modified = s.models.modified;
    const os = c.originalStartLineNumber;
    const oe = c.originalEndLineNumber;
    const ms = c.modifiedStartLineNumber;
    const me = c.modifiedEndLineNumber;
    const text = oe > 0
      ? original.getValueInRange({ startLineNumber: os, startColumn: 1, endLineNumber: oe, endColumn: original.getLineMaxColumn(oe) })
      : '';
    let range;
    let insert = text;
    const last = modified.getLineCount();
    if (oe === 0) {
      // Solo en GAS: se quitan esas líneas.
      if (me < last) range = { startLineNumber: ms, startColumn: 1, endLineNumber: me + 1, endColumn: 1 };
      else if (ms > 1) range = { startLineNumber: ms - 1, startColumn: modified.getLineMaxColumn(ms - 1), endLineNumber: me, endColumn: modified.getLineMaxColumn(me) };
      else range = { startLineNumber: 1, startColumn: 1, endLineNumber: me, endColumn: modified.getLineMaxColumn(me) };
      insert = '';
    } else if (me === 0) {
      // Solo a la izquierda: se insertan tras la línea `ms` (0 = al principio).
      if (ms === 0) { range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }; insert = `${text}\n`; }
      else { const col = modified.getLineMaxColumn(ms); range = { startLineNumber: ms, startColumn: col, endLineNumber: ms, endColumn: col }; insert = `\n${text}`; }
    } else {
      range = { startLineNumber: ms, startColumn: 1, endLineNumber: me, endColumn: modified.getLineMaxColumn(me) };
    }
    modified.pushStackElement?.();
    modified.pushEditOperations([], [{ range, text: insert, forceMoveMarkers: false }], () => null);
    modified.pushStackElement?.();
    s.diffPending = true;
    this._refreshBar_();
    return true;
  }

  // ── Teclado y foco ──────────────────────────────────────────────────

  /**
   * Teclado en el host: Esc es de Monaco si tiene un widget abierto; en edición lleva el
   * foco a "Guardar resultado" (nunca descarta); si no, cierra. Alt+↑/↓ navega; Tab queda dentro.
   * @private
   */
  _onKeyDown_(e) {
    const s = this.#s;
    if (!s) return;
    if (e.key === 'Escape') {
      if (e.defaultPrevented || s.ui.monacoWidgetOpen?.()) return;
      e.preventDefault();
      e.stopPropagation();
      if (s.mode === 'edit') s.ui.focusAct('save-merge');
      else this.close();
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      this._navigate_(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Tab') s.ui.trapTab?.(e);
  }

  /** Foco atrapado: si sale del visor (y no es una capa de Monaco), vuelve a él. @private */
  _onFocusIn_(e) {
    const s = this.#s;
    if (!s || s.ui.contains(e.target) || e.target?.closest?.(GasDiffViewer.MONACO_LAYERS)) return;
    s.ui.focusFile(s.index);
  }

  // ── Render ──────────────────────────────────────────────────────────

  /** Repinta lista, barra y etiquetas. @private */
  _refreshAll_() {
    if (!this.#s) return;
    this._refreshList_();
    this._refreshBar_();
  }

  /** Lista lateral de archivos con su badge, la decisión y el estado de los conflictos. @private */
  _refreshList_() {
    const s = this.#s;
    const esc = DomUtils.escapeHtml;
    const html = s.items.map((it, i) => {
      const res = s.resolutions.get(it.path);
      let chip = '';
      if (it.origin === 'conflict') {
        chip = res
          ? `<span class="dv__chip dv__chip--ok">${GasUi.icon('check', 12)}${esc(DomUtils.t('edDvResolved', 'Resolved'))}</span>`
          : `<span class="dv__chip dv__chip--todo">${esc(DomUtils.t('edDvUnresolved', 'Unresolved'))}</span>`;
      }
      return `<li><button class="dv__file" type="button" data-act="file" data-arg="${i}" ${i === s.index ? 'aria-current="true"' : ''}>`
        + `<span class="dv__fileName" title="${esc(it.path)}">${esc(it.path)}</span>`
        + `<span class="dv__fileMeta">${GasDiffViewer.badgeHtml(it)}${chip}`
        + `${res ? `<span class="dv__res">${esc(GasDiffViewer.resolutionLabel(res))}</span>` : ''}</span>`
        + '</button></li>';
    }).join('');
    s.ui.setList(html, s.items[s.index]?.path || '');
  }

  /** Estado de la barra (botones visibles, contador, etiquetas de columnas). @private */
  _refreshBar_() {
    const s = this.#s;
    if (!s) return;
    const item = s.items[s.index];
    const changes = this._changes_();
    const editing = s.mode === 'edit';
    const isConflict = item.origin === 'conflict';
    const res = s.resolutions.get(item.path);
    const count = changes.length
      ? DomUtils.t('edDvChangeOf', 'Change $1 of $2', Math.max(1, s.changeIndex + 1), changes.length)
      : DomUtils.t('edDvNoChanges', 'No changes');
    const left = s.showBase ? DomUtils.t('edDvBase', 'Base (last sync)') : DomUtils.t('edDvGithub', 'GitHub');
    const right = editing ? DomUtils.t('edDvResult', 'Result (editable)') : DomUtils.t('edDvGas', 'GAS');
    const state = s.notice || (res ? DomUtils.t('edDvDecision', 'Decision: $1', GasDiffViewer.resolutionLabel(res)) : '');
    s.ui.setBar({
      mode: s.mode,
      count,
      state,
      left: s.sideBySide || !s.canDiff ? left : `${left} (−) · ${right} (+)`,
      right,
      inline: s.canDiff && !s.sideBySide,
      copyLabel: s.showBase ? DomUtils.t('edDvCopyBlockBase', 'Copy block from base') : DomUtils.t('edDvCopyBlock', 'Copy block from GitHub'),
      show: {
        layout: s.canDiff,
        base: s.canDiff && isConflict && typeof item.base === 'string' && !!s.editor,
        'keep-local': !editing && this._canDecide_(item, 'keep-local'),
        'take-remote': !editing && this._canDecide_(item, 'take-remote'),
        edit: !editing && isConflict && s.canDiff && !item.unavailable,
        'copy-block': editing,
        'save-merge': editing,
        'cancel-edit': editing,
        prev: !item.unavailable,
        next: !item.unavailable,
      },
      disabled: { 'copy-block': s.diffPending || !changes.length },
      pressed: { layout: s.sideBySide, base: s.showBase, 'keep-local': res?.action === 'keep-local', 'take-remote': res?.action === 'take-remote' },
      path: item.path,
    });
  }

  /** Etiqueta de una decisión. */
  static resolutionLabel(res) {
    if (res?.action === 'keep-local') return DomUtils.t('edDvKeepLocal', 'Keep GAS');
    if (res?.action === 'take-remote') return DomUtils.t('edDvTakeRemote', 'Take GitHub');
    if (res?.action === 'merged') return DomUtils.t('edDvMerged', 'Edited result');
    return '';
  }

  /** Badge de origen reutilizando el render del mixin del panel (si está cargado). */
  static badgeHtml(item) {
    const mixin = typeof GasGithubPanelDiffMixin !== 'undefined' ? GasGithubPanelDiffMixin : null;
    if (!mixin?._renderDiffOriginBadge_) return '';
    const ctx = { _ico_: (n) => `<i class="dv__ico" aria-hidden="true">${GasUi.icon(n, 12)}</i>` };
    return mixin._renderDiffOriginBadge_.call(ctx, item);
  }

  /**
   * Respaldo sin DiffEditor: dos columnas (GitHub | GAS) y, para anchos estrechos, una
   * columna unificada; todo escapado y sin partir líneas.
   * @param {{path:string, remote:string, local:string}} item
   * @returns {string}
   * @private
   */
  _fallbackHtml_(item) {
    const esc = DomUtils.escapeHtml;
    const ops = GasLineDiff.diffLines(item.remote || '', item.local || '');
    const split = [];
    const unified = [];
    const srGithub = esc(DomUtils.t('edGhSrLineGithub', 'Only in GitHub: '));
    const srGas = esc(DomUtils.t('edGhSrLineGas', 'Only in GAS: '));
    let change = 0;
    for (let i = 0; i < ops.length;) {
      if (ops[i].type === 'equal') {
        const o = ops[i++];
        split.push(`<tr><td class="dv__num">${o.aLine}</td><td>${esc(o.text)}</td><td class="dv__num">${o.bLine}</td><td>${esc(o.text)}</td></tr>`);
        unified.push(`<tr><td class="dv__num">${o.aLine}</td><td class="dv__num">${o.bLine}</td><td>${esc(o.text)}</td></tr>`);
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < ops.length && ops[i].type === 'del') dels.push(ops[i++]);
      while (i < ops.length && ops[i].type === 'add') adds.push(ops[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        split.push(`<tr${k === 0 ? ` data-change="${change}"` : ''}>`
          + (d ? `<td class="dv__num dv__del">${d.aLine}</td><td class="dv__del">${esc(d.text)}</td>` : '<td class="dv__num dv__empty"></td><td class="dv__empty"></td>')
          + (a ? `<td class="dv__num dv__add">${a.bLine}</td><td class="dv__add">${esc(a.text)}</td>` : '<td class="dv__num dv__empty"></td><td class="dv__empty"></td>')
          + '</tr>');
      }
      dels.forEach((d) => unified.push(`<tr><td class="dv__num dv__del">${d.aLine}</td><td class="dv__num dv__del"></td><td class="dv__del"><span class="gt-sr-only">${srGithub}</span>${esc(d.text)}</td></tr>`));
      adds.forEach((a) => unified.push(`<tr><td class="dv__num dv__add"></td><td class="dv__num dv__add">${a.bLine}</td><td class="dv__add"><span class="gt-sr-only">${srGas}</span>${esc(a.text)}</td></tr>`));
      change++;
    }
    const caption = esc(DomUtils.t('edGhDiffTableLabel', 'Differences in $1', item.path));
    return `<table class="dv__split" aria-label="${caption}"><tbody>${split.join('')}</tbody></table>`
      + `<table class="dv__unified" aria-label="${caption}"><tbody>${unified.join('')}</tbody></table>`;
  }

  /**
   * Crea el host en `document.body` (shadow para la chrome, editor *slotted*).
   * @returns {object} API mínima de la interfaz.
   * @private
   */
  _buildUi_() {
    const esc = DomUtils.escapeHtml;
    const t = DomUtils.t.bind(DomUtils);
    const host = document.createElement('div');
    host.className = 'qc__dv-host';
    const root = host.attachShadow({ mode: 'open' });
    GasUi.adopt(root, GasDiffViewer.CSS);
    const editorEl = document.createElement('div');
    editorEl.className = 'qc__dv-editor';
    editorEl.slot = 'editor';
    host.appendChild(editorEl);
    const btn = (act, label, icon, cls = 'gt-btn gt-btn--outlined gt-btn--sm', extra = '') => {
      const iconOnly = cls.includes('gt-icon-btn');
      return `<button class="${cls}" type="button" data-act="${act}" ${extra}`
        + `${iconOnly ? ` aria-label="${esc(label)}" title="${esc(label)}"` : ''}>`
        + `${icon ? GasUi.icon(icon, 16) : ''}${iconOnly ? '' : `<span class="dv__btnText">${esc(label)}</span>`}</button>`;
    };
    const keepDesc = t('edDvKeepLocalDesc', 'GAS is not overwritten when pulling.');
    const takeDesc = t('edDvTakeRemoteDesc', 'GAS is replaced by GitHub when the pull is applied.');
    DomUtils.setHTML(root, `
      <div class="dv" role="dialog" aria-modal="true" aria-labelledby="dvTitle" data-mode="view">
        <header class="dv__head">
          <h2 class="dv__title" id="dvTitle">${esc(t('edDvTitle', 'Compare with GitHub'))}</h2>
          <span class="dv__path" id="dvPath"></span>
          ${btn('close', t('edDvClose', 'Close (Esc)'), 'close', 'gt-icon-btn')}
        </header>
        <div class="dv__body">
          <nav class="dv__list" aria-label="${esc(t('edDvFiles', 'Files'))}"><ul id="dvList"></ul></nav>
          <section class="dv__pane">
            <div class="dv__bar" role="toolbar" aria-label="${esc(t('edDvToolbar', 'Diff actions'))}">
              <div class="dv__group">
                ${btn('prev', t('edDvPrev', 'Previous change (Alt+↑)'), 'chevronUp', 'gt-icon-btn')}
                <span class="dv__count" id="dvCount" aria-live="polite"></span>
                ${btn('next', t('edDvNext', 'Next change (Alt+↓)'), 'chevronDown', 'gt-icon-btn')}
                ${btn('layout', t('edDvSideBySide', 'Side by side'), '', undefined, 'aria-pressed="true"')}
                ${btn('base', t('edDvShowBase', 'Show base'), '', undefined, 'aria-pressed="false"')}
              </div>
              <div class="dv__group">
                <span class="dv__state" id="dvState" aria-live="polite"></span>
                ${btn('keep-local', t('edDvKeepLocal', 'Keep GAS'), 'check', undefined, `aria-pressed="false" title="${esc(keepDesc)}" aria-describedby="dvKeepDesc"`)}
                ${btn('take-remote', t('edDvTakeRemote', 'Take GitHub'), 'download', undefined, `aria-pressed="false" title="${esc(takeDesc)}" aria-describedby="dvTakeDesc"`)}
                ${btn('edit', t('edDvEdit', 'Edit result'), 'pencil')}
                ${btn('copy-block', t('edDvCopyBlock', 'Copy block from GitHub'), 'arrowForward')}
                ${btn('cancel-edit', t('edDvCancelEdit', 'Discard edits'), '', 'gt-btn gt-btn--text gt-btn--sm')}
                ${btn('save-merge', t('edDvSaveMerge', 'Save result'), 'save', 'gt-btn gt-btn--filled gt-btn--sm')}
                <span class="gt-sr-only" id="dvKeepDesc">${esc(keepDesc)}</span>
                <span class="gt-sr-only" id="dvTakeDesc">${esc(takeDesc)}</span>
              </div>
            </div>
            <div class="dv__labels" id="dvLabels"><span id="dvLeft"></span><span id="dvRight"></span></div>
            <div class="dv__editorWrap">
              <slot name="editor"></slot>
              <div class="dv__fallback" id="dvFallback" hidden></div>
              <div class="dv__message" id="dvMessage" hidden></div>
            </div>
          </section>
        </div>
      </div>
    `);
    const $ = (id) => root.getElementById(id);
    const dv = root.querySelector('.dv');
    root.addEventListener('click', (e) => {
      const el = e.target?.closest?.('[data-act]');
      if (el && !el.disabled) this._act_(el.dataset.act, el.dataset.arg);
    });
    document.body.appendChild(host);
    const FOCUSABLE = 'button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])';

    return {
      editorEl,
      onKeyDown: (fn) => host.addEventListener('keydown', fn),
      contains: (node) => node === host || host.contains(node),
      remove: () => host.remove(),
      monacoWidgetOpen: () => !!editorEl.querySelector(GasDiffViewer.MONACO_WIDGETS),
      focusAct: (act) => root.querySelector(`[data-act="${act}"]`)?.focus({ preventScroll: true }),
      focusFile: (i) => (root.querySelector(`.dv__file[data-arg="${i}"]`) || root.querySelector('[data-act="next"]'))?.focus({ preventScroll: true }),
      trapTab: (e) => {
        // Orden: controles del shadow y, en medio, el editor (light DOM, slotted).
        const shadowItems = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        const editorInput = editorEl.hidden ? null : editorEl.querySelector('.modified textarea, textarea');
        const items = editorInput ? [...shadowItems, editorInput] : shadowItems;
        if (!items.length) return;
        // Tab dentro de Monaco (editable o en un widget) es suyo.
        if (e.defaultPrevented) return;
        const active = root.activeElement || (editorEl.contains(document.activeElement) ? document.activeElement : null);
        if (active && editorEl.contains(active) && active !== editorInput) return;
        const idx = items.indexOf(active);
        if (e.shiftKey && idx <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
        else if (!e.shiftKey && (idx === items.length - 1 || idx < 0)) { e.preventDefault(); items[0].focus(); }
      },
      setList: (html, path) => { DomUtils.setHTML($('dvList'), html); $('dvPath').textContent = path; },
      setMessage: (text) => {
        $('dvMessage').hidden = !text;
        $('dvMessage').textContent = text;
        $('dvFallback').hidden = true;
        editorEl.hidden = !!text;
      },
      setFallback: (html) => {
        editorEl.hidden = true;
        $('dvMessage').hidden = true;
        $('dvFallback').hidden = false;
        DomUtils.setHTML($('dvFallback'), html);
      },
      fallbackChanges: () => [...$('dvFallback').querySelectorAll('tr[data-change]')],
      revealFallbackChange: (i) => {
        const rows = [...$('dvFallback').querySelectorAll('tr[data-change]')];
        rows.forEach((r, k) => r.classList.toggle('dv__current', k === i));
        rows[i]?.scrollIntoView({ block: 'center' });
      },
      setBar: (st) => {
        dv.dataset.mode = st.mode;
        // Solo si cambia: evita re-anuncios del aria-live en cada recálculo del diff.
        if ($('dvCount').textContent !== st.count) $('dvCount').textContent = st.count;
        if ($('dvState').textContent !== st.state) $('dvState').textContent = st.state;
        $('dvLeft').textContent = st.left;
        $('dvLeft').dataset.inline = st.inline ? '' : ` (−) · ${st.right} (+)`;
        $('dvRight').textContent = st.right;
        $('dvRight').hidden = st.inline;
        $('dvLabels').classList.toggle('dv__labels--inline', st.inline);
        for (const [act, visible] of Object.entries(st.show)) {
          const el = root.querySelector(`[data-act="${act}"]`);
          if (el) el.hidden = !visible;
        }
        for (const [act, off] of Object.entries(st.disabled)) {
          const el = root.querySelector(`[data-act="${act}"]`);
          if (el) el.disabled = !!off;
        }
        for (const [act, on] of Object.entries(st.pressed)) {
          root.querySelector(`[data-act="${act}"]`)?.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        const copyText = root.querySelector('[data-act="copy-block"] .dv__btnText');
        if (copyText && copyText.textContent !== st.copyLabel) copyText.textContent = st.copyLabel;
      },
    };
  }
}

if (typeof window !== 'undefined' && !window.gasDiffViewer) window.gasDiffViewer = new GasDiffViewer();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasDiffViewer };
