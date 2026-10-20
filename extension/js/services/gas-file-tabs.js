"use strict";

/**
 * @fileoverview gas-file-tabs.js
 *
 * Pestañas de archivos estilo VS Code sobre el editor de GAS:
 *  - Fuente de verdad = árbol de GAS (`ul[role="listbox"] li[role="option"][data-res-id]`):
 *    cada pestaña se identifica por `data-res-id`; el nombre sale de
 *    `div[title]` (ruta completa) o `aria-label`; el activo es el `li`
 *    con `aria-selected="true"`.
 *  - Cambiar de pestaña = clic sintético en el `li` del árbol (con un
 *    reintento más fuerte). Si GAS no lo refleja, NO se cambia de archivo
 *    a sus espaldas: se avisa con un toast y manda el árbol.
 *  - Cerrar (× y clic central; la última y las que tienen cambios sin
 *    guardar no se cierran), menú contextual, lista de todas las pestañas
 *    (botón al desbordar), reordenar (drag & drop y Ctrl+Shift+←/→).
 *  - Punto ● de "sin guardar": indicador nativo del árbol si se conoce su
 *    selector (`DIRTY_SELECTOR`); si no, aproximado por versiones de Monaco.
 *  - Sin persistencia: al recargar se empieza por el archivo activo.
 *
 * Auto-inicializado con el toggle `gas-file-tabs` (desactivado por defecto).
 * `window.gasFileTabs.setEditor(editor)` lo llama `gas-tools.js` al
 * recapturar el editor.
 */
class GasFileTabs {
  static HOST_ID = 'qc__fileTabsHost';
  static MENU_HOST_ID = 'qc__fileTabsMenuHost';
  static TREE_ITEM_SELECTOR = 'ul[role="listbox"] li[role="option"][data-res-id]';
  static TREE_LIST_SELECTOR = 'ul[role="listbox"]';
  static DEFAULT_EDITOR_AREA = '.LjDxcd, .ry3kXd';
  static DRAG_MIME = 'application/x-gas-tools-tab';
  /**
   * Selector (dentro del `li` del árbol) del indicador nativo de GAS de
   * "cambios sin guardar". Vacío = se usa el método aproximado por versiones.
   */
  /** Círculo naranja nativo de GAS en el `li` con cambios sin guardar (clase ofuscada + color fijo). */
  static DIRTY_SELECTOR = 'svg.NSy2Hd, svg:has(> circle[fill="#EA8600" i])';
  /** Hosts propios de la extensión que el observer del body ignora. */
  static OWN_HOSTS_SELECTOR = '[id^="qc__"], [id^="gt-"], [id^="rsBtn"]';
  /** Debounce de la sincronía con el árbol (ms). */
  static SYNC_DELAY_MS = 60;
  /** Espera de cada intento de clic antes de reintentar o avisar (ms). */
  static SWITCH_FALLBACK_MS = 400;
  /** Espera tras Ctrl+S antes de reiniciar la línea base (ms). */
  static SAVE_SETTLE_MS = 600;
  /** Un `li` ausente durante este tiempo se considera borrado (ms). */
  static DELETE_GRACE_MS = 400;
  /** Reintentos de sincronía tras enganchar el editor (ms). */
  static BOOT_SYNC_DELAYS_MS = [120, 350, 800, 1500];
  /** Throttle del observer del body (ms). */
  static DOC_CHECK_THROTTLE_MS = 500;
  /** Polling hasta que exista el editor (ms). */
  static READY_POLL_MS = 300;
  /** Un scroll en este margen tras abrir el menu o desplazar por código no lo cierra (ms). */
  static MENU_SCROLL_GRACE_MS = 150;
  /** Con más pestañas que esto, la lista muestra un buscador. */
  static LIST_FILTER_MIN = 8;

  static CSS = `
:host { display: block; box-sizing: border-box; flex: 0 0 auto; min-width: 0; }
.wrap {
  display: flex;
  align-items: stretch;
  box-sizing: border-box;
  height: 32px;
  background: var(--gt-surface-container);
  border-bottom: 1px solid var(--gt-outline-variant);
  color: var(--gt-on-surface-variant);
  font: 400 12px/16px var(--gt-font-plain);
  user-select: none;
}
.bar {
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.bar::-webkit-scrollbar { display: none; }
.bar.has-start { -webkit-mask-image: linear-gradient(to right, transparent 0, #000 24px); mask-image: linear-gradient(to right, transparent 0, #000 24px); }
.bar.has-end { -webkit-mask-image: linear-gradient(to left, transparent 0, #000 24px); mask-image: linear-gradient(to left, transparent 0, #000 24px); }
.bar.has-start.has-end {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%);
}
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--gt-space-1);
  flex: 0 0 auto;
  box-sizing: border-box;
  min-width: 0;
  max-width: 200px;
  height: 100%;
  padding: 0 var(--gt-space-1) 0 var(--gt-space-3);
  border-right: 1px solid var(--gt-outline-variant);
  color: var(--gt-on-surface-variant);
  white-space: nowrap;
  cursor: pointer;
}
.tab:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
.tab.is-active { background: var(--gt-surface); color: var(--gt-on-surface); }
:host-context(body.qc__is-dark-mode) .tab.is-active { background: var(--gt-background); }
.tab.is-active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--gt-primary);
  pointer-events: none;
}
.tab:focus { outline: none; }
.tab:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: -2px; }
.tab.is-dragging { background: var(--gt-state-pressed); }
.tab.is-drop-before::after,
.tab.is-drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--gt-primary);
  pointer-events: none;
}
.tab.is-drop-before::after { left: -1px; }
.tab.is-drop-after::after { right: -1px; }
.tab__icon { display: inline-grid; place-items: center; flex: 0 0 auto; color: var(--gt-outline); }
.tab.is-active .tab__icon { color: var(--gt-primary); }
.tab__icon svg, .row__icon svg { width: 16px; height: 16px; }
.tab__label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tab__hint {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--gt-on-surface-variant);
  font-size: 11px;
}
.tab__end { display: grid; place-items: center; flex: 0 0 auto; width: 24px; height: 24px; }
.tab__end > * { grid-area: 1 / 1; }
.tab__dot {
  display: none;
  width: 8px;
  height: 8px;
  border-radius: var(--gt-shape-full);
  background: var(--tab-dirty-color, var(--gt-warning));
}
.tab.is-dirty .tab__dot { display: block; }
.tab__close {
  display: inline-grid;
  place-items: center;
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  border-radius: var(--gt-shape-xs);
  color: inherit;
  cursor: pointer;
  visibility: hidden;
}
.tab__close:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
.tab.is-active .tab__close,
.tab:hover .tab__close,
.tab:focus-visible .tab__close { visibility: visible; }
.more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 100%;
  padding: 0 var(--gt-space-2);
  border: 0;
  border-left: 1px solid var(--gt-outline-variant);
  background: transparent;
  color: var(--gt-on-surface-variant);
  font: 500 12px/16px var(--gt-font-plain);
  cursor: pointer;
}
.more[hidden] { display: none; }
.more:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
.more:focus { outline: none; }
.more:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: -2px; }
@media (forced-colors: active) {
  .tab.is-active { outline: 1px solid CanvasText; outline-offset: -1px; }
  .tab.is-active::before, .tab.is-drop-before::after, .tab.is-drop-after::after { background: Highlight; }
  .tab:focus-visible, .more:focus-visible { outline: 2px solid Highlight; }
  .tab__dot { background: CanvasText; }
}
`;

  static MENU_CSS = `
.menu { position: fixed; z-index: var(--gt-z-popover); margin: 0; }
.menu--list { width: 280px; max-height: 360px; }
.list { display: flex; flex-direction: column; overflow-y: auto; min-height: 0; }
.list__search { margin: 0 0 var(--gt-space-1); }
.list__group {
  padding: var(--gt-space-2) var(--gt-space-3) var(--gt-space-1);
  color: var(--gt-on-surface-variant);
  font: 500 11px/16px var(--gt-font-plain);
}
.list__empty { padding: var(--gt-space-2) var(--gt-space-3); color: var(--gt-on-surface-variant); font: 400 12px/16px var(--gt-font-plain); }
.row { display: flex; align-items: center; gap: 2px; }
.row__main { flex: 1 1 auto; min-width: 0; gap: var(--gt-space-2); }
.row__check { display: inline-grid; place-items: center; flex: 0 0 auto; width: 16px; color: var(--gt-primary); }
.row__icon { display: inline-grid; place-items: center; flex: 0 0 auto; color: var(--gt-outline); }
.row__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row__hint { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gt-on-surface-variant); font-size: 11px; }
.row__dot { flex: 0 0 auto; width: 8px; height: 8px; margin-left: auto; border-radius: var(--gt-shape-full); background: var(--tab-dirty-color, var(--gt-warning)); }
.row.is-active .row__name { font-weight: 500; }
.row__close { width: 24px; height: 24px; }
`;

  constructor() {
    /** @type {boolean} */
    this._enabled = false;
    /** Oculto fuera de la vista del editor (`GAS_HidePanels`). */
    this._hidden = false;
    /** @type {object|null} */
    this._editor = null;
    /** @type {object|null} */
    this._preferredEditor = null;
    /** @type {WeakSet<object>} */
    this._disposedEditors = new WeakSet();
    /** @type {Array<{resId:string, name:string, model:(object|null), nativeDirty?:boolean}>} */
    this.tabs = [];
    /** @type {string|null} */
    this.activeResId = null;
    /** Pestaña con tabindex=0 (roving tabindex). @type {string|null} */
    this._focusResId = null;
    /** Línea base `getAlternativeVersionId()` por modelo. */
    this._baselines = new WeakMap();
    /** @type {Set<object>} Modelos con cambios respecto a la línea base. */
    this._dirtyModels = new Set();
    /** `true` desde que `DIRTY_SELECTOR` casó con algún `li`: el ● sale del árbol. */
    this._nativeDirty = false;
    /** Versiones tomadas al pulsar Ctrl+S. @type {Map<object, *>|null} */
    this._saveSnapshot = null;
    /** @type {Map<object,{dispose:()=>void}>} */
    this._modelSubs = new Map();
    /** @type {Array<{dispose:()=>void}>} Suscripciones del editor actual. */
    this._editorSubs = [];
    /** @type {Array<{dispose:()=>void}>} Suscripciones globales de Monaco. */
    this._monacoSubs = [];
    this._host = null;
    this._root = null;
    this._bar = null;
    this._more = null;
    this._anchor = null;
    /** Estilo inline previo del ancla (`{height?, top?}`) si se ajustó. */
    this._anchorStyle = null;
    /** El ajuste del ancla quedó pendiente (montada oculta o sin layout). */
    this._fitPending = false;
    this._lists = [];
    this._treeObserver = null;
    this._docObserver = null;
    this._bodyObserver = null;
    this._resizeObserver = null;
    this._barResizeObserver = null;
    this._syncTimer = null;
    this._docCheckTimer = null;
    this._readyTimer = null;
    this._saveTimer = null;
    this._graceTimer = null;
    this._layoutFrame = 0;
    this._layoutFit = false;
    this._overflowFrame = 0;
    this._menuFrame = 0;
    /** Instante del último desplazamiento por código de la barra. */
    this._programmaticScrollAt = 0;
    /** Cambio en curso: `{resId, focusEditor, treeAtStart, attempt, timer}`. */
    this._pending = null;
    /** Pestaña deducida del modelo al cargar, mientras el árbol no marca selección. */
    this._provisionalResId = null;
    this._provisionalModel = null;
    /** Reintentos de sincronía tras enganchar (GAS marca `aria-selected` tarde). */
    this._bootTimers = [];
    /** @type {Map<string, number>} resId → instante en que dejó de verse. */
    this._missingSince = new Map();
    /** @type {{resId:string}|null} */
    this._drag = null;
    /** Se pidió un repintado durante un arrastre. */
    this._renderDeferred = false;
    /** Menú abierto (contextual o lista). */
    this._menu = null;
    this._lastHtml = '';

    this._onKeyCapture   = this._onKeyCapture.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
    this._onAncestorScroll = this._onAncestorScroll.bind(this);
    this._onHidePanels   = this._onHidePanels.bind(this);
    this._onReturn       = this._onReturn.bind(this);
    this._onBarClick     = this._onBarClick.bind(this);
    this._onBarMouseDown = this._onBarMouseDown.bind(this);
    this._onBarAuxClick  = this._onBarAuxClick.bind(this);
    this._onBarContext   = this._onBarContext.bind(this);
    this._onBarKeyDown   = this._onBarKeyDown.bind(this);
    this._onBarWheel     = this._onBarWheel.bind(this);
    this._onBarScroll    = this._onBarScroll.bind(this);
    this._onMoreClick    = this._onMoreClick.bind(this);
    this._onDragStart    = this._onDragStart.bind(this);
    this._onDragOver     = this._onDragOver.bind(this);
    this._onDragLeave    = this._onDragLeave.bind(this);
    this._onDrop         = this._onDrop.bind(this);
    this._onDragEnd      = this._onDragEnd.bind(this);
    this._onMenuClick    = this._onMenuClick.bind(this);
    this._onMenuKey      = this._onMenuKey.bind(this);
    this._onMenuOutside  = this._onMenuOutside.bind(this);
    this._onMenuFocusOut = this._onMenuFocusOut.bind(this);
    this._onMenuPointer  = this._onMenuPointer.bind(this);
    this._onListFilter   = this._onListFilter.bind(this);
    this._closeMenu_     = this._closeMenu_.bind(this);
  }

  /** `true` si el servicio está activo. */
  get enabled() { return this._enabled; }

  // ── API pública ──────────────────────────────────────────────────

  /** Activa las pestañas en cuanto haya editor y árbol. */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._hidden = false;
    document.addEventListener('keydown', this._onKeyCapture, true);
    document.addEventListener('GAS_HidePanels', this._onHidePanels);
    document.addEventListener('GAS_ReturnToEditor', this._onReturn);
    this._waitForEditor_();
  }

  /** Desactiva y limpia DOM, observers, timers y listeners. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    document.removeEventListener('keydown', this._onKeyCapture, true);
    document.removeEventListener('GAS_HidePanels', this._onHidePanels);
    document.removeEventListener('GAS_ReturnToEditor', this._onReturn);
    this._teardown_();
  }

  /**
   * Engancha el servicio a una instancia de Monaco (idempotente).
   * @param {object} editor `IStandaloneCodeEditor`.
   * @returns {boolean} `true` si quedó enganchado.
   */
  setEditor(editor) {
    if (!editor || this._disposedEditors.has(editor)) return false;
    this._preferredEditor = editor;
    if (!this._enabled) return false;
    if (this._editor === editor) return true;
    // Cambio de proyecto (SPA): GAS_HidePanels llega sin GAS_ReturnToEditor.
    if (this._hidden && GasFileTabs._onEditorRoute_() && editor.getContainerDomNode?.()?.isConnected) {
      this._hidden = false;
    }
    if (this._tryAttach_(editor)) { this._stopReadyTimer_(); return true; }
    this._waitForEditor_();
    return false;
  }

  /** Sincroniza ya con el árbol (sin debounce). */
  refresh() { this._sync_(); }

  /**
   * Cambia a la pestaña indicada mediante un clic sintético en el árbol.
   * @param {string} resId
   * @param {{focusEditor?:boolean}} [opts]
   * @returns {boolean} false si la pestaña no existe.
   */
  activate(resId, { focusEditor = false } = {}) {
    const tab = this._tab_(resId);
    if (!tab) return false;
    if (resId === this.activeResId && !this._pending) {
      this._revealActive_();
      if (focusEditor) this._editor?.focus?.();
      return true;
    }
    const tree = this._readTree_();
    this._clearPending_();
    this.activeResId = resId;
    this._focusResId = resId;
    this._render_();
    const item = tree.items.get(resId);
    if (item?.li) this._clickTreeItem_(item.li, resId);
    this._pending = {
      resId,
      focusEditor,
      treeAtStart: tree.selectedId,
      attempt: 1,
      timer: setTimeout(() => this._finishSwitch_(resId), GasFileTabs.SWITCH_FALLBACK_MS),
    };
    return true;
  }

  /**
   * Cierra una pestaña; si era la activa abre la vecina (derecha, luego izquierda).
   * Las pestañas con cambios sin guardar no se cierran (avisa con un toast).
   * @param {string} resId
   * @param {{silent?:boolean}} [opts]
   * @returns {boolean} false si no existe, es la última o tiene cambios.
   */
  closeTab(resId, { silent = false } = {}) {
    const idx = this._index_(resId);
    if (idx < 0 || this.tabs.length <= 1) return false;
    const tab = this.tabs[idx];
    if (this._tabDirty_(tab)) {
      if (!silent) {
        this._toast_(DomUtils.t('edTabsSaveBeforeClose', 'Save the changes to $1 before closing',
          GasFileTabs._splitName_(tab.name).base), 'warning');
      }
      return false;
    }
    let next = null;
    if (resId === this.activeResId) {
      // Vecina con li en el árbol (si no, no hay forma de abrirla y no se cierra).
      const items = this._readTree_().items;
      const order = [...this.tabs.slice(idx + 1), ...this.tabs.slice(0, idx).reverse()];
      next = order.find((t) => items.get(t.resId)?.li) || null;
      if (!next) return false;
    }
    this.tabs.splice(idx, 1);
    if (this._focusResId === resId) this._focusResId = null;
    if (next) {
      this.activeResId = null;
      this.activate(next.resId);
    } else {
      this._render_();
    }
    return true;
  }

  /**
   * Cierra todas salvo `resId` y las que tienen cambios sin guardar.
   * @param {string} resId
   * @returns {boolean} `true` si cerró alguna.
   */
  closeOthers(resId) {
    const tab = this._tab_(resId);
    if (!tab) return false;
    const kept = this.tabs.filter((t) => t === tab || this._tabDirty_(t));
    const removed = this.tabs.length - kept.length;
    this._toastKept_(kept.length - 1);
    if (!removed) return false;
    this.tabs = kept;
    this._focusResId = resId;
    if (this.activeResId !== resId) { this.activeResId = null; this.activate(resId); }
    else this._render_();
    return true;
  }

  /**
   * Cierra las pestañas a la derecha de `resId` (salvo las que tienen cambios).
   * @param {string} resId
   * @returns {boolean} `true` si cerró alguna.
   */
  closeToRight(resId) {
    const idx = this._index_(resId);
    if (idx < 0) return false;
    const right = this.tabs.slice(idx + 1);
    const keptRight = right.filter((t) => this._tabDirty_(t));
    const removed = right.filter((t) => !this._tabDirty_(t));
    this._toastKept_(keptRight.length);
    if (!removed.length) return false;
    this.tabs = [...this.tabs.slice(0, idx + 1), ...keptRight];
    if (removed.some((t) => t.resId === this._focusResId)) this._focusResId = resId;
    if (removed.some((t) => t.resId === this.activeResId)) { this.activeResId = null; this.activate(resId); }
    else this._render_();
    return true;
  }

  /**
   * Mueve una pestaña a otra posición.
   * @param {string} resId
   * @param {number} index Posición destino (se acota).
   * @returns {boolean}
   */
  moveTabTo(resId, index) {
    const from = this._index_(resId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.tabs.length - 1, index));
    if (to === from) return false;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this._render_();
    return true;
  }

  /**
   * Mueve una pestaña `delta` posiciones (sin dar la vuelta).
   * @param {string} resId
   * @param {number} delta
   * @returns {boolean}
   */
  moveTab(resId, delta) {
    return this.moveTabTo(resId, this._index_(resId) + delta);
  }

  /**
   * `true` si el archivo de la pestaña tiene cambios sin guardar.
   * @param {string} resId
   * @returns {boolean}
   */
  isDirty(resId) {
    return this._tabDirty_(this._tab_(resId));
  }

  // ── Editor ───────────────────────────────────────────────────────

  /** `true` si la URL es la vista del editor. @private */
  static _onEditorRoute_() {
    const path = (typeof window !== 'undefined' && window.location?.pathname) || '';
    return path.includes('/edit');
  }

  /** @private */
  _candidateEditor_() {
    const preferred = this._preferredEditor;
    if (preferred && !this._disposedEditors.has(preferred)) return preferred;
    const wired = window.jsWireMonacoEditor;
    if (wired && !this._disposedEditors.has(wired)) return wired;
    return null;
  }

  /** Polling ligero hasta que haya editor y Monaco. @private */
  _waitForEditor_() {
    this._stopReadyTimer_();
    if (this._tryAttach_()) return;
    this._readyTimer = setInterval(() => {
      if (!this._enabled) { this._stopReadyTimer_(); return; }
      if (this._tryAttach_()) this._stopReadyTimer_();
    }, GasFileTabs.READY_POLL_MS);
  }

  /** @private */
  _stopReadyTimer_() {
    if (this._readyTimer) { clearInterval(this._readyTimer); this._readyTimer = null; }
  }

  /**
   * Engancha `editor` (o el candidato) si Monaco está listo.
   * @param {object} [editor]
   * @returns {boolean}
   * @private
   */
  _tryAttach_(editor = this._candidateEditor_()) {
    if (!this._enabled || !editor || this._disposedEditors.has(editor)) return false;
    if (!window.monaco?.editor) return false;
    if (this._editor !== editor) this._attachEditor_(editor);
    this._startMonacoSubs_();
    this._observeTree_();
    this._startDocObserver_();
    this._sync_();
    this._scheduleBootSyncs_();
    return true;
  }

  /** Reintenta la sincronía inicial: GAS tarda en marcar el archivo abierto al cargar. @private */
  _scheduleBootSyncs_() {
    this._clearBootSyncs_();
    this._bootTimers = GasFileTabs.BOOT_SYNC_DELAYS_MS.map((ms) => setTimeout(() => this._sync_(), ms));
  }

  /** @private */
  _clearBootSyncs_() {
    this._bootTimers.forEach((t) => clearTimeout(t));
    this._bootTimers = [];
  }

  /**
   * Deduce el resId del modelo activo (pestaña asociada o nombre en `gasFileMap`).
   * La coincidencia sin extensión solo vale si es única.
   * @param {object} model Modelo de Monaco.
   * @param {Map<string,{name:string}>} items Items del árbol.
   * @returns {string|null}
   * @private
   */
  _resIdForModel_(model, items) {
    if (!model || model.isDisposed?.() || GasFileTabs._isPreviewModel_(model)) return null;
    const owner = this.tabs.find((t) => t.model === model && items.has(t.resId));
    if (owner) return owner.resId;
    const name = String(window.gasFileMap?.get?.(String(model.uri)) || '').trim();
    if (!name) return null;
    const lower = name.toLowerCase();
    const loose = [];
    for (const [resId, item] of items) {
      const n = String(item.name || '');
      if (n === name || n.toLowerCase() === lower) return resId;
      if (GasFileTabs._stripExt_(n) === GasFileTabs._stripExt_(name)) loose.push(resId);
    }
    return loose.length === 1 ? loose[0] : null;
  }

  /** Nombre en minúsculas sin extensión de GAS. @private */
  static _stripExt_(name) {
    return String(name || '').toLowerCase().replace(/\.(gs|js|html|json)$/i, '');
  }

  /** @private */
  _attachEditor_(editor) {
    this._detachEditor_();
    this._editor = editor;
    const keep = (d) => { if (d && typeof d.dispose === 'function') this._editorSubs.push(d); };
    keep(editor.onDidChangeModel?.((e) => this._onModelChange_(e)));
    keep(editor.onDidDispose?.(() => {
      this._disposedEditors.add(editor);
      if (this._preferredEditor === editor) this._preferredEditor = null;
      if (this._editor !== editor) return;
      this._unmount_();
      this._detachEditor_();
      if (this._enabled) this._waitForEditor_();
    }));
  }

  /** @private */
  _detachEditor_() {
    this._editorSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ya liberado */ } });
    this._editorSubs = [];
    this._clearPending_();
    this._clearBootSyncs_();
    this._provisionalResId = null;
    this._provisionalModel = null;
    this._editor = null;
  }

  /** Suscripciones globales a modelos (una vez por `enable`). @private */
  _startMonacoSubs_() {
    if (this._monacoSubs.length) return;
    const me = window.monaco?.editor;
    const keep = (d) => { if (d && typeof d.dispose === 'function') this._monacoSubs.push(d); };
    keep(me?.onDidCreateModel?.((model) => this._watchModel_(model)));
    keep(me?.onWillDisposeModel?.((model) => this._unwatchModel_(model)));
    (me?.getModels?.() || []).forEach((model) => this._watchModel_(model));
  }

  /** @private */
  _onModelChange_(e) {
    if (window.gasDiffPreview?._switching) return;
    const model = this._editor?.getModel?.();
    if (GasFileTabs._isPreviewModel_(model) || e?.newModelUrl?.scheme === 'gas-preview' || e?.newModelUrl?.scheme === 'gas-ghdiff') return;
    this._scheduleSync_();
  }

  /** `true` si el modelo es temporal de la vista previa (`gas-preview:`). @private */
  static _isPreviewModel_(model) {
    return model?.uri?.scheme === 'gas-preview' || model?.uri?.scheme === 'gas-ghdiff';
  }

  // ── Árbol de GAS ─────────────────────────────────────────────────

  /** `c-wiz` activa (mismo criterio que gas-folders) o `document`. @private */
  _scope_() {
    const containers = document.querySelectorAll('c-wiz[data-p]');
    if (containers.length === 1 && containers[0].getAttribute('aria-hidden') !== 'true') return containers[0];
    return document.querySelector('c-wiz[data-p][aria-busy="false"]:not([aria-hidden="true"])')
      || document.querySelector('c-wiz[data-p]:not([aria-hidden="true"]):not([aria-busy="true"])')
      || document;
  }

  /**
   * Lee el árbol: items por resId, el seleccionado y el indicador nativo de cambios.
   * @returns {{items: Map<string,{li:Element,name:string,renaming:boolean,dirty:boolean,dirtyNode:(Element|null)}>,
   *   selectedId: (string|null), dirtyNode: (Element|null)}}
   * @private
   */
  _readTree_() {
    const scope = this._scope_();
    let lis = Array.from(scope.querySelectorAll(GasFileTabs.TREE_ITEM_SELECTOR));
    if (!lis.length && scope !== document) lis = Array.from(document.querySelectorAll(GasFileTabs.TREE_ITEM_SELECTOR));
    // En el respaldo a `document` se descartan árboles de paneles ocultos.
    if (scope === document || !scope.contains?.(lis[0])) lis = lis.filter((li) => !li.closest?.('[aria-hidden="true"]'));
    const dirtySel = GasFileTabs.DIRTY_SELECTOR;
    const items = new Map();
    let selectedId = null;
    let dirtyNode = null;
    for (const li of lis) {
      const resId = li.getAttribute('data-res-id');
      if (!resId || items.has(resId)) continue;
      const name = li.querySelector('div[title]')?.getAttribute('title')?.trim()
        || li.getAttribute('aria-label')?.trim() || '';
      const node = dirtySel ? GasFileTabs._visibleNode_(li.querySelector(dirtySel)) : null;
      if (node && !dirtyNode) dirtyNode = node;
      items.set(resId, { li, name, renaming: !!li.querySelector('input'), dirty: !!node });
      if (li.getAttribute('aria-selected') === 'true') selectedId = resId;
    }
    return { items, selectedId, dirtyNode };
  }

  /**
   * Clic sintético en el `li` (comprobando que sigue conectado y es el mismo
   * archivo). `strong` añade eventos de puntero y repite sobre `div[title]`.
   * @private
   */
  _clickTreeItem_(li, resId, { strong = false } = {}) {
    if (!li?.isConnected || li.getAttribute('data-res-id') !== resId) return false;
    const view = typeof window !== 'undefined' ? window : undefined;
    const types = strong
      ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
      : ['mousedown', 'mouseup', 'click'];
    const targets = strong ? [li.querySelector('div[title]'), li].filter(Boolean) : [li];
    for (const target of targets) {
      for (const type of types) {
        try {
          const init = { bubbles: true, cancelable: true, composed: true, view, button: 0 };
          let ev = null;
          if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
            ev = new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true });
          } else if (typeof MouseEvent === 'function') {
            ev = new MouseEvent(type, init);
          }
          if (ev) target.dispatchEvent(ev);
        } catch (_) { /* nodo desconectado */ }
      }
    }
    return true;
  }

  /**
   * Cierra un intento de cambio: si el árbol ya marca la pestaña, alinea el
   * modelo; si no, reintenta una vez con un clic más fuerte y, si tampoco,
   * avisa y deja que mande el árbol (sin `setModel` a espaldas de GAS).
   * @private
   */
  _finishSwitch_(resId) {
    const pending = this._pending;
    if (!pending || pending.resId !== resId) return;
    const tab = this._tab_(resId);
    const tree = this._readTree_();
    if (!tab || !this._editor) { this._pending = null; this._sync_(); return; }
    if (tree.selectedId === resId) {
      this._pending = null;
      // GAS cree que este archivo está abierto, pero el editor muestra otro.
      const model = this._modelForTab_(tab);
      const current = this._editor.getModel?.();
      if (model && current !== model && !GasFileTabs._isPreviewModel_(current) && !window.gasDiffPreview?._switching) {
        try { this._editor.setModel(model); } catch (err) { console.warn('[GasFileTabs] setModel falló:', err); }
      }
      if (pending.focusEditor) this._editor.focus?.();
      this._sync_();
      return;
    }
    const item = tree.items.get(resId);
    if (pending.attempt === 1 && item?.li && this._clickTreeItem_(item.li, resId, { strong: true })) {
      pending.attempt = 2;
      pending.timer = setTimeout(() => this._finishSwitch_(resId), GasFileTabs.SWITCH_FALLBACK_MS);
      return;
    }
    this._pending = null;
    this._toast_(DomUtils.t('edTabsOpenFailed', "Couldn't open $1 in the editor",
      GasFileTabs._splitName_(tab.name).base), 'error');
    this._sync_();
  }

  /** @private */
  _clearPending_() {
    if (this._pending?.timer) clearTimeout(this._pending.timer);
    this._pending = null;
  }

  /**
   * Modelo de una pestaña: el asociado o, si no, por nombre (`gasFileMap`);
   * la coincidencia sin extensión solo si es única.
   * @private
   */
  _modelForTab_(tab) {
    if (tab.model && !tab.model.isDisposed?.()) return tab.model;
    const wanted = String(tab.name || '').trim();
    if (!wanted) return null;
    const names = window.gasFileMap;
    const entries = (window.monaco?.editor?.getModels?.() || [])
      .filter((m) => m && !m.isDisposed?.() && !GasFileTabs._isPreviewModel_(m))
      .map((m) => ({ m, n: String(names?.get?.(String(m.uri)) || '') }))
      .filter((e) => e.n);
    const lower = wanted.toLowerCase();
    const exact = entries.find((e) => e.n === wanted) || entries.find((e) => e.n.toLowerCase() === lower);
    if (exact) return exact.m;
    const loose = entries.filter((e) => GasFileTabs._stripExt_(e.n) === GasFileTabs._stripExt_(wanted));
    return loose.length === 1 ? loose[0].m : null;
  }

  // ── Sincronía ────────────────────────────────────────────────────

  /** @private */
  _scheduleSync_(delay = GasFileTabs.SYNC_DELAY_MS) {
    if (!this._enabled) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._sync_(), delay);
  }

  /** Reconcilia pestañas con el árbol y el editor. @private */
  _sync_() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    if (!this._enabled || !this._editor) return;
    const tree = this._readTree_();
    // Árbol vacío = GAS re-renderizando: no se toca nada.
    if (!tree.items.size) return;
    let changed = this._ensureMounted_();
    if (tree.dirtyNode) {
      this._nativeDirty = true;
      this._syncDirtyColor_(tree.dirtyNode);
    }
    const now = Date.now();
    let waiting = false;
    this.tabs = this.tabs.filter((tab) => {
      const item = tree.items.get(tab.resId);
      if (item) {
        this._missingSince.delete(tab.resId);
        if (!item.renaming && item.name && item.name !== tab.name) { tab.name = item.name; changed = true; }
        if (!!tab.nativeDirty !== item.dirty) { tab.nativeDirty = item.dirty; changed = true; }
        return true;
      }
      const since = this._missingSince.get(tab.resId) ?? now;
      this._missingSince.set(tab.resId, since);
      if (now - since >= GasFileTabs.DELETE_GRACE_MS) {
        this._missingSince.delete(tab.resId);
        if (this._focusResId === tab.resId) this._focusResId = null;
        changed = true;
        return false;
      }
      waiting = true;
      return true;
    });
    if (waiting && !this._graceTimer) {
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null;
        this._sync_();
      }, GasFileTabs.DELETE_GRACE_MS + 20);
    }

    const model = this._editor.getModel?.();
    let active = tree.selectedId;
    if (active) {
      // El árbol ya marca selección. La deducción inicial solo se descarta si el editor
      // sigue en el mismo modelo (GAS marcó tarde otro archivo = el mapeo falló). Si el
      // modelo cambió, el usuario abrió otro archivo y la pestaña inicial era correcta.
      const prov = this._provisionalResId;
      const provModel = this._provisionalModel;
      this._provisionalResId = null;
      this._provisionalModel = null;
      const wrongGuess = prov && prov !== active && model && model === provModel
        && this.tabs.length === 1 && this.tabs[0].resId === prov
        && !this._tabDirty_(this.tabs[0]);
      if (wrongGuess) {
        this.tabs = [];
        changed = true;
      }
    } else if (!this._pending) {
      // Al cargar, GAS abre un archivo sin marcarlo aún en el árbol: se deduce del modelo.
      const guessed = this._resIdForModel_(model, tree.items);
      if (guessed) {
        active = guessed;
        if (!this._tab_(guessed)) {
          this._provisionalResId = guessed;
          this._provisionalModel = model;
        }
      }
    }
    if (this._pending) {
      const pending = this._pending;
      if (active === pending.resId) {
        this._clearPending_();
        if (pending.focusEditor) this._editor.focus?.();
      } else if (tree.selectedId && tree.selectedId !== pending.treeAtStart) {
        // El usuario eligió otro archivo en el árbol durante la espera: manda el árbol.
        this._clearPending_();
      } else {
        active = pending.resId;
      }
    }

    if (active && tree.items.has(active) && !this._tab_(active)) {
      const at = this._index_(this.activeResId);
      const item = tree.items.get(active);
      const tab = { resId: active, name: item.name, model: null, nativeDirty: item.dirty };
      if (at >= 0) this.tabs.splice(at + 1, 0, tab);
      else this.tabs.push(tab);
      changed = true;
    }
    if (active && this._tab_(active)) {
      if (this.activeResId !== active) { this.activeResId = active; changed = true; }
    } else if (!this._tab_(this.activeResId)) {
      const fallback = this.tabs[0]?.resId ?? null;
      if (fallback !== this.activeResId) { this.activeResId = fallback; changed = true; }
    }

    const canAssociate = model && !model.isDisposed?.() && !GasFileTabs._isPreviewModel_(model)
      && !window.gasDiffPreview?._switching && !this._pending;
    if (canAssociate) {
      const tab = this._tab_(this.activeResId);
      // Cada archivo tiene un modelo estable: nunca se le quita a otra pestaña.
      const owned = this.tabs.some((t) => t !== tab && t.model === model);
      if (tab && tab.model !== model && !owned) { this._associate_(tab, model); changed = true; }
    }

    if (changed) this._render_();
  }

  /** Asocia un modelo a una pestaña. @private */
  _associate_(tab, model) {
    tab.model = model;
    this._watchModel_(model);
  }

  // ── Sin guardar ──────────────────────────────────────────────────

  /** `true` si la pestaña tiene cambios (árbol nativo o versiones). @private */
  _tabDirty_(tab) {
    if (!tab) return false;
    if (this._nativeDirty) return !!tab.nativeDirty;
    return !!(tab.model && this._dirtyModels.has(tab.model));
  }

  /**
   * Devuelve el nodo solo si se ve (GAS puede ocultar el indicador en vez de quitarlo).
   * @param {Element|null} node
   * @returns {Element|null}
   * @private
   */
  static _visibleNode_(node) {
    if (!node || typeof getComputedStyle !== 'function') return node || null;
    for (let n = node; n && n.tagName !== 'LI'; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs?.display === 'none' || cs?.visibility === 'hidden') return null;
    }
    return node;
  }

  /** Copia el color visible del indicador nativo a `--tab-dirty-color`. @private */
  _syncDirtyColor_(node) {
    if (!this._host || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(node);
    const transparent = (c) => !c || c === 'transparent' || c === 'none' || /rgba\([^)]*,\s*0\)$/.test(c);
    // En el SVG nativo el color va en el `fill` del círculo exterior.
    const fill = node.querySelector?.('circle[fill]')?.getAttribute('fill') || node.getAttribute?.('fill');
    const color = [fill, cs?.backgroundColor, cs?.color].find((c) => !transparent(c));
    if (!color) return;
    const visible = GasFileTabs._invertParity_(node) ? GasFileTabs._invertColor_(color) : color;
    this._host.style.setProperty('--tab-dirty-color', visible);
  }

  /** `true` si un número impar de ancestros invierte colores. @private */
  static _invertParity_(node) {
    let inverted = 0;
    for (let n = node; n && n !== document.documentElement; n = n.parentElement) {
      if (/invert\(\s*(1|100%)/.test(getComputedStyle(n)?.filter || '')) inverted++;
    }
    return inverted % 2 === 1;
  }

  /** Invierte un color `rgb()/rgba()` (lo que muestra un ancestro con `invert(1)`). @private */
  static _invertColor_(color) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
      color = `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
    }
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(color);
    if (!m) return color;
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => 255 - Number(v));
    return m[4] !== undefined ? `rgba(${r}, ${g}, ${b}, ${m[4]})` : `rgb(${r}, ${g}, ${b})`;
  }

  /** @private */
  static _versionOf_(model) {
    try {
      return typeof model.getAlternativeVersionId === 'function'
        ? model.getAlternativeVersionId()
        : model.getVersionId?.();
    } catch (_) { return undefined; }
  }

  /** @private */
  _watchModel_(model) {
    if (!model || this._modelSubs.has(model) || GasFileTabs._isPreviewModel_(model)) return;
    if (model.isDisposed?.()) return;
    if (!this._baselines.has(model)) this._baselines.set(model, GasFileTabs._versionOf_(model));
    const sub = model.onDidChangeContent?.(() => this._onContentChange_(model));
    if (sub && typeof sub.dispose === 'function') this._modelSubs.set(model, sub);
  }

  /** @private */
  _unwatchModel_(model) {
    try { this._modelSubs.get(model)?.dispose(); } catch (_) { /* ya liberado */ }
    this._modelSubs.delete(model);
    this._dirtyModels.delete(model);
    for (const tab of this.tabs) if (tab.model === model) tab.model = null;
  }

  /** @private */
  _onContentChange_(model) {
    if (!this._enabled || window.gasDiffPreview?._switching) return;
    const dirty = GasFileTabs._versionOf_(model) !== this._baselines.get(model);
    if (dirty === this._dirtyModels.has(model)) return;
    if (dirty) this._dirtyModels.add(model);
    else this._dirtyModels.delete(model);
    if (!this._nativeDirty) this._render_();
  }

  /** Ctrl/Cmd+S (también el sintético de `_saveProject_`): fija las versiones guardadas. @private */
  _onKeyCapture(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key !== 's' && e.key !== 'S' && e.code !== 'KeyS') return;
    if (this._nativeDirty) return;
    // Lo escrito durante la espera no debe quedar absorbido en la línea base.
    this._saveSnapshot = new Map();
    for (const model of this._modelSubs.keys()) {
      if (!model.isDisposed?.()) this._saveSnapshot.set(model, GasFileTabs._versionOf_(model));
    }
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._resetBaselines_(), GasFileTabs.SAVE_SETTLE_MS);
  }

  /** @private */
  _resetBaselines_() {
    this._saveTimer = null;
    const snapshot = this._saveSnapshot || new Map();
    this._saveSnapshot = null;
    let changed = false;
    for (const [model, version] of snapshot) {
      if (model.isDisposed?.()) continue;
      this._baselines.set(model, version);
      const dirty = GasFileTabs._versionOf_(model) !== version;
      if (dirty !== this._dirtyModels.has(model)) {
        changed = true;
        if (dirty) this._dirtyModels.add(model);
        else this._dirtyModels.delete(model);
      }
    }
    if (changed && !this._nativeDirty) this._render_();
  }

  // ── Observers ────────────────────────────────────────────────────

  /** Observa los `ul[role="listbox"]` del árbol activo. @private */
  _observeTree_() {
    if (typeof MutationObserver === 'undefined') return;
    const scope = this._scope_();
    const collect = (root) => Array.from(root.querySelectorAll(GasFileTabs.TREE_LIST_SELECTOR))
      .filter((ul) => ul.querySelector('li[role="option"]'));
    let lists = collect(scope);
    if (!lists.length && scope !== document) lists = collect(document);
    const same = lists.length === this._lists.length && lists.every((ul, i) => ul === this._lists[i]);
    if (same && this._treeObserver) return;
    this._treeObserver?.disconnect();
    this._lists = lists;
    this._treeObserver = new MutationObserver(() => this._scheduleSync_());
    const attributeFilter = ['aria-selected', 'title', 'data-res-id'];
    // El indicador nativo puede alternarse por clase (el childList ya cubre altas y bajas).
    if (GasFileTabs.DIRTY_SELECTOR) attributeFilter.push('class');
    lists.forEach((ul) => this._treeObserver.observe(ul, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter,
    }));
  }

  /** Detecta reemplazos del árbol/editor (throttle; O(1) con chequeo pendiente). @private */
  _startDocObserver_() {
    if (this._docObserver || typeof MutationObserver === 'undefined' || !document.body) return;
    this._docObserver = new MutationObserver((mutations) => {
      if (!this._enabled || this._docCheckTimer) return;
      const external = mutations.some((m) => {
        const el = m.target;
        if (!el?.closest) return false;
        return !el.closest('.monaco-editor') && !el.closest(GasFileTabs.OWN_HOSTS_SELECTOR);
      });
      if (!external) return;
      this._docCheckTimer = setTimeout(() => this._checkDom_(), GasFileTabs.DOC_CHECK_THROTTLE_MS);
    });
    this._docObserver.observe(document.body, { childList: true, subtree: true });
    // Cambio de modo oscuro: recalcula la contra-inversión.
    this._bodyObserver = new MutationObserver(() => this._syncInversion_());
    this._bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /** @private */
  _checkDom_() {
    this._docCheckTimer = null;
    if (!this._enabled) return;
    this._observeTree_();
    this._scheduleSync_(0);
  }

  /** @private */
  _onHidePanels() {
    this._hidden = true;
    this._closeMenu_();
    if (this._host) { this._applyHidden_(); this._layoutEditor_(); }
  }

  /** @private */
  _onReturn() {
    this._hidden = false;
    if (this._host) { this._applyHidden_(); this._layoutEditor_(this._fitPending); }
    clearTimeout(this._docCheckTimer);
    this._docCheckTimer = setTimeout(() => this._checkDom_(), 300);
  }

  // ── Montaje ──────────────────────────────────────────────────────

  /**
   * Ancla: el ancestro más externo del editor que casa con `editorArea`
   * (el que invierte el modo oscuro), sin subir hasta el árbol de archivos.
   * @returns {Element|null}
   * @private
   */
  _resolveAnchor_() {
    const container = this._editor?.getContainerDomNode?.();
    if (!container?.isConnected) return null;
    const sel = (typeof GasCustomEditor !== 'undefined' && GasCustomEditor.IDE_SELECTORS?.editorArea)
      || GasFileTabs.DEFAULT_EDITOR_AREA;
    let outer = null;
    for (let node = container; node && node !== document.body; node = node.parentElement) {
      if (node !== container && node.querySelector?.(GasFileTabs.TREE_LIST_SELECTOR)) break;
      if (node.matches?.('c-wiz')) break;
      if (node.matches?.(sel)) outer = node;
    }
    return outer || container;
  }

  /**
   * Inserta (o recoloca) la barra justo antes del ancla.
   * @returns {boolean} `true` si la barra se (re)insertó y hay que pintarla.
   * @private
   */
  _ensureMounted_() {
    const anchor = this._resolveAnchor_();
    const parent = anchor?.parentNode;
    if (!parent) return false;
    if (!this._host) this._createHost_();
    let inserted = false;
    if (this._host.parentNode !== parent || this._host.nextSibling !== anchor) {
      parent.insertBefore(this._host, anchor);
      this._lastHtml = '';
      inserted = true;
    }
    if (this._anchor !== anchor) {
      this._restoreAnchor_();
      this._anchor = anchor;
      this._observeResize_(anchor);
      this._syncInversion_();
      this._layoutEditor_(true);
    }
    this._applyHidden_();
    return inserted;
  }

  /** `display:none` fuera de la vista del editor (el atributo `hidden` no gana al estilo inline). @private */
  _applyHidden_() {
    if (this._host) this._host.style.display = this._hidden ? 'none' : 'block';
  }

  /** @private */
  _createHost_() {
    const host = document.createElement('div');
    host.id = GasFileTabs.HOST_ID;
    host.className = 'qc__file-tabs-host';
    host.style.display = 'block';
    host.style.flex = '0 0 auto';
    host.style.position = 'relative';
    const root = host.attachShadow({ mode: 'open' });
    GasUi.adopt(root, GasFileTabs.CSS);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-orientation', 'horizontal');
    bar.setAttribute('aria-label', DomUtils.t('edTabsLabel', 'Open files'));
    bar.addEventListener('click', this._onBarClick);
    bar.addEventListener('mousedown', this._onBarMouseDown);
    bar.addEventListener('auxclick', this._onBarAuxClick);
    bar.addEventListener('contextmenu', this._onBarContext);
    bar.addEventListener('keydown', this._onBarKeyDown);
    bar.addEventListener('wheel', this._onBarWheel, { passive: false });
    bar.addEventListener('dragstart', this._onDragStart);
    bar.addEventListener('dragover', this._onDragOver);
    bar.addEventListener('dragleave', this._onDragLeave);
    bar.addEventListener('drop', this._onDrop);
    bar.addEventListener('scroll', this._onBarScroll, { passive: true });
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', this._onMoreClick);
    wrap.appendChild(bar);
    wrap.appendChild(more);
    root.appendChild(wrap);
    this._host = host;
    this._root = root;
    this._bar = bar;
    this._more = more;
    if (typeof ResizeObserver === 'function') {
      this._barResizeObserver = new ResizeObserver(() => this._scheduleOverflow_());
      this._barResizeObserver.observe(bar);
    }
    // GAS puede desbordar el editor fuera de la ventana: el ancho visible cambia con ella.
    window.addEventListener('resize', this._onWindowResize);
    // Los scroll no burbujean: en captura se ve el del contenedor de GAS que envuelve la barra.
    document.addEventListener('scroll', this._onAncestorScroll, true);
  }

  /** @private */
  _onAncestorScroll(e) {
    const target = e.target;
    if (target && target !== document && target.contains?.(this._host)) this._resetAncestorScroll_();
  }

  /**
   * GAS recorta el área del editor con overflow oculto; cuando Monaco toma el foco
   * el navegador la desplaza y la barra queda medio tapada. Se devuelve a 0.
   * @private
   */
  _resetAncestorScroll_() {
    if (!this._host || typeof getComputedStyle !== 'function') return;
    for (let n = this._host.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (!n.scrollTop) continue;
      const oy = getComputedStyle(n)?.overflowY;
      if (oy === 'hidden' || oy === 'clip') n.scrollTop = 0;
    }
  }

  /** @private */
  _onWindowResize() {
    this._scheduleOverflow_();
    this._layoutEditor_(true);
  }

  /**
   * Limita el ancho del host a lo que se ve (viewport y ancestros que recortan),
   * para que el desbordamiento y el botón de la lista respondan a la pantalla real.
   * @private
   */
  _fitVisibleWidth_() {
    const host = this._host;
    const anchor = this._anchor;
    if (!host || !anchor?.isConnected || typeof getComputedStyle !== 'function') return;
    // Referencia = el editor (el padre de GAS puede ajustarse al contenido de la barra).
    const a = anchor.getBoundingClientRect();
    if (!a || a.width <= 0) return;
    let right = Math.min(a.right, document.documentElement?.clientWidth || window.innerWidth || a.right);
    for (let n = anchor.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const ox = getComputedStyle(n)?.overflowX;
      if (ox && ox !== 'visible') right = Math.min(right, n.getBoundingClientRect().right);
    }
    const width = Math.floor(right - a.left);
    const value = width > 0 ? `${width}px` : '';
    if (host.style.width === value) return;
    host.style.width = value;
    host.style.maxWidth = '';
  }

  /** ResizeObserver del contenedor → `editor.layout()`. @private */
  _observeResize_(anchor) {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    const target = anchor.parentElement || anchor;
    if (typeof ResizeObserver !== 'function') return;
    this._resizeObserver = new ResizeObserver(() => {
      this._layoutEditor_(true);
      this._scheduleOverflow_();
    });
    this._resizeObserver.observe(target);
    // El editor cambia de ancho al plegar el panel de archivos sin que cambie su padre.
    if (target !== anchor) this._resizeObserver.observe(anchor);
  }

  /** `requestAnimationFrame` con respaldo. @private */
  static _raf_(fn) {
    return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
  }

  /** @private */
  static _caf_(id) {
    if (!id) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  /**
   * Reajusta Monaco en el siguiente frame. Con `fit`, ajusta antes el ancla
   * (un frame pendiente no se pisa: solo se le suma el ajuste).
   * @private
   */
  _layoutEditor_(fit = false) {
    if (fit) this._layoutFit = true;
    if (this._layoutFrame) return;
    this._layoutFrame = GasFileTabs._raf_(() => {
      this._layoutFrame = 0;
      const doFit = this._layoutFit;
      this._layoutFit = false;
      if (doFit) this._fitAnchor_();
      try { this._editor?.layout?.(); } catch (_) { /* editor liberado */ }
      this._resetAncestorScroll_();
    });
  }

  /**
   * Si la barra empuja el ancla fuera de su padre, le resta su alto; si el
   * ancla es absolute/fixed, la desplaza hacia abajo. Reintenta si aún no hay layout.
   * @private
   */
  _fitAnchor_() {
    const anchor = this._anchor;
    const parent = anchor?.parentElement;
    if (!anchor || !parent || !this._host) return;
    const hostRect = this._host.getBoundingClientRect?.();
    const barHeight = hostRect?.height || 0;
    if (this._hidden || !barHeight) { this._fitPending = true; return; }
    this._fitPending = false;
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(anchor) : null;
    if (cs && (cs.position === 'absolute' || cs.position === 'fixed')) {
      // Se mide la distancia real barra→editor (GAS recoloca el ancla al redimensionar),
      // así no se acumula desplazamiento ni queda hueco.
      if (!this._anchorStyle) this._anchorStyle = { top: anchor.style.top || '' };
      const delta = (anchor.getBoundingClientRect?.().top ?? 0) - hostRect.bottom;
      if (Math.abs(delta) > 1) anchor.style.top = `${Math.round((parseFloat(cs.top) || 0) - delta)}px`;
      return;
    }
    if (this._anchorStyle) return;
    const a = anchor.getBoundingClientRect?.();
    const p = parent.getBoundingClientRect?.();
    if (!a || !p || a.bottom - p.bottom <= 1) return;
    this._anchorStyle = { height: anchor.style.height || '' };
    anchor.style.height = `calc(100% - ${Math.round(barHeight)}px)`;
  }

  /** @private */
  _restoreAnchor_() {
    const saved = this._anchorStyle;
    if (this._anchor && saved) {
      if ('height' in saved) this._anchor.style.height = saved.height;
      if ('top' in saved) this._anchor.style.top = saved.top;
    }
    this._anchorStyle = null;
    this._fitPending = false;
  }

  /**
   * Si un ancestro invierte colores (modo oscuro del IDE), contra-invierte la barra.
   * @private
   */
  _syncInversion_() {
    const host = this._host;
    if (!host?.isConnected || typeof getComputedStyle !== 'function') return;
    host.style.filter = host.parentElement && GasFileTabs._invertParity_(host.parentElement) ? 'invert(1)' : '';
  }

  /** @private */
  _unmount_() {
    this._closeMenu_();
    GasFileTabs._caf_(this._layoutFrame);
    GasFileTabs._caf_(this._overflowFrame);
    this._layoutFrame = this._overflowFrame = 0;
    this._layoutFit = false;
    this._resizeObserver?.disconnect();
    this._barResizeObserver?.disconnect();
    this._resizeObserver = this._barResizeObserver = null;
    window.removeEventListener('resize', this._onWindowResize);
    document.removeEventListener('scroll', this._onAncestorScroll, true);
    this._restoreAnchor_();
    this._anchor = null;
    if (this._host) {
      this._host.remove();
      try { this._editor?.layout?.(); } catch (_) { /* editor liberado */ }
    }
    this._host = null;
    this._root = null;
    this._bar = null;
    this._more = null;
    this._lastHtml = '';
  }

  /** @private */
  _teardown_() {
    this._stopReadyTimer_();
    clearTimeout(this._syncTimer);
    clearTimeout(this._docCheckTimer);
    clearTimeout(this._saveTimer);
    clearTimeout(this._graceTimer);
    this._syncTimer = this._docCheckTimer = this._saveTimer = this._graceTimer = null;
    this._treeObserver?.disconnect();
    this._docObserver?.disconnect();
    this._bodyObserver?.disconnect();
    this._treeObserver = this._docObserver = this._bodyObserver = null;
    this._lists = [];
    this._onDragEnd();
    this._unmount_();
    this._detachEditor_();
    this._monacoSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ya liberado */ } });
    this._monacoSubs = [];
    this._modelSubs.forEach((d) => { try { d.dispose(); } catch (_) { /* ya liberado */ } });
    this._modelSubs.clear();
    this._dirtyModels.clear();
    this._baselines = new WeakMap();
    this._saveSnapshot = null;
    this._nativeDirty = false;
    this._missingSince.clear();
    this.tabs = [];
    this.activeResId = null;
    this._focusResId = null;
  }

  // ── Render ───────────────────────────────────────────────────────

  /** Nombre base y carpeta de una ruta `a/b/Archivo.gs`. @private */
  static _splitName_(name) {
    const parts = String(name || '').split('/');
    const base = parts.pop() || '';
    return { base, folder: parts.join('/') };
  }

  /** Pistas de carpeta para nombres base repetidos (`/` en la raíz). @private */
  _hints_() {
    const counts = new Map();
    for (const tab of this.tabs) {
      const key = GasFileTabs._splitName_(tab.name).base.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const hints = new Map();
    for (const tab of this.tabs) {
      const { base, folder } = GasFileTabs._splitName_(tab.name);
      if (counts.get(base.toLowerCase()) > 1) hints.set(tab.resId, folder || '/');
    }
    return hints;
  }

  /** @private */
  static _iconFor_(base) {
    return /\.json$/i.test(base) ? 'file' : 'code';
  }

  /**
   * Icono del archivo: el mismo SVG de color del árbol (`gasFolders`) o el genérico.
   * @param {string} base Nombre base del archivo.
   * @returns {string} HTML del SVG.
   * @private
   */
  static _fileIconHtml_(base) {
    const folders = window.gasFolders;
    if (typeof folders?._renderFileSvg_ === 'function') {
      const ext = String(base || '').split('.').pop().toLowerCase();
      const type = (ext === 'gs' || ext === 'html' || ext === 'json') ? ext : 'generic';
      try {
        const svg = folders._renderFileSvg_(type);
        if (typeof svg === 'string' && svg.trim().startsWith('<svg')
            && !/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(svg)) return svg;
      } catch (_) { /* respaldo genérico */ }
    }
    return GasUi.icon(GasFileTabs._iconFor_(base), 14);
  }

  /** Texto del tooltip del ●. @private */
  _unsavedTitle_() {
    return this._nativeDirty
      ? DomUtils.t('edTabsUnsavedExact', 'Unsaved changes')
      : DomUtils.t('edTabsUnsaved', 'Unsaved changes (approximate)');
  }

  /** @private */
  _render_() {
    if (!this._bar) return;
    // Repintar durante un arrastre rompería el drag nativo.
    if (this._drag) { this._renderDeferred = true; return; }
    const esc = DomUtils.escapeHtml;
    const hints = this._hints_();
    const closable = this.tabs.length > 1;
    const focusId = this._tab_(this._focusResId) ? this._focusResId : this.activeResId;
    const unsaved = this._unsavedTitle_();
    const closeHint = DomUtils.t('edTabsCloseHint', 'Close (middle-click)');
    const html = this.tabs.map((tab) => {
      const { base } = GasFileTabs._splitName_(tab.name);
      const active = tab.resId === this.activeResId;
      const dirty = this._tabDirty_(tab);
      const hint = hints.get(tab.resId);
      const label = dirty ? DomUtils.t('edTabsUnsavedAria', '$1, unsaved changes', tab.name) : tab.name;
      const cls = `tab${active ? ' is-active' : ''}${dirty ? ' is-dirty' : ''}`;
      return `<div class="${cls}" role="tab" draggable="true" data-res-id="${esc(tab.resId)}"`
        + ` aria-selected="${active}" tabindex="${tab.resId === focusId ? 0 : -1}"`
        + ` title="${esc(tab.name)}" aria-label="${esc(label)}">`
        + `<span class="tab__icon">${GasFileTabs._fileIconHtml_(base)}</span>`
        + `<span class="tab__label">${esc(base)}</span>`
        + (hint ? `<span class="tab__hint">${esc(hint)}</span>` : '')
        + '<span class="tab__end">'
        + (dirty ? `<span class="tab__dot" title="${esc(unsaved)}"></span>` : '')
        + (closable && !dirty
          ? `<span class="tab__close" aria-hidden="true" title="${esc(closeHint)}">${GasUi.icon('close', 14)}</span>`
          : '')
        + '</span></div>';
    }).join('');
    if (html === this._lastHtml) return;
    const hadFocus = !!this._root?.activeElement;
    this._lastHtml = html;
    DomUtils.setHTML(this._bar, html);
    if (hadFocus) this._tabEl_(focusId)?.focus?.();
    this._revealActive_();
    this._scheduleOverflow_();
    if (this._menu?.kind === 'list') this._renderList_();
  }

  /** Desplaza la barra hasta una pestaña (por defecto la activa). @private */
  _revealActive_(resId = this.activeResId) {
    const el = this._tabEl_(resId);
    if (!el?.scrollIntoView) return;
    this._programmaticScrollAt = Date.now();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) { /* sin layout */ }
  }

  /** @private */
  _tabEl_(resId) {
    if (!resId || !this._bar) return null;
    for (const el of this._bar.querySelectorAll('.tab')) {
      if (el.getAttribute('data-res-id') === resId) return el;
    }
    return null;
  }

  /** @private */
  _tab_(resId) { return resId ? this.tabs.find((t) => t.resId === resId) || null : null; }

  /** @private */
  _index_(resId) { return this.tabs.findIndex((t) => t.resId === resId); }

  /** @private */
  static _tabFromEvent_(e) {
    const el = e.target?.closest?.('.tab');
    return el ? { el, resId: el.getAttribute('data-res-id') } : null;
  }

  /** @private */
  _toast_(text, kind = 'info') {
    try { GasUi.toast?.(document, { text, kind, durationMs: 3000 }); } catch (_) { /* sin toast */ }
  }

  /** Aviso de pestañas con cambios que no se cerraron. @private */
  _toastKept_(count) {
    if (count <= 0) return;
    this._toast_(count === 1
      ? DomUtils.t('edTabsKeptUnsavedOne', 'A tab with unsaved changes stayed open')
      : DomUtils.t('edTabsKeptUnsavedMany', '$1 tabs with unsaved changes stayed open', count), 'warning');
  }

  // ── Desbordamiento y lista de pestañas ───────────────────────────

  /** @private */
  _scheduleOverflow_() {
    if (this._overflowFrame || !this._bar) return;
    this._overflowFrame = GasFileTabs._raf_(() => {
      this._overflowFrame = 0;
      this._updateOverflow_();
    });
  }

  /**
   * Pestañas que no se ven enteras en la barra.
   * @returns {Set<string>}
   * @private
   */
  _hiddenTabIds_() {
    const hidden = new Set();
    const bar = this._bar;
    if (!bar || !(bar.scrollWidth > bar.clientWidth + 1)) return hidden;
    const box = bar.getBoundingClientRect();
    for (const el of bar.querySelectorAll('.tab')) {
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) hidden.add(el.getAttribute('data-res-id'));
    }
    return hidden;
  }

  /** Muestra el botón de la lista y el difuminado de bordes según el desbordamiento. @private */
  _updateOverflow_() {
    const bar = this._bar;
    const more = this._more;
    if (!bar || !more) return;
    this._fitVisibleWidth_();
    const overflow = bar.scrollWidth > bar.clientWidth + 1;
    const left = bar.scrollLeft || 0;
    bar.classList.toggle('has-start', overflow && left > 1);
    bar.classList.toggle('has-end', overflow && left + bar.clientWidth < bar.scrollWidth - 1);
    more.hidden = !overflow;
    if (!overflow) return;
    const count = this._hiddenTabIds_().size;
    const label = DomUtils.t('edTabsMore', 'Show all open tabs ($1 hidden)', count);
    if (more.getAttribute('aria-label') !== label) {
      more.setAttribute('aria-label', label);
      more.title = label;
      DomUtils.setHTML(more, `${GasUi.icon('chevronDown', 16)}<span class="more__count">${count}</span>`);
    }
  }

  /** @private */
  _onBarScroll() {
    this._scheduleOverflow_();
    if (!this._menu) return;
    const since = Date.now() - Math.max(this._menu.openedAt, this._programmaticScrollAt);
    if (since > GasFileTabs.MENU_SCROLL_GRACE_MS) this._closeMenu_();
  }

  /** @private */
  _onMoreClick(e) {
    e?.stopPropagation?.();
    if (this._menu?.kind === 'list') { this._closeMenu_(); return; }
    this._openList_();
  }

  // ── Eventos de la barra ──────────────────────────────────────────

  /** @private */
  _onBarClick(e) {
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return;
    if (e.target.closest?.('.tab__close')) {
      e.stopPropagation();
      this.closeTab(hit.resId);
      return;
    }
    this.activate(hit.resId, { focusEditor: true });
  }

  /** Evita el autoscroll del clic central. @private */
  _onBarMouseDown(e) {
    if (e.button === 1) e.preventDefault();
  }

  /** @private */
  _onBarAuxClick(e) {
    if (e.button !== 1) return;
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return;
    e.preventDefault();
    this.closeTab(hit.resId);
  }

  /** @private */
  _onBarContext(e) {
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return;
    e.preventDefault();
    this._openMenu_(hit.resId, GasFileTabs._pointAnchor_(e.clientX, e.clientY));
  }

  /** Teclado: ←/→/Inicio/Fin, Enter/Espacio, Supr y Ctrl+Shift+←/→. @private */
  _onBarKeyDown(e) {
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return;
    const idx = this._index_(hit.resId);
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    const reorder = (e.ctrlKey || e.metaKey) && e.shiftKey;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        handled();
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        if (reorder) { this.moveTab(hit.resId, delta); this._focusTab_(hit.resId); return; }
        const n = this.tabs.length;
        this._focusTab_(this.tabs[(idx + delta + n) % n]?.resId);
        return;
      }
      case 'Home': handled(); this._focusTab_(this.tabs[0]?.resId); return;
      case 'End': handled(); this._focusTab_(this.tabs[this.tabs.length - 1]?.resId); return;
      case 'Enter':
      case ' ':
        handled();
        this.activate(hit.resId);
        return;
      case 'Delete': {
        handled();
        const neighbor = this.tabs[idx + 1] || this.tabs[idx - 1];
        if (this.closeTab(hit.resId) && neighbor) this._focusTab_(neighbor.resId);
        return;
      }
      case 'ContextMenu':
        handled();
        this._openMenu_(hit.resId, hit.el);
        return;
      case 'F10':
        if (e.shiftKey) { handled(); this._openMenu_(hit.resId, hit.el); }
        return;
      default:
    }
  }

  /** @private */
  _focusTab_(resId) {
    if (!resId) return;
    this._focusResId = resId;
    this._lastHtml = '';
    this._render_();
    this._tabEl_(resId)?.focus?.();
    this._revealActive_(resId);
  }

  /** Rueda vertical → scroll horizontal. @private */
  _onBarWheel(e) {
    const bar = this._bar;
    if (this._menu) this._closeMenu_();
    if (!bar || bar.scrollWidth <= bar.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    bar.scrollLeft += e.deltaY;
    e.preventDefault();
  }

  // ── Drag & drop ──────────────────────────────────────────────────

  /** `true` si el arrastre es una pestaña nuestra. @private */
  _isOwnDrag_(e) {
    if (!this._drag) return false;
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes(GasFileTabs.DRAG_MIME);
  }

  /** @private */
  _onDragStart(e) {
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return;
    this._drag = { resId: hit.resId };
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(GasFileTabs.DRAG_MIME, hit.resId);
    } catch (_) { /* dataTransfer no disponible */ }
    hit.el.classList.add('is-dragging');
    this._closeMenu_();
    // dragend/drop en captura: el arrastre termina aunque se suelte fuera de la barra.
    document.addEventListener('dragend', this._onDragEnd, true);
    document.addEventListener('drop', this._onDragEnd, true);
  }

  /** Destino del drop: índice de inserción y pestaña con indicador. @private */
  _dropTarget_(e) {
    const hit = GasFileTabs._tabFromEvent_(e);
    if (!hit) return { index: this.tabs.length, el: null, before: false };
    const rect = hit.el.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    const idx = this._index_(hit.resId);
    return { index: before ? idx : idx + 1, el: hit.el, before };
  }

  /** @private */
  _clearDropMarks_() {
    for (const el of this._bar?.querySelectorAll('.is-drop-before, .is-drop-after') || []) {
      el.classList.remove('is-drop-before', 'is-drop-after');
    }
  }

  /** @private */
  _onDragOver(e) {
    if (!this._isOwnDrag_(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* sin dataTransfer */ }
    const target = this._dropTarget_(e);
    this._clearDropMarks_();
    target.el?.classList.add(target.before ? 'is-drop-before' : 'is-drop-after');
  }

  /** @private */
  _onDragLeave(e) {
    if (!this._drag) return;
    if (e.relatedTarget && this._root?.contains?.(e.relatedTarget)) return;
    this._clearDropMarks_();
  }

  /** @private */
  _onDrop(e) {
    if (!this._isOwnDrag_(e)) return;
    e.preventDefault();
    const { resId } = this._drag;
    const { index } = this._dropTarget_(e);
    this._onDragEnd();
    this._dropAt_(resId, index);
  }

  /**
   * Mueve `resId` al hueco de inserción `slot` (0..n).
   * @private
   */
  _dropAt_(resId, slot) {
    const from = this._index_(resId);
    if (from < 0) return false;
    const to = from < slot ? slot - 1 : slot;
    if (!this.moveTabTo(resId, to)) this._render_();
    return true;
  }

  /** Fin del arrastre (dragend, drop fuera o teardown); repinta si quedó pendiente. @private */
  _onDragEnd() {
    document.removeEventListener('dragend', this._onDragEnd, true);
    document.removeEventListener('drop', this._onDragEnd, true);
    const wasDragging = !!this._drag;
    this._drag = null;
    this._clearDropMarks_();
    for (const el of this._bar?.querySelectorAll('.is-dragging') || []) el.classList.remove('is-dragging');
    if (wasDragging && this._renderDeferred) {
      this._renderDeferred = false;
      this._render_();
    }
  }

  // ── Menús (contextual y lista) ───────────────────────────────────

  /** Ancla virtual en un punto de la pantalla. @private */
  static _pointAnchor_(x, y) {
    return {
      isConnected: true,
      getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }),
    };
  }

  /**
   * Abre el menú contextual en el siguiente frame (el gesto que lo abre no lo cierra).
   * @param {string} resId
   * @param {Element|object} anchor Pestaña o ancla virtual.
   * @private
   */
  _openMenu_(resId, anchor) {
    this._closeMenu_();
    this._menuFrame = GasFileTabs._raf_(() => {
      this._menuFrame = 0;
      this._openContextMenu_(resId, anchor);
    });
  }

  /** @private */
  _openContextMenu_(resId, anchor) {
    const idx = this._index_(resId);
    if (idx < 0 || !this._enabled) return;
    const esc = DomUtils.escapeHtml;
    const only = this.tabs.length <= 1;
    const items = [
      ['close', DomUtils.t('edTabsMenuClose', 'Close'), only],
      ['closeOthers', DomUtils.t('edTabsMenuCloseOthers', 'Close others'), only],
      ['closeRight', DomUtils.t('edTabsMenuCloseRight', 'Close to the right'), idx >= this.tabs.length - 1],
      ['copyName', DomUtils.t('edTabsMenuCopyName', 'Copy name'), false],
    ];
    const menu = this._mountMenu_('context', { resId, anchor, label: DomUtils.t('edTabsMenuLabel', 'Tab actions') });
    if (!menu) return;
    menu.setAttribute('role', 'menu');
    DomUtils.setHTML(menu, items.map(([action, label, disabled]) => (
      `<button type="button" class="gt-menu-item" role="menuitem" data-action="${action}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`
    )).join(''));
    this._placeMenu_();
    this._menuItems_()[0]?.focus?.();
  }

  /** Abre la lista de todas las pestañas en el siguiente frame. @private */
  _openList_() {
    this._closeMenu_();
    this._menuFrame = GasFileTabs._raf_(() => {
      this._menuFrame = 0;
      if (!this._enabled || !this._more) return;
      const menu = this._mountMenu_('list', { anchor: this._more, label: DomUtils.t('edTabsListLabel', 'All open tabs') });
      if (!menu) return;
      menu.classList.add('menu--list');
      menu.setAttribute('role', 'dialog');
      if (this.tabs.length > GasFileTabs.LIST_FILTER_MIN) {
        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'gt-input list__search';
        const placeholder = DomUtils.t('edTabsListFilter', 'Filter tabs');
        input.placeholder = placeholder;
        input.setAttribute('aria-label', placeholder);
        input.addEventListener('input', this._onListFilter);
        menu.appendChild(input);
        this._menu.input = input;
      }
      const list = document.createElement('div');
      list.className = 'list';
      list.setAttribute('role', 'menu');
      list.setAttribute('aria-label', DomUtils.t('edTabsListLabel', 'All open tabs'));
      menu.appendChild(list);
      this._menu.list = list;
      this._more.setAttribute('aria-expanded', 'true');
      this._renderList_();
      this._placeMenu_();
      (this._menu.input || this._menuItems_()[0])?.focus?.();
    });
  }

  /**
   * Crea el host del menú en `body` (fuera de nodos invertidos) y sus listeners.
   * @returns {HTMLElement|null} Contenedor `.gt-menu`.
   * @private
   */
  _mountMenu_(kind, { resId = null, anchor, label }) {
    if (!document.body) return null;
    const host = document.createElement('div');
    host.id = GasFileTabs.MENU_HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    GasUi.adopt(root, GasFileTabs.MENU_CSS);
    if (this._host?.style?.getPropertyValue) {
      const dirtyColor = this._host.style.getPropertyValue('--tab-dirty-color');
      if (dirtyColor) host.style.setProperty('--tab-dirty-color', dirtyColor);
    }
    const menu = document.createElement('div');
    menu.className = 'gt-menu menu';
    menu.setAttribute('aria-label', label);
    menu.addEventListener('click', this._onMenuClick);
    menu.addEventListener('pointerdown', this._onMenuPointer);
    root.appendChild(menu);
    document.body.appendChild(host);
    host.addEventListener('focusout', this._onMenuFocusOut);
    this._menu = {
      kind, host, menu, resId, anchor, filter: '', input: null, list: null,
      returnFocus: kind === 'list' ? this._more : this._tabEl_(resId),
      openedAt: Date.now(),
    };
    window.addEventListener('keydown', this._onMenuKey, true);
    window.addEventListener('pointerdown', this._onMenuOutside, true);
    window.addEventListener('blur', this._closeMenu_);
    window.addEventListener('resize', this._closeMenu_);
    return menu;
  }

  /** @private */
  _placeMenu_() {
    const m = this._menu;
    if (!m) return;
    GasUi.positionPopover(m.menu, m.anchor, { align: m.kind === 'list' ? 'end' : 'start', gap: 2 });
  }

  /** Pinta las filas de la lista (ocultas primero, luego visibles). @private */
  _renderList_() {
    const m = this._menu;
    if (!m?.list) return;
    const esc = DomUtils.escapeHtml;
    const hidden = this._hiddenTabIds_();
    const hints = this._hints_();
    const closable = this.tabs.length > 1;
    const query = m.filter.trim().toLowerCase();
    const unsaved = this._unsavedTitle_();
    const rows = this.tabs.filter((t) => !query || t.name.toLowerCase().includes(query));
    const row = (tab) => {
      const { base } = GasFileTabs._splitName_(tab.name);
      const active = tab.resId === this.activeResId;
      const dirty = this._tabDirty_(tab);
      const hint = hints.get(tab.resId);
      return `<div class="row${active ? ' is-active' : ''}${hidden.has(tab.resId) ? ' is-hidden' : ''}" role="none">`
        + `<button type="button" class="gt-menu-item row__main" role="menuitemradio" aria-checked="${active}"`
        + ` data-res-id="${esc(tab.resId)}" title="${esc(tab.name)}">`
        + `<span class="row__check">${active ? GasUi.icon('check', 14) : ''}</span>`
        + `<span class="row__icon">${GasFileTabs._fileIconHtml_(base)}</span>`
        + `<span class="row__name">${esc(base)}</span>`
        + (hint ? `<span class="row__hint">${esc(hint)}</span>` : '')
        + (dirty ? `<span class="row__dot" title="${esc(unsaved)}"></span>` : '')
        + '</button>'
        + (closable && !dirty
          ? `<button type="button" class="gt-icon-btn row__close" tabindex="-1" data-close="${esc(tab.resId)}"`
            + ` aria-label="${esc(DomUtils.t('edTabsClose', 'Close $1', base))}">${GasUi.icon('close', 14)}</button>`
          : '')
        + '</div>';
    };
    const hiddenRows = rows.filter((t) => hidden.has(t.resId));
    const visibleRows = rows.filter((t) => !hidden.has(t.resId));
    let html = '';
    if (!rows.length) {
      html = `<div class="list__empty">${esc(DomUtils.t('edTabsListEmpty', 'No matching tabs'))}</div>`;
    } else if (hiddenRows.length && visibleRows.length) {
      html = `<div class="list__group" role="presentation">${esc(DomUtils.t('edTabsListHidden', 'Hidden'))}</div>`
        + hiddenRows.map(row).join('')
        + `<div class="list__group" role="presentation">${esc(DomUtils.t('edTabsListVisible', 'Visible'))}</div>`
        + visibleRows.map(row).join('');
    } else {
      html = rows.map(row).join('');
    }
    DomUtils.setHTML(m.list, html);
  }

  /** @private */
  _onListFilter(e) {
    if (!this._menu) return;
    this._menu.filter = String(e.target?.value || '');
    this._renderList_();
  }

  /** Abre el archivo elegido en la lista y desplaza la barra hasta su pestaña. @private */
  _pickFromList_(resId) {
    this._closeMenu_();
    this.activate(resId, { focusEditor: true });
    this._revealActive_(resId);
  }

  /** Cierra desde la lista (respeta las reglas de cierre) y la mantiene abierta. @private */
  _closeFromList_(resId) {
    const closed = this.closeTab(resId);
    if (closed && this._menu?.kind === 'list') this._renderList_();
    return closed;
  }

  /** @private */
  _menuItems_() {
    return Array.from(this._menu?.menu.querySelectorAll('.gt-menu-item:not([disabled])') || []);
  }

  /** @private */
  _closeMenu_() {
    GasFileTabs._caf_(this._menuFrame);
    this._menuFrame = 0;
    const menu = this._menu;
    if (!menu) return null;
    this._menu = null;
    window.removeEventListener('keydown', this._onMenuKey, true);
    window.removeEventListener('pointerdown', this._onMenuOutside, true);
    window.removeEventListener('blur', this._closeMenu_);
    window.removeEventListener('resize', this._closeMenu_);
    menu.menu.removeEventListener('click', this._onMenuClick);
    menu.menu.removeEventListener('pointerdown', this._onMenuPointer);
    menu.host.removeEventListener('focusout', this._onMenuFocusOut);
    menu.input?.removeEventListener('input', this._onListFilter);
    if (menu.kind === 'list') this._more?.setAttribute('aria-expanded', 'false');
    menu.host.remove();
    return menu;
  }

  /** @private */
  _onMenuClick(e) {
    const m = this._menu;
    if (!m) return;
    const closeBtn = e.target?.closest?.('[data-close]');
    if (closeBtn) { this._closeFromList_(closeBtn.getAttribute('data-close')); return; }
    const btn = e.target?.closest?.('.gt-menu-item');
    if (!btn || btn.disabled) return;
    if (m.kind === 'list') { this._pickFromList_(btn.getAttribute('data-res-id')); return; }
    const { resId } = m;
    this._closeMenu_();
    this._runMenuAction_(btn.getAttribute('data-action'), resId);
  }

  /** Clic en zonas no enfocables del menú: no le quita el foco (no se cierra por focusout). @private */
  _onMenuPointer(e) {
    if (!e.target?.closest?.('button, input')) e.preventDefault();
  }

  /** @private */
  _onMenuFocusOut(e) {
    const m = this._menu;
    if (!m) return;
    const next = e.relatedTarget;
    if (next && (next === m.host || m.host.contains?.(next))) return;
    this._closeMenu_();
  }

  /**
   * Ejecuta una acción del menú sobre una pestaña.
   * @param {'close'|'closeOthers'|'closeRight'|'copyName'} action
   * @param {string} resId
   * @returns {boolean}
   * @private
   */
  _runMenuAction_(action, resId) {
    switch (action) {
      case 'close': return this.closeTab(resId);
      case 'closeOthers': return this.closeOthers(resId);
      case 'closeRight': return this.closeToRight(resId);
      case 'copyName': return this._copyName_(resId);
      default: return false;
    }
  }

  /** @private */
  _copyName_(resId) {
    const tab = this._tab_(resId);
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!tab || !clipboard?.writeText) return false;
    clipboard.writeText(tab.name).then(() => {
      GasUi.toast?.(document, { text: DomUtils.t('edTabsCopied', 'Name copied'), kind: 'success', durationMs: 1800 });
    }).catch(() => { /* sin permiso de portapapeles */ });
    return true;
  }

  /** Único gestor de teclado de los menús (Escape, flechas, Inicio/Fin, Supr, Tab). @private */
  _onMenuKey(e) {
    const m = this._menu;
    if (!m) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const closed = this._closeMenu_();
      closed?.returnFocus?.focus?.();
      return;
    }
    // Solo teclas dirigidas al menú (el foco está dentro de su host).
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!path.includes(m.host)) return;
    const items = this._menuItems_();
    const focused = m.host.shadowRoot?.activeElement;
    const inInput = !!m.input && focused === m.input;
    const current = items.indexOf(focused);
    const move = (i) => { e.preventDefault(); e.stopPropagation(); items[(i + items.length) % items.length]?.focus?.(); };
    switch (e.key) {
      case 'ArrowDown': move(current + 1); return;
      case 'ArrowUp': move(current < 0 ? -1 : current - 1); return;
      case 'Home': if (!inInput) move(0); return;
      case 'End': if (!inInput) move(items.length - 1); return;
      case 'Delete': {
        const resId = focused?.getAttribute?.('data-res-id');
        if (m.kind !== 'list' || !resId || inInput) return;
        e.preventDefault();
        e.stopPropagation();
        if (this._closeFromList_(resId)) this._menuItems_()[Math.max(0, current - 1)]?.focus?.();
        return;
      }
      case 'Tab': this._closeMenu_(); return;
      default:
    }
  }

  /** @private */
  _onMenuOutside(e) {
    if (!this._menu) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(this._menu.host)) return;
    // El botón de la lista alterna el menú en su propio clic.
    if (this._menu.kind === 'list' && this._more && path.includes(this._more)) return;
    this._closeMenu_();
  }
}

;(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const fileTabs = new GasFileTabs();
  window.gasFileTabs = fileTabs;

  let initialConfigApplied = false;
  // Pausa global propia: los deltas no deben reactivar el servicio en pausa.
  let paused = false;
  const isPaused_ = () => paused || window.__gasGloballyDisabled === true;

  // Configuración inicial (el guard evita que navegaciones SPA la pisen).
  document.addEventListener('GAS_TransferData', (e) => {
    if (initialConfigApplied) return;
    initialConfigApplied = true;
    try {
      const settings = JSON.parse(e.detail).settings || {};
      if (settings['global-enable'] === false) paused = true;
      if (settings['gas-file-tabs'] === true && !paused) fileTabs.enable();
    } catch (err) {
      console.warn('[GasFileTabs] Error en GAS_TransferData:', err);
    }
  });

  // Cambios live desde el popup.
  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('global-enable' in options) {
        paused = !options['global-enable'];
        if (paused) { fileTabs.disable(); return; }
      } else if (isPaused_()) {
        return;
      }
      if ('gas-file-tabs' in options) {
        options['gas-file-tabs'] === true ? fileTabs.enable() : fileTabs.disable();
      }
    } catch (err) {
      console.warn('[GasFileTabs] Error en GAS_SettingsUpdated:', err);
    }
  });

  document.addEventListener('GAS_GlobalDisable', () => { paused = true; fileTabs.disable(); });
  document.addEventListener('GAS_GlobalEnable', () => { paused = false; });
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasFileTabs };
} else {
  window.GasFileTabs = GasFileTabs;
}
