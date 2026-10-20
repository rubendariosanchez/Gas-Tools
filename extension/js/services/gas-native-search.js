"use strict";

/**
 * @fileoverview gas-native-search.js
 *
 * Extiende el find widget nativo de Monaco con navegación entre archivos:
 *  - Inserta una barra (archivo actual, posición `n/m` y botones de
 *    archivo anterior / siguiente) como fila propia del widget de búsqueda,
 *    visible aunque "Reemplazar" esté colapsado.
 *  - Registra atajos en el editor: `Ctrl+Alt+F` (siguiente archivo) y
 *    `Ctrl+Shift+F` (anterior archivo).
 *  - Limita la búsqueda a los modelos del proyecto (lee `window.gasFileMap`)
 *    para descartar workers, peek views y diff editors internos, y respeta
 *    el orden de archivos del proyecto.
 *  - Se refresca con el state del find widget, el cambio de archivo activo,
 *    las ediciones de cualquier modelo y los cambios de `gasFileMap`.
 *
 * Auto-inicializado: no requiere cableado desde gas-tools.js. Espera a
 * que `window.jsWireMonacoEditor` esté disponible y se engancha solo.
 * Respeta el toggle global de la extensión. Si Monaco reemplaza la
 * instancia del editor, se reengancha solo al detectar `onDidDispose`;
 * además `window.gasNativeSearch.setEditor(editor)` permite forzar el
 * cambio de forma explícita.
 *
 * Inspirado en "Black edition for google apps script ide"
 * (https://www.swroot.com/black-script): de ahí proviene la idea de
 * extender el widget nativo con navegación cross-file en vez de montar
 * un panel de búsqueda paralelo.
 */
class GasNativeSearch {
  static BUTTONS_ID  = 'qc__nativeSearchButtons';
  static PREV_ID     = 'qc__nativeSearchPrev';
  static NEXT_ID     = 'qc__nativeSearchNext';
  static TRIGGER_ID  = 'qc__nativeSearchTrigger';
  static FILE_ID     = 'qc__nativeSearchFile';
  static POS_ID      = 'qc__nativeSearchPos';
  static FILTER_ID   = 'qc__nativeSearchPopoverFilter';
  static ACTION_NEXT  = 'qc__nativeSearch.findNextFile';
  static ACTION_PREV  = 'qc__nativeSearch.findPrevFile';
  static POPOVER_ID   = 'qc__nativeSearchPopover';
  static MATCHES_ID   = 'qc__nativeSearchMatchesPopover';
  static MATCHES_BTN  = 'qc__nativeSearchMatchesBtn';
  /** Tope de coincidencias entre todos los archivos. */
  static MAX_RESULTS    = 1000;
  /** Presupuesto de tiempo (ms) del recorrido multiarchivo. */
  static TIME_BUDGET_MS = 50;
  /** Altura máxima de los popovers (px). */
  static POPOVER_MAX_H  = 260;

  constructor() {
    /** @type {boolean} */
    this._enabled = false;
    /** @type {object|null} Editor Monaco enganchado actualmente. */
    this._editor = null;
    /** @type {object|null} findController de Monaco. */
    this._controller = null;
    /** @type {object|null} Subscripción al state del controller. */
    this._stateSub = null;
    /** @type {Array<{dispose:()=>void}>} */
    this._actionDisposables = [];
    /** @type {Array<{dispose:()=>void}>} Suscripciones del editor y de Monaco. */
    this._subs = [];
    /** @type {Map<object,{dispose:()=>void}>} `onDidChangeContent` por modelo. */
    this._modelSubs = new Map();
    /** @type {EventTarget|null} gasFileMap al que estamos suscritos. */
    this._fileMapTarget = null;
    /** @type {ResizeObserver|null} Observa el widget mientras hay popovers. */
    this._resizeObserver = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._debounceTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._readyTimer = null;
    /** @type {{dispose:()=>void}|null} Subscripción a `onDidDispose` del editor. */
    this._editorDisposeSub = null;
    /** @type {object|null} Editor indicado explícitamente vía `setEditor`. */
    this._preferredEditor = null;
    /** Editores ya liberados: nunca se reenganchan. @type {WeakSet<object>} */
    this._disposedEditors = new WeakSet();
    /** Estado del popover de archivos. */
    this._popoverOpen = false;
    /** @type {Array<{uri:string,name:string,count:number,first:object}>} */
    this._lastGroups = [];
    /** @type {string} */
    this._lastQuery = '';
    /** Filtro local del popover. */
    this._popoverFilter = '';
    this._onPopoverOutside = this._onPopoverOutside.bind(this);
    this._onPopoverKey     = this._onPopoverKey.bind(this);
    this._onFileMapChange  = () => this._onStateChange_();
  }

  /** Activa el servicio si el editor y Monaco ya están disponibles. */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._waitForEditor_();
  }

  /** Desactiva el servicio: limpia DOM, listeners y acciones. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._stopReadyTimer_();
    this._teardown_();
  }

  /**
   * Engancha el servicio a una instancia concreta de Monaco. Idempotente:
   * si ya está enganchado a ese editor no hace nada; si estaba enganchado
   * a otro, libera listeners/acciones/UI del anterior antes de enganchar
   * el nuevo. Si el servicio está deshabilitado, recuerda el editor para
   * usarlo en el próximo `enable()`.
   * @param {object} editor Instancia `IStandaloneCodeEditor`.
   * @returns {boolean} `true` si quedó enganchado (o ya lo estaba).
   */
  setEditor(editor) {
    if (!editor || this._disposedEditors.has(editor)) return false;
    this._preferredEditor = editor;
    if (!this._enabled) return false;
    if (this._editor === editor && this._controller) return true;
    if (this._tryAttach_(editor)) {
      this._stopReadyTimer_();
      return true;
    }
    // El contribution aún no está listo: el polling lo reintentará.
    this._waitForEditor_();
    return false;
  }

  // ── Inicialización ───────────────────────────────────────────────

  /**
   * Intenta enganchar `editor` (o el candidato actual).
   * @param {object} [editor]
   * @returns {boolean} `true` si quedó enganchado.
   * @private
   */
  _tryAttach_(editor = this._candidateEditor_()) {
    if (!editor || this._disposedEditors.has(editor) || !window.monaco?.KeyCode) return false;
    const controller = editor.getContribution?.('editor.contrib.findController');
    if (!controller) return false;
    this._attach_(editor, controller);
    return true;
  }

  /**
   * Editor a enganchar: el indicado vía `setEditor` o, en su defecto,
   * `window.jsWireMonacoEditor`. Ignora editores ya liberados.
   * @returns {object|null}
   * @private
   */
  _candidateEditor_() {
    const preferred = this._preferredEditor;
    if (preferred && !this._disposedEditors.has(preferred)) return preferred;
    const wired = window.jsWireMonacoEditor;
    if (wired && !this._disposedEditors.has(wired)) return wired;
    return null;
  }

  /** Polling ligero hasta que el editor candidato exponga el contribution. @private */
  _waitForEditor_() {
    this._stopReadyTimer_();
    const tryAttach = () => this._tryAttach_();
    if (tryAttach()) return;
    this._readyTimer = setInterval(() => {
      if (!this._enabled) { this._stopReadyTimer_(); return; }
      if (tryAttach())     { this._stopReadyTimer_(); }
    }, 300);
  }

  /** @private */
  _stopReadyTimer_() {
    if (this._readyTimer) {
      clearInterval(this._readyTimer);
      this._readyTimer = null;
    }
  }

  /**
   * Engancha editor y controller, registra atajos y suscripciones.
   * Idempotente con el mismo par editor/controller.
   * @private
   */
  _attach_(editor, controller) {
    if (this._editor === editor && this._controller === controller) return;
    this._teardown_();
    this._editor     = editor;
    this._controller = controller;

    // Si GAS destruye esta instancia (swap de editor), soltamos todo y
    // volvemos a esperar al siguiente editor disponible.
    this._editorDisposeSub = editor.onDidDispose?.(() => {
      this._disposedEditors.add(editor);
      if (this._preferredEditor === editor) this._preferredEditor = null;
      if (this._editor !== editor) return;
      this._teardown_();
      if (this._enabled) this._waitForEditor_();
    }) || null;

    const state = controller.getState?.();
    if (state?.onFindReplaceStateChange) {
      this._stateSub = state.onFindReplaceStateChange(() => this._onStateChange_());
    }

    this._subscribeSources_();
    this._registerActions_();
  }

  /**
   * Suscribe el refresco a cambio de archivo activo, ediciones de modelos,
   * alta/baja de modelos y cambios de `gasFileMap` (todo vía debounce).
   * @private
   */
  _subscribeSources_() {
    const keep = (d) => { if (d && typeof d.dispose === 'function') this._subs.push(d); };
    keep(this._editor.onDidChangeModel?.(() => this._onStateChange_()));

    const me = window.monaco?.editor;
    keep(me?.onDidCreateModel?.((model) => {
      this._watchModel_(model);
      this._onContentChange_();
    }));
    keep(me?.onWillDisposeModel?.((model) => {
      this._unwatchModel_(model);
      this._onContentChange_();
    }));
    (me?.getModels?.() || []).forEach((model) => this._watchModel_(model));

    this._syncFileMapSub_();
  }

  /**
   * Mantiene el listener 'change' sobre el `window.gasFileMap` vigente (puede sustituirse).
   * @private
   */
  _syncFileMapSub_() {
    const map = window.gasFileMap;
    if (map === this._fileMapTarget) return;
    this._fileMapTarget?.removeEventListener?.('change', this._onFileMapChange);
    this._fileMapTarget = null;
    if (map && typeof map.addEventListener === 'function') {
      map.addEventListener('change', this._onFileMapChange);
      this._fileMapTarget = map;
    }
  }

  /**
   * Escucha las ediciones de un modelo del proyecto (cubre también el activo).
   * @param {object} model
   * @private
   */
  _watchModel_(model) {
    if (!model || this._modelSubs.has(model) || model.uri?.scheme === 'gas-preview' || model.uri?.scheme === 'gas-ghdiff') return;
    if (model.isDisposed?.()) return;
    const sub = model.onDidChangeContent?.(() => this._onContentChange_());
    if (sub && typeof sub.dispose === 'function') this._modelSubs.set(model, sub);
  }

  /** @param {object} model @private */
  _unwatchModel_(model) {
    const sub = this._modelSubs.get(model);
    if (!sub) return;
    try { sub.dispose(); } catch (_) {}
    this._modelSubs.delete(model);
  }

  /** @private */
  _registerActions_() {
    if (!this._editor?.addAction) return;
    const { KeyMod, KeyCode } = window.monaco;
    const keyF = KeyCode.KeyF ?? KeyCode.KEY_F;

    this._actionDisposables.push(
      this._editor.addAction({
        id: GasNativeSearch.ACTION_NEXT,
        label: 'GAS Tools: Find next file',
        keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | keyF],
        run: () => this._goToAdjacentFile_('next'),
      }),
      this._editor.addAction({
        id: GasNativeSearch.ACTION_PREV,
        label: 'GAS Tools: Find previous file',
        keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | keyF],
        run: () => this._goToAdjacentFile_('previous'),
      }),
    );
  }

  /** @private */
  _teardown_() {
    this._closePopover_();
    this._closeMatchesPopover_();
    this._disconnectObserver_();
    const safeDispose = (d) => { try { d?.dispose?.(); } catch (_) {} };
    this._actionDisposables.forEach(safeDispose);
    this._actionDisposables = [];
    this._subs.forEach(safeDispose);
    this._subs = [];
    this._modelSubs.forEach(safeDispose);
    this._modelSubs.clear();
    if (this._fileMapTarget) {
      try { this._fileMapTarget.removeEventListener('change', this._onFileMapChange); } catch (_) {}
      this._fileMapTarget = null;
    }
    safeDispose(this._stateSub);
    this._stateSub = null;
    safeDispose(this._editorDisposeSub);
    this._editorDisposeSub = null;
    this._controller = null;
    this._editor     = null;
    this._removeUi_();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._lastGroups = [];
    this._lastQuery = '';
    this._popoverFilter = '';
  }

  // ── Reacción a cambios ───────────────────────────────────────────

  /** @private */
  _onStateChange_() {
    if (!this._enabled) return;
    this._syncFileMapSub_();
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._refreshUi_();
    }, 80);
  }

  /** Ediciones de modelos: solo refresca si hay una búsqueda visible. @private */
  _onContentChange_() {
    const state = this._controller?.getState?.();
    if (!state?.searchString || state.isRevealed === false) return;
    this._onStateChange_();
  }

  /**
   * URI del modelo activo; cadena vacía si el editor no tiene modelo.
   * @returns {string}
   * @private
   */
  _currentUri_() {
    return this._editor?.getModel?.()?.uri?.toString?.() || '';
  }

  /**
   * Grupos por archivo para el state dado.
   * @param {object} state
   * @returns {Array<{uri:string,name:string,count:number,first:object}>}
   * @private
   */
  _computeGroups_(state) {
    return this._groupByFile_(this._findAllMatches_(this._buildSearchParams_(state)));
  }

  /**
   * Sincroniza la barra y los popovers con el state actual.
   * @private
   */
  _refreshUi_() {
    if (!this._controller || !this._editor) return;
    const state = this._controller.getState?.();
    const query = state?.searchString || '';
    if (!query) {
      this._setButtonsDisabled_(true);
      this._setBadge_('', '', false);
      this._lastGroups = [];
      this._lastQuery  = '';
    }
    if (!query || state?.isRevealed === false) {
      this._closePopover_();
      this._closeMatchesPopover_();
      return;
    }
    this._ensureUi_();
    const fileGroups = this._computeGroups_(state);
    const total = fileGroups.length;
    const currentUri = this._currentUri_();
    const idx = fileGroups.findIndex((g) => g.uri === currentUri);

    this._setButtonsDisabled_(!fileGroups.some((g) => g.uri !== currentUri));

    // Archivo activo sin coincidencias: sin posición, solo el total.
    let position = '';
    if (total) {
      position = idx >= 0
        ? DomUtils.t('edSearchFilePosition', '$1/$2 files', idx + 1, total)
        : this._countLabel_(total, 'file');
    }
    this._setBadge_(idx >= 0 ? fileGroups[idx].name : '', position, total > 0);

    this._lastGroups = fileGroups;
    this._lastQuery  = query;

    // El botón de "coincidencias en este archivo" solo aporta con 2 o más.
    const matchesInCurrent = idx >= 0 ? fileGroups[idx].count : 0;
    this._setMatchesBtnVisible_(matchesInCurrent > 1);
    if (matchesInCurrent <= 1) {
      this._closeMatchesPopover_();
    } else if (document.getElementById(GasNativeSearch.MATCHES_ID)) {
      this._renderMatchesPopover_();
      this._positionMatchesPopover_();
    }

    if (this._popoverOpen) {
      this._updatePopover_();
      this._positionPopover_();
    }
  }

  // ── Navegación ────────────────────────────────────────────────────

  /**
   * Salta al primer match del archivo anterior o siguiente. Cíclico.
   * @param {'next'|'previous'} dir
   * @private
   */
  _goToAdjacentFile_(dir) {
    if (!this._controller || !this._editor) return;
    const state  = this._controller.getState?.();
    if (!state?.searchString) return;

    const groups = this._computeGroups_(state);
    if (!groups.length) return;

    const currentUri = this._currentUri_();
    const currentIdx = groups.findIndex((g) => g.uri === currentUri);

    let nextIdx;
    if (dir === 'next') {
      nextIdx = currentIdx < groups.length - 1 ? currentIdx + 1 : 0;
    } else {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : groups.length - 1;
    }
    const target = groups[nextIdx]?.first;
    if (!target) return;

    this._jumpToMatch_(target);
    this._setBadge_(groups[nextIdx].name, DomUtils.t('edSearchFilePosition', '$1/$2 files', nextIdx + 1, groups.length), true);
  }

  /**
   * Activa el modelo del match y lo selecciona vía `nextMatchFindAction`
   * para que el contador nativo "n de m" se sincronice.
   * @param {{model:object, range:object}} target
   * @private
   */
  _jumpToMatch_(target) {
    if (!this._editor || !target?.model || !target?.range) return;
    if (target.model.isDisposed?.()) return;
    if (this._editor.getModel?.() !== target.model) {
      this._editor.setModel(target.model);
    }
    const range = target.range;
    // Cursor en el inicio exacto: nextMatch encuentra el match que empieza ahí.
    this._editor.setPosition({
      lineNumber: range.startLineNumber,
      column:     Math.max(1, range.startColumn),
    });
    this._editor.revealRangeInCenter(range);
    this._editor.focus();
    try {
      this._editor.trigger('qc-native-search', 'editor.action.nextMatchFindAction', null);
    } catch (_) {
      this._editor.setSelection(range);
    }
  }

  /**
   * Agrupa los matches por archivo preservando su orden de llegada.
   * @param {Array<{model:object, uri:string, range:object}>} matches
   * @returns {Array<{uri:string, name:string, count:number, first:{model:object,uri:string,range:object}}>}
   * @private
   */
  _groupByFile_(matches) {
    const map = window.gasFileMap;
    const order = new Map();
    for (const m of matches) {
      const existing = order.get(m.uri);
      if (existing) {
        existing.count += 1;
      } else {
        const name = (map?.get?.(m.uri))
          || String(m.model?.uri?.path || '').replace(/^\//, '')
          || DomUtils.t('edSearchFileFallback', 'File');
        order.set(m.uri, { uri: m.uri, name, count: 1, first: m });
      }
    }
    return Array.from(order.values());
  }

  /**
   * Ordena modelos según el orden de claves de `gasFileMap` (sidebar).
   * Los no mapeados van al final conservando su orden.
   * @param {Array<object>} models
   * @returns {Array<object>}
   * @private
   */
  _sortByProjectOrder_(models) {
    const map = window.gasFileMap;
    let keys = [];
    try {
      if (typeof map?.keys === 'function') keys = Array.from(map.keys());
      else if (typeof map?.entries === 'function') keys = Array.from(map.entries(), (e) => e[0]);
    } catch (_) { keys = []; }
    if (!keys.length) return models;
    const rank = new Map(keys.map((k, i) => [k, i]));
    const rankOf = (m) => rank.get(String(m.uri)) ?? Number.MAX_SAFE_INTEGER;
    return models.slice().sort((a, b) => rankOf(a) - rankOf(b));
  }

  /**
   * Lee el state del find widget y devuelve los flags relevantes.
   * @param {object} state
   * @returns {{searchString:string, isRegex:boolean, matchCase:boolean, wholeWord:string|null}}
   * @private
   */
  _buildSearchParams_(state) {
    return {
      searchString: state?.searchString || '',
      isRegex:      !!state?.isRegex,
      matchCase:    !!state?.matchCase,
      wholeWord:    state?.wholeWord ? '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?' : null,
    };
  }

  /**
   * Recorre los modelos del proyecto (solo los de `gasFileMap` si está
   * poblado) con tope de resultados y presupuesto de tiempo.
   * @param {object} params
   * @returns {Array<{model:object, uri:string, range:object}>}
   * @private
   */
  _findAllMatches_(params) {
    if (!params.searchString) return [];
    // Los modelos de la vista previa de cambios no son archivos del proyecto.
    const allModels = (window.monaco?.editor?.getModels?.() || [])
      .filter((m) => m?.uri && m.uri.scheme !== 'gas-preview' && m.uri.scheme !== 'gas-ghdiff' && !m.isDisposed?.());
    const map = window.gasFileMap;
    const hasMap = map && typeof map.has === 'function' && map.size > 0;
    const models = this._sortByProjectOrder_(hasMap
      ? allModels.filter((m) => map.has(String(m.uri)))
      : allModels);

    const max = GasNativeSearch.MAX_RESULTS;
    const startedAt = Date.now();
    const out = [];
    for (const model of models) {
      const remaining = max - out.length;
      if (remaining <= 0) break;
      // Regex costosa en muchos archivos: cortamos para no congelar el editor.
      if (Date.now() - startedAt > GasNativeSearch.TIME_BUDGET_MS) break;
      let found;
      try {
        found = model.findMatches(
          params.searchString, false,
          params.isRegex, params.matchCase, params.wholeWord, false, remaining,
        );
      } catch (_) {
        continue;
      }
      const uri = model.uri.toString();
      for (const m of found || []) {
        if (out.length >= max) break;
        out.push({ model, uri, range: m.range });
      }
    }
    return out;
  }

  // ── UI ──────────────────────────────────────────────────────────

  /**
   * Nodo raíz del find widget (campo privado de Monaco o `.find-widget`).
   * @returns {HTMLElement|null}
   * @private
   */
  _findWidgetRoot_() {
    const node = this._controller?._widget?._domNode;
    if (node instanceof HTMLElement) return node;
    return this._editor?.getDomNode?.()?.querySelector('.find-widget') || null;
  }

  /**
   * Busca un elemento por id dentro de la raíz del widget.
   * @param {string} id
   * @returns {HTMLElement|null}
   * @private
   */
  _q_(id) {
    return this._findWidgetRoot_()?.querySelector?.(`#${id}`) || null;
  }

  /**
   * Inserta la barra como fila propia del find widget, justo después de
   * `.replace-part` (no dentro): así se ve con Reemplazar colapsado.
   * @private
   */
  _ensureUi_() {
    const root = this._findWidgetRoot_();
    if (!root) return;
    if (root.querySelector(`#${GasNativeSearch.BUTTONS_ID}`)) return;

    const wrap = document.createElement('div');
    wrap.id = GasNativeSearch.BUTTONS_ID;
    wrap.className = 'qc__nativeSearchBar';

    const esc = (k, fb) => DomUtils.escapeHtml(DomUtils.t(k, fb));
    DomUtils.setHTML(wrap, `
      <span class="qc__nativeSearchInfo">
        <span class="qc__nativeSearchIcon" aria-hidden="true"></span>
        <span class="qc__nativeSearchLabel">${esc('edSearchInFile', 'In file')}</span>
        <button id="${GasNativeSearch.TRIGGER_ID}" type="button"
                class="qc__nativeSearchTrigger"
                aria-haspopup="dialog" aria-expanded="false"
                aria-controls="${GasNativeSearch.POPOVER_ID}"
                title="${esc('edSearchShowFiles', 'Show files with matches')}">
          <span id="${GasNativeSearch.FILE_ID}" class="qc__nativeSearchFile" title=""></span>
          <span class="qc__nativeSearchTriggerCaret" aria-hidden="true"></span>
        </button>
        <span id="${GasNativeSearch.POS_ID}" class="qc__nativeSearchPos"></span>
      </span>
      <span class="qc__nativeSearchActions">
        <button id="${GasNativeSearch.MATCHES_BTN}" type="button"
                class="qc__nativeSearchBtn"
                title="${esc('edSearchShowMatchesInFile', 'Show matches in this file')}" aria-label="${esc('edSearchShowMatches', 'Show matches')}"
                aria-haspopup="dialog" aria-expanded="false"
                aria-controls="${GasNativeSearch.MATCHES_ID}"></button>
        <button id="${GasNativeSearch.PREV_ID}" type="button"
                class="qc__nativeSearchBtn"
                title="${esc('edSearchPrevFile', 'Previous file')} (Ctrl+Shift+F)" aria-label="${esc('edSearchPrevFile', 'Previous file')}"></button>
        <button id="${GasNativeSearch.NEXT_ID}" type="button"
                class="qc__nativeSearchBtn"
                title="${esc('edSearchNextFile', 'Next file')} (Ctrl+Alt+F)" aria-label="${esc('edSearchNextFile', 'Next file')}"></button>
      </span>
    `);

    DomUtils.setHTML(wrap.querySelector('.qc__nativeSearchIcon'), this._fileSvg_());
    const prev = wrap.querySelector(`#${GasNativeSearch.PREV_ID}`);
    const next = wrap.querySelector(`#${GasNativeSearch.NEXT_ID}`);
    const list = wrap.querySelector(`#${GasNativeSearch.MATCHES_BTN}`);
    DomUtils.setHTML(prev, this._chevronLeftSvg_());
    DomUtils.setHTML(next, this._chevronRightSvg_());
    DomUtils.setHTML(list, this._listSvg_());

    const trigger = wrap.querySelector(`#${GasNativeSearch.TRIGGER_ID}`);
    DomUtils.setHTML(wrap.querySelector('.qc__nativeSearchTriggerCaret'), this._chevronDownSvg_());
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._togglePopover_();
    });

    prev.addEventListener('click', (e) => { e.preventDefault(); this._goToAdjacentFile_('previous'); });
    next.addEventListener('click', (e) => { e.preventDefault(); this._goToAdjacentFile_('next'); });
    list.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._toggleMatchesPopover_();
    });

    const replacePart = root.querySelector('.replace-part');
    if (replacePart && replacePart.parentNode === root && typeof replacePart.insertAdjacentElement === 'function') {
      replacePart.insertAdjacentElement('afterend', wrap);
    } else {
      root.appendChild(wrap);
    }
    this._injectStyles_();
  }

  /** @private */
  _removeUi_() {
    document.getElementById(GasNativeSearch.BUTTONS_ID)?.remove();
    document.getElementById('qc__nativeSearchStyles')?.remove();
  }

  /** @private */
  _setButtonsDisabled_(disabled) {
    [GasNativeSearch.PREV_ID, GasNativeSearch.NEXT_ID].forEach((id) => {
      const btn = this._q_(id);
      if (!btn) return;
      btn.toggleAttribute('disabled', !!disabled);
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  /** @private */
  _setMatchesBtnVisible_(visible) {
    const btn = this._q_(GasNativeSearch.MATCHES_BTN);
    if (!btn) return;
    btn.style.display = visible ? '' : 'none';
  }

  /**
   * Pinta el nombre base del archivo actual (ruta completa en `title`)
   * y la posición.
   * @param {string} fileName
   * @param {string} position
   * @param {boolean} visible
   * @private
   */
  _setBadge_(fileName, position, visible) {
    const wrap = this._q_(GasNativeSearch.BUTTONS_ID);
    if (!wrap) return;
    wrap.classList.toggle('qc__nativeSearchBar--hidden', !visible);
    const fileEl = wrap.querySelector(`#${GasNativeSearch.FILE_ID}`);
    const posEl  = wrap.querySelector(`#${GasNativeSearch.POS_ID}`);
    if (fileEl) {
      fileEl.textContent = this._splitPath_(fileName).base || '—';
      fileEl.title = fileName || '';
    }
    if (posEl) posEl.textContent = position || '';
  }

  /** @private */
  _injectStyles_() {
    if (document.getElementById('qc__nativeSearchStyles')) return;
    const style = document.createElement('style');
    style.id = 'qc__nativeSearchStyles';
    style.textContent = `
      /* El widget crece para alojar la barra como fila propia. */
      .monaco-editor .find-widget:has(#qc__nativeSearchButtons) {
        height: auto !important;
      }

      /* Barra dentro del widget: hereda los colores --vscode-* del editor. */
      .qc__nativeSearchBar {
        display: flex;
        box-sizing: border-box;
        flex: 1 0 100%;
        min-width: 0;
        max-width: 100%;
        height: auto;
        min-height: 28px;
        align-items: center;
        gap: 8px;
        margin: 4px 25px 4px 17px;
        padding: 2px 4px 2px 8px;
        overflow: hidden;
        container-type: inline-size;
        background: rgba(127,127,127,.10);
        border: 1px solid rgba(127,127,127,.22);
        border-radius: 4px;
        font-size: 11.5px;
        line-height: 1;
        color: var(--vscode-editorWidget-foreground, currentColor);
      }
      .qc__nativeSearchBar--hidden {
        display: none;
      }
      .qc__nativeSearchInfo {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .qc__nativeSearchIcon {
        display: inline-flex;
        flex: 0 0 auto;
        color: var(--vscode-icon-foreground, #569cd6);
      }
      .qc__nativeSearchIcon svg { width: 13px; height: 13px; display: block; }
      .qc__nativeSearchLabel {
        flex: 0 0 auto;
        color: var(--vscode-editorWidget-foreground, #616161);
        text-transform: uppercase;
        letter-spacing: .04em;
        font-size: 11px;
      }
      @container (max-width: 340px) {
        .qc__nativeSearchLabel { display: none; }
      }
      .qc__nativeSearchFile {
        flex: 0 1 auto;
        min-width: 0;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .qc__nativeSearchTrigger {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 0 1 auto;
        background: transparent;
        border: 0;
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 6px;
        max-width: none;
        min-width: 0;
      }
      .qc__nativeSearchTrigger:hover {
        background: rgba(127,127,127,.18);
      }
      .qc__nativeSearchTrigger[aria-expanded="true"] {
        background: rgba(127,127,127,.22);
      }
      .qc__nativeSearchTriggerCaret {
        flex: 0 0 auto;
        display: inline-flex;
        color: var(--vscode-descriptionForeground, #888);
        transition: transform .12s;
      }
      .qc__nativeSearchTrigger[aria-expanded="true"] .qc__nativeSearchTriggerCaret {
        transform: rotate(180deg);
      }
      @media (prefers-reduced-motion: reduce) {
        .qc__nativeSearchTriggerCaret { transition: none; }
      }
      .qc__nativeSearchTriggerCaret svg { width: 11px; height: 11px; display: block; }
      .qc__nativeSearchPos {
        flex: 0 0 auto;
        color: var(--vscode-editorWidget-foreground, #616161);
        font-size: 11px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .qc__nativeSearchActions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
      }
      .qc__nativeSearchBtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px; height: 22px;
        background: transparent;
        border: 0;
        border-radius: 4px;
        color: var(--vscode-icon-foreground, currentColor);
        cursor: pointer;
        padding: 0;
      }
      .qc__nativeSearchBtn:hover:not([disabled]) {
        background: rgba(127,127,127,.22);
      }
      .qc__nativeSearchBtn[disabled] {
        opacity: .35;
        cursor: default;
      }
      .qc__nativeSearchBtn svg {
        width: 13px;
        height: 13px;
        display: block;
      }

      /* Popovers: cuelgan de body, por eso usan tokens --gt-* (claro/oscuro). */
      .qc__nativeSearchPopover {
        position: fixed;
        z-index: var(--gt-z-popover);
        box-sizing: border-box;
        width: 240px;
        max-width: calc(100vw - 12px);
        max-height: ${GasNativeSearch.POPOVER_MAX_H}px;
        display: flex;
        flex-direction: column;
        background: var(--gt-surface);
        color: var(--gt-on-surface);
        border: 1px solid var(--gt-outline-variant);
        border-radius: var(--gt-shape-s);
        box-shadow: var(--gt-elevation-2);
        font: var(--gt-type-body-s);
        overflow: visible;
      }
      /* Flecha: cuadrado rotado 45° con dos bordes visibles. */
      .qc__nativeSearchPopover-arrow {
        position: absolute;
        width: 12px;
        height: 12px;
        margin-left: -6px;
        pointer-events: none;
        background: var(--gt-surface-container);
        background-clip: padding-box;
        border: 1px solid var(--gt-outline-variant);
        transform: rotate(45deg);
      }
      .qc__nativeSearchPopover[data-placement="bottom"] .qc__nativeSearchPopover-arrow {
        top: -7px;
        border-right: 0;
        border-bottom: 0;
      }
      .qc__nativeSearchPopover[data-placement="top"] .qc__nativeSearchPopover-arrow {
        bottom: -7px;
        border-top: 0;
        border-left: 0;
        background: var(--gt-surface);
      }
      .qc__nativeSearchPopover-head {
        display: flex;
        align-items: center;
        min-width: 0;
        flex: 0 0 auto;
        padding: 6px 10px;
        background: var(--gt-surface-container);
        border-bottom: 1px solid var(--gt-outline-variant);
        font-size: 11px;
        color: var(--gt-on-surface-variant);
        border-top-left-radius: var(--gt-shape-s);
        border-top-right-radius: var(--gt-shape-s);
      }
      .qc__nativeSearchPopover-stat {
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
      }
      .qc__nativeSearchPopover-stat strong {
        color: var(--gt-on-surface);
        font-weight: 600;
      }
      .qc__nativeSearchPopover-sep {
        flex: 0 0 auto;
      }
      .qc__nativeSearchPopover-search {
        flex: 0 0 auto;
        padding: 6px 8px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--gt-outline-variant);
      }
      .qc__nativeSearchPopover-searchIcon {
        display: inline-flex;
        flex: 0 0 auto;
        color: var(--gt-on-surface-variant);
      }
      .qc__nativeSearchPopover-searchIcon svg {
        width: 13px; height: 13px; display: block;
      }
      .qc__nativeSearchPopover-input {
        flex: 1 1 auto;
        min-width: 0;
        background: var(--gt-surface-container);
        color: var(--gt-on-surface);
        border: 1px solid var(--gt-outline);
        border-radius: var(--gt-shape-xs, 4px);
        padding: 3px 6px;
        font: inherit;
        outline: none;
      }
      .qc__nativeSearchPopover-input::placeholder {
        color: var(--gt-on-surface-variant);
        opacity: 1;
      }
      .qc__nativeSearchPopover-input:focus {
        border-color: var(--gt-primary);
        box-shadow: 0 0 0 1px var(--gt-primary);
      }
      .qc__nativeSearchPopover-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 4px;
        scrollbar-width: thin;
        scrollbar-color: var(--gt-outline-variant) transparent;
      }
      .qc__nativeSearchPopover-item,
      .qc__nativeSearchMatch-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-width: 0;
        padding: 4px 8px;
        background: transparent;
        border: 0;
        border-radius: var(--gt-shape-xs, 4px);
        color: var(--gt-on-surface);
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .qc__nativeSearchPopover-item:hover,
      .qc__nativeSearchMatch-item:hover {
        background: var(--gt-state-hover);
      }
      .qc__nativeSearchPopover-item:focus-visible,
      .qc__nativeSearchMatch-item:focus-visible {
        outline: 2px solid var(--gt-primary);
        outline-offset: -2px;
      }
      .qc__nativeSearchPopover-item--active {
        background: var(--gt-secondary-container);
        color: var(--gt-on-secondary-container);
      }
      .qc__nativeSearchPopover-item--active:hover {
        background: var(--gt-secondary-container);
      }
      .qc__nativeSearchPopover-icon {
        flex: 0 0 auto;
        display: inline-flex;
        width: 16px; height: 16px;
        align-items: center;
        justify-content: center;
      }
      .qc__nativeSearchPopover-icon svg { width: 14px; height: 14px; display: block; }
      /* Sobre la selección el color fijo del icono no contrasta: usa el del texto. */
      .qc__nativeSearchPopover-item--active .qc__nativeSearchPopover-icon svg [fill]:not([fill="none"]) { fill: currentColor; }
      .qc__nativeSearchPopover-item--active .qc__nativeSearchPopover-icon svg [stroke]:not([stroke="none"]) { stroke: currentColor; }
      .qc__nativeSearchPopover-name {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        color: inherit;
      }
      /* Rutas largas: la carpeta se trunca por el inicio (…tas/) y el nombre base se conserva. */
      .qc__nativeSearchPath-dir {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 60%;
        overflow: hidden;
        text-overflow: ellipsis;
        direction: rtl;
        text-align: left;
        color: var(--gt-on-surface-variant);
      }
      .qc__nativeSearchPath-dir > bdi { direction: ltr; unicode-bidi: isolate; }
      .qc__nativeSearchPath-base {
        flex: 0 0 auto;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .qc__nativeSearchPopover-head .qc__nativeSearchPopover-name {
        flex: 0 1 auto;
        color: var(--gt-on-surface);
      }
      .qc__nativeSearchPopover-name mark,
      .qc__nativeSearchMatch-snippet mark {
        background: var(--gt-warning-container);
        color: var(--gt-on-warning-container);
        padding: 0 1px;
        border-radius: 2px;
      }
      .qc__nativeSearchPopover-count {
        flex: 0 0 auto;
        min-width: 22px;
        padding: 0 6px;
        height: 16px;
        line-height: 16px;
        text-align: center;
        border-radius: var(--gt-shape-full, 999px);
        background: var(--gt-surface-container-high);
        color: var(--gt-on-surface);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .qc__nativeSearchPopover-empty {
        padding: 16px;
        text-align: center;
        color: var(--gt-on-surface-variant);
      }

      /* Lista de coincidencias del archivo actual. */
      .qc__nativeSearchMatchesPopover { width: 300px; }
      .qc__nativeSearchMatch-item { gap: 10px; }
      .qc__nativeSearchMatch-line {
        flex: 0 0 auto;
        min-width: 32px;
        padding: 1px 6px;
        text-align: right;
        color: var(--gt-on-surface-variant);
        font-family: var(--gt-font-mono, monospace);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .qc__nativeSearchMatch-snippet {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: pre;
        font-family: var(--gt-font-mono, monospace);
        font-size: 11.5px;
        font-variant-ligatures: none;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Utilidades de popovers ───────────────────────────────────────

  /**
   * Coloca un popover bajo la barra (o encima si no cabe), con la flecha
   * centrada en `anchor` y `max-height` limitado al viewport.
   * @param {HTMLElement} popover
   * @param {HTMLElement} anchor Trigger al que apunta la flecha.
   * @param {'start'|'end'} align Alineación horizontal respecto al anchor.
   * @private
   */
  _placePopover_(popover, anchor, align) {
    const bar = this._q_(GasNativeSearch.BUTTONS_ID) || anchor;
    const rect = anchor.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const margin = 6;
    const arrowSize = 7;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cap = GasNativeSearch.POPOVER_MAX_H;

    const below = vh - barRect.bottom - arrowSize - margin;
    const above = barRect.top - arrowSize - margin;
    popover.style.maxHeight = '';
    const natural = Math.min(popover.offsetHeight || cap, cap);
    const placement = (below >= natural || below >= above) ? 'bottom' : 'top';
    const space = Math.max(120, placement === 'bottom' ? below : above);
    const maxH = Math.min(cap, space);
    popover.style.maxHeight = `${maxH}px`;
    const h = Math.min(natural, maxH);
    const w = popover.offsetWidth || 240;

    let left = align === 'end' ? rect.right - w : rect.left;
    if (left + w + margin > vw) left = vw - w - margin;
    if (left < margin) left = margin;
    const top = placement === 'bottom' ? barRect.bottom + arrowSize : barRect.top - arrowSize - h;

    popover.style.left = `${left}px`;
    popover.style.top  = `${Math.max(margin, top)}px`;
    popover.dataset.placement = placement;

    const arrow = popover.querySelector('.qc__nativeSearchPopover-arrow');
    if (arrow) {
      const center = rect.left + rect.width / 2;
      arrow.style.left = `${Math.max(14, Math.min(w - 14, center - left))}px`;
    }
  }

  /**
   * Gestiona ↑/↓/Inicio/Fin entre los items de una lista.
   * @param {KeyboardEvent} e
   * @param {Array<HTMLElement>} items
   * @returns {boolean} `true` si consumió la tecla.
   * @private
   */
  _moveFocus_(e, items) {
    if (!items.length) return false;
    const cur = items.indexOf(document.activeElement);
    let next;
    if (e.key === 'ArrowDown')      next = cur < 0 ? 0 : Math.min(items.length - 1, cur + 1);
    else if (e.key === 'ArrowUp')   next = cur <= 0 ? 0 : cur - 1;
    else if (e.key === 'Home')      next = 0;
    else if (e.key === 'End')       next = items.length - 1;
    else return false;
    e.preventDefault?.();
    e.stopPropagation?.();
    items[next]?.focus?.();
    return true;
  }

  /** Observa el widget para recolocar popovers abiertos. @private */
  _observeRoot_() {
    if (this._resizeObserver || typeof ResizeObserver === 'undefined') return;
    const root = this._findWidgetRoot_();
    if (!root) return;
    const reposition = () => {
      this._positionPopover_();
      this._positionMatchesPopover_();
    };
    this._resizeObserver = new ResizeObserver(reposition);
    this._resizeObserver.observe(root);
    // La entrada del widget es un transform: ResizeObserver no la detecta.
    this._observedRoot = root;
    this._onRootTransition = reposition;
    root.addEventListener('transitionend', reposition);
  }

  /** Desconecta el observer si ya no queda ningún popover abierto. @private */
  _releaseObserver_() {
    if (this._popoverOpen || document.getElementById(GasNativeSearch.MATCHES_ID)) return;
    this._disconnectObserver_();
  }

  /** @private */
  _disconnectObserver_() {
    try { this._resizeObserver?.disconnect(); } catch (_) {}
    this._resizeObserver = null;
    this._observedRoot?.removeEventListener('transitionend', this._onRootTransition);
    this._observedRoot = null;
    this._onRootTransition = null;
  }

  // ── Popover de matches en el archivo actual ──────────────────────

  /** @private */
  _toggleMatchesPopover_() {
    if (document.getElementById(GasNativeSearch.MATCHES_ID)) {
      this._closeMatchesPopover_();
    } else {
      this._openMatchesPopover_();
    }
  }

  /** @private */
  _openMatchesPopover_() {
    if (!this._currentFileMatches_().length) return;
    this._closePopover_();

    const popover = document.createElement('div');
    popover.id = GasNativeSearch.MATCHES_ID;
    popover.className = 'qc__nativeSearchPopover qc__nativeSearchMatchesPopover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', DomUtils.t('edSearchMatchesDialog', 'Matches in this file'));
    document.body.appendChild(popover);

    this._renderMatchesPopover_();
    this._positionMatchesPopover_();

    const btn = this._q_(GasNativeSearch.MATCHES_BTN);
    btn?.setAttribute('aria-expanded', 'true');

    this._onMatchesOutside = (e) => {
      const path = e.composedPath?.() || [];
      if (path.includes(popover)) return;
      const b = this._q_(GasNativeSearch.MATCHES_BTN);
      if (b && path.includes(b)) return;
      this._closeMatchesPopover_();
    };
    this._onMatchesKey = (e) => {
      if (e.type === 'resize') { this._positionMatchesPopover_(); return; }
      if (e.type !== 'keydown') return;
      const pop = document.getElementById(GasNativeSearch.MATCHES_ID);
      const inside = !!pop && (e.composedPath?.() || []).includes(pop);
      if (e.key === 'Escape') {
        e.stopPropagation();
        this._closeMatchesPopover_();
        if (inside) this._q_(GasNativeSearch.MATCHES_BTN)?.focus?.();
        return;
      }
      if (inside) this._moveFocus_(e, Array.from(pop.querySelectorAll('.qc__nativeSearchMatch-item')));
    };
    document.addEventListener('mousedown', this._onMatchesOutside, true);
    document.addEventListener('keydown', this._onMatchesKey, true);
    window.addEventListener('resize', this._onMatchesKey);
    this._observeRoot_();

    requestAnimationFrame(() => {
      document.getElementById(GasNativeSearch.MATCHES_ID)
        ?.querySelector('.qc__nativeSearchMatch-item')?.focus?.();
    });
  }

  /** @private */
  _closeMatchesPopover_() {
    document.getElementById(GasNativeSearch.MATCHES_ID)?.remove();
    this._q_(GasNativeSearch.MATCHES_BTN)?.setAttribute('aria-expanded', 'false');
    if (this._onMatchesOutside) {
      document.removeEventListener('mousedown', this._onMatchesOutside, true);
      this._onMatchesOutside = null;
    }
    if (this._onMatchesKey) {
      document.removeEventListener('keydown', this._onMatchesKey, true);
      window.removeEventListener('resize', this._onMatchesKey);
      this._onMatchesKey = null;
    }
    this._releaseObserver_();
  }

  /** @private */
  _renderMatchesPopover_() {
    const popover = document.getElementById(GasNativeSearch.MATCHES_ID);
    if (!popover) return;
    // Modelo para el que se pinta: si cambia antes del clic, no saltamos.
    const model = this._editor?.getModel?.() || null;
    const matches = this._currentFileMatches_();
    const fileName = model ? (window.gasFileMap?.get?.(this._currentUri_()) || '') : '';

    if (!matches.length) {
      DomUtils.setHTML(popover, `
        <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
        <div class="qc__nativeSearchPopover-empty">${DomUtils.escapeHtml(DomUtils.t('edSearchNoMatchesInFile', 'No matches in this file'))}</div>
      `);
      return;
    }

    const itemsHtml = matches.map((m, i) => `
        <button class="qc__nativeSearchMatch-item" data-idx="${i}" type="button"
                title="${DomUtils.escapeHtml(DomUtils.t('edSearchLineColumn', 'Line $1, column $2', m.line, m.column))}">
          <span class="qc__nativeSearchMatch-line">${m.line}</span>
          <span class="qc__nativeSearchMatch-snippet">${this._renderSnippet_(m.text, m.matchText, m.column)}</span>
        </button>
      `).join('');

    const nameHtml = fileName
      ? `<span class="qc__nativeSearchPopover-sep" aria-hidden="true">·</span><span class="qc__nativeSearchPopover-name" title="${DomUtils.escapeHtml(fileName)}">${this._pathHtml_(fileName)}</span>`
      : '';
    DomUtils.setHTML(popover, `
      <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
      <div class="qc__nativeSearchPopover-head">
        <span class="qc__nativeSearchPopover-stat">${this._countHtml_(matches.length, 'match')}${nameHtml}</span>
      </div>
      <div class="qc__nativeSearchPopover-list" role="group">${itemsHtml}</div>
    `);

    popover.querySelectorAll('.qc__nativeSearchMatch-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!model || this._editor?.getModel?.() !== model) {
          this._closeMatchesPopover_();
          return;
        }
        const target = matches[Number(btn.dataset.idx)];
        if (!target) return;
        this._jumpToMatch_({ model, range: target.range });
        this._closeMatchesPopover_();
      });
    });
  }

  /** @private */
  _positionMatchesPopover_() {
    const popover = document.getElementById(GasNativeSearch.MATCHES_ID);
    const trigger = this._q_(GasNativeSearch.MATCHES_BTN);
    if (!popover || !trigger) return;
    this._placePopover_(popover, trigger, 'end');
  }

  /**
   * Matches del modelo activo con el texto de su línea inicial.
   * @returns {Array<{line:number, column:number, text:string, matchText:string, range:object}>}
   * @private
   */
  _currentFileMatches_() {
    const model = this._editor?.getModel?.();
    if (!model || !this._controller || model.isDisposed?.()) return [];
    const params = this._buildSearchParams_(this._controller.getState?.());
    if (!params.searchString) return [];

    let found;
    try {
      found = model.findMatches(
        params.searchString, false,
        params.isRegex, params.matchCase, params.wholeWord, false,
        GasNativeSearch.MAX_RESULTS,
      ) || [];
    } catch (_) {
      return [];
    }

    return found.map((m) => {
      const r = m.range;
      const lineText = model.getLineContent(r.startLineNumber) || '';
      // Multilínea: el resaltado cubre hasta el fin de la línea inicial.
      const end = r.endLineNumber === r.startLineNumber ? r.endColumn - 1 : lineText.length;
      return {
        line: r.startLineNumber,
        column: r.startColumn,
        text: lineText,
        matchText: lineText.slice(r.startColumn - 1, end),
        range: r,
      };
    });
  }

  /**
   * Recorta la línea alrededor del match real y lo resalta. Parte el texto
   * crudo y escapa cada trozo.
   * @param {string} lineText
   * @param {string} matchText
   * @param {number} [column] Columna (1-based) del match; sin ella usa la primera aparición.
   * @returns {string} HTML seguro.
   * @private
   */
  _renderSnippet_(lineText, matchText, column) {
    if (!lineText) return '';
    const esc = DomUtils.escapeHtml;
    const lead = lineText.length - lineText.replace(/^\s+/, '').length;
    let at = Number.isFinite(column)
      ? column - 1
      : (matchText ? lineText.toLowerCase().indexOf(matchText.toLowerCase(), lead) : -1);
    const len = matchText ? matchText.length : 0;
    // Si el match cae dentro de la sangría no la recortamos.
    const base = at >= 0 && at < lead ? 0 : lead;
    let text = lineText.slice(base);
    if (at >= 0) at -= base;

    const context = 12;
    const threshold = 20;
    const maxTail = 160;
    let prefix = '';
    if (at > threshold) {
      text = text.slice(at - context);
      at = context;
      prefix = '…';
    }
    let suffix = '';
    const limit = Math.max(maxTail, at + len + context);
    if (text.length > limit) {
      text = text.slice(0, limit);
      suffix = '…';
    }
    if (at < 0 || !len) return esc(prefix + text + suffix);
    return esc(prefix + text.slice(0, at))
      + `<mark>${esc(text.slice(at, at + len))}</mark>`
      + esc(text.slice(at + len) + suffix);
  }

  // ── Popover de archivos ──────────────────────────────────────────

  /** @private */
  _togglePopover_() {
    if (this._popoverOpen) this._closePopover_();
    else                   this._openPopover_({ autoFocusFilter: true });
  }

  /**
   * Abre el popover con los grupos recalculados en el momento.
   * @param {{autoFocusFilter?:boolean}} [opts] `autoFocusFilter` enfoca el filtro.
   * @private
   */
  _openPopover_(opts = {}) {
    const state = this._controller?.getState?.();
    if (!state?.searchString) return;
    this._lastGroups = this._computeGroups_(state);
    this._lastQuery = state.searchString;
    const autoFocusFilter = opts.autoFocusFilter !== false;
    this._closeMatchesPopover_();
    this._popoverOpen = true;
    this._popoverFilter = '';

    const popover = document.createElement('div');
    popover.id = GasNativeSearch.POPOVER_ID;
    popover.className = 'qc__nativeSearchPopover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', DomUtils.t('edSearchFilesDialog', 'Files with matches'));
    document.body.appendChild(popover);

    this._renderPopover_();
    this._positionPopover_();

    this._q_(GasNativeSearch.TRIGGER_ID)?.setAttribute('aria-expanded', 'true');

    document.addEventListener('mousedown', this._onPopoverOutside, true);
    document.addEventListener('keydown', this._onPopoverKey, true);
    window.addEventListener('resize', this._onPopoverKey);
    this._observeRoot_();

    if (autoFocusFilter) {
      requestAnimationFrame(() => {
        document.getElementById(GasNativeSearch.POPOVER_ID)
          ?.querySelector(`#${GasNativeSearch.FILTER_ID}`)?.focus?.();
      });
    }
  }

  /** @private */
  _closePopover_() {
    if (!this._popoverOpen) return;
    this._popoverOpen = false;
    document.getElementById(GasNativeSearch.POPOVER_ID)?.remove();
    document.removeEventListener('mousedown', this._onPopoverOutside, true);
    document.removeEventListener('keydown', this._onPopoverKey, true);
    window.removeEventListener('resize', this._onPopoverKey);
    this._q_(GasNativeSearch.TRIGGER_ID)?.setAttribute('aria-expanded', 'false');
    this._releaseObserver_();
  }

  /** HTML de la cabecera (archivos · coincidencias). @private */
  _popoverHeadHtml_() {
    const groups = this._lastGroups;
    const totalMatches = groups.reduce((acc, g) => acc + g.count, 0);
    return `
      <span class="qc__nativeSearchPopover-stat">
        ${this._countHtml_(groups.length, 'file')}
        <span class="qc__nativeSearchPopover-sep" aria-hidden="true">·</span>
        ${this._countHtml_(totalMatches, 'match')}
      </span>`;
  }

  /** HTML de la lista de archivos, con filtro aplicado. @private */
  _popoverItemsHtml_() {
    const groups = this._lastGroups;
    const currentUri = this._currentUri_();
    const filter = this._popoverFilter.toLowerCase();
    const visible = filter
      ? groups.filter((g) => g.name.toLowerCase().includes(filter))
      : groups;

    if (!visible.length) {
      const msg = !groups.length
        ? DomUtils.t('edSearchNoMatches', 'No matches in the project')
        : DomUtils.t('edSearchNoFilterMatch', 'No files match this filter');
      return `<div class="qc__nativeSearchPopover-empty">${DomUtils.escapeHtml(msg)}</div>`;
    }

    return visible.map((g) => {
      const realIdx = groups.indexOf(g);
      const isActive = g.uri === currentUri;
      return `
        <button class="qc__nativeSearchPopover-item${isActive ? ' qc__nativeSearchPopover-item--active' : ''}" data-idx="${realIdx}" type="button"${isActive ? ' aria-current="true"' : ''}
                title="${DomUtils.escapeHtml(g.name)}">
          <span class="qc__nativeSearchPopover-icon" aria-hidden="true">${this._iconForFile_(g.name)}</span>
          <span class="qc__nativeSearchPopover-name">${this._pathHtml_(g.name, this._popoverFilter)}</span>
          <span class="qc__nativeSearchPopover-count" title="${DomUtils.escapeHtml(this._countLabel_(g.count, 'match'))}">${g.count}</span>
        </button>
      `;
    }).join('');
  }

  /**
   * Enlaza el clic de los items de archivo dentro de `scope`.
   * @param {HTMLElement} scope
   * @private
   */
  _bindPopoverItems_(scope) {
    const groups = this._lastGroups;
    scope.querySelectorAll('.qc__nativeSearchPopover-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const target = groups[Number(btn.dataset.idx)];
        if (!target?.first) return;
        this._jumpToMatch_(target.first);
        this._closePopover_();
      });
    });
  }

  /** Pinta el popover completo (cabecera, filtro y lista). @private */
  _renderPopover_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    if (!popover) return;

    DomUtils.setHTML(popover, `
      <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
      <div class="qc__nativeSearchPopover-head">${this._popoverHeadHtml_()}</div>
      <div class="qc__nativeSearchPopover-search">
        <span class="qc__nativeSearchPopover-searchIcon" aria-hidden="true"></span>
        <input id="${GasNativeSearch.FILTER_ID}" type="text"
               class="qc__nativeSearchPopover-input"
               placeholder="${DomUtils.escapeHtml(DomUtils.t('edSearchFilterFiles', 'Filter files…'))}"
               aria-label="${DomUtils.escapeHtml(DomUtils.t('edSearchFilterFiles', 'Filter files…'))}"
               autocomplete="off" spellcheck="false"
               value="${DomUtils.escapeHtml(this._popoverFilter)}">
      </div>
      <div class="qc__nativeSearchPopover-list" role="group">${this._popoverItemsHtml_()}</div>
    `);

    DomUtils.setHTML(
      popover.querySelector('.qc__nativeSearchPopover-searchIcon'),
      this._magnifierSvg_(),
    );

    const input = popover.querySelector(`#${GasNativeSearch.FILTER_ID}`);
    // Composición IME (tildes, CJK): esperamos a `compositionend`.
    input?.addEventListener('input', (e) => {
      if (e.isComposing) return;
      this._applyFilter_(e.target?.value);
    });
    input?.addEventListener('compositionend', (e) => this._applyFilter_(e.target?.value));

    this._bindPopoverItems_(popover);
  }

  /** Refresca cabecera y lista sin tocar el filtro (conserva foco). @private */
  _updatePopover_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    if (!popover) return;
    const head = popover.querySelector('.qc__nativeSearchPopover-head');
    if (head) DomUtils.setHTML(head, this._popoverHeadHtml_());
    this._renderPopoverList_();
  }

  /** Re-renderiza solo la lista de archivos. @private */
  _renderPopoverList_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const list = popover?.querySelector('.qc__nativeSearchPopover-list');
    if (!list) return;
    DomUtils.setHTML(list, this._popoverItemsHtml_());
    this._bindPopoverItems_(list);
  }

  /**
   * Aplica el filtro del popover y repinta solo la lista.
   * @param {string} value
   * @private
   */
  _applyFilter_(value) {
    const next = String(value || '');
    if (next === this._popoverFilter) return;
    this._popoverFilter = next;
    this._renderPopoverList_();
    this._positionPopover_();
  }

  /**
   * SVG del icono vía `window.gasFolders`; solo se acepta si es un `<svg>`.
   * @param {string} fileName
   * @returns {string}
   * @private
   */
  _iconForFile_(fileName) {
    const folders = window.gasFolders;
    if (typeof folders?._renderFileSvg_ === 'function') {
      const ext = String(fileName || '').split('.').pop().toLowerCase();
      const type = (ext === 'gs' || ext === 'html' || ext === 'json') ? ext : 'generic';
      try {
        const svg = folders._renderFileSvg_(type);
        if (typeof svg === 'string' && svg.trim().startsWith('<svg')
            && !/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(svg)) return svg;
      } catch (_) { /* noop */ }
    }
    return this._fileSvg_();
  }

  /**
   * Separa una ruta `carpeta/nombre`.
   * @param {string} name
   * @returns {{dir:string, base:string}}
   * @private
   */
  _splitPath_(name) {
    const s = String(name || '');
    const cut = s.lastIndexOf('/') + 1;
    return { dir: s.slice(0, cut), base: s.slice(cut) };
  }

  /**
   * HTML seguro de una ruta: carpeta truncable + nombre base, con el
   * filtro resaltado como `<mark>`.
   * @param {string} name
   * @param {string} [filter]
   * @returns {string}
   * @private
   */
  _pathHtml_(name, filter = '') {
    const { dir, base } = this._splitPath_(name);
    let hs = -1;
    let he = -1;
    if (filter) {
      hs = String(name).toLowerCase().indexOf(filter.toLowerCase());
      if (hs >= 0) he = hs + filter.length;
    }
    const dirHtml = dir
      ? `<span class="qc__nativeSearchPath-dir"><bdi>${this._markRange_(dir, hs, he)}</bdi></span>`
      : '';
    return `${dirHtml}<span class="qc__nativeSearchPath-base">${this._markRange_(base, hs - dir.length, he - dir.length)}</span>`;
  }

  /**
   * Escapa `text` envolviendo `[start, end)` en `<mark>` si hay solape.
   * @param {string} text
   * @param {number} start
   * @param {number} end
   * @returns {string}
   * @private
   */
  _markRange_(text, start, end) {
    const esc = DomUtils.escapeHtml;
    const s = Math.max(0, start);
    const e = Math.min(text.length, end);
    if (e <= s) return esc(text);
    return `${esc(text.slice(0, s))}<mark>${esc(text.slice(s, e))}</mark>${esc(text.slice(e))}`;
  }

  /** @private */
  _positionPopover_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const trigger = this._q_(GasNativeSearch.TRIGGER_ID);
    if (!popover || !trigger) return;
    this._placePopover_(popover, trigger, 'start');
  }

  /** @private */
  _onPopoverOutside(e) {
    if (!this._popoverOpen) return;
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const trigger = this._q_(GasNativeSearch.TRIGGER_ID);
    const path = e.composedPath?.() || [];
    if (popover && path.includes(popover)) return;
    if (trigger && path.includes(trigger)) return;
    this._closePopover_();
  }

  /** @private */
  _onPopoverKey(e) {
    if (!this._popoverOpen) return;
    if (e.type === 'resize') { this._positionPopover_(); return; }
    if (e.type !== 'keydown') return;
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const path = e.composedPath?.() || [];
    const inside = !!popover && path.includes(popover);
    if (e.key === 'Escape') {
      e.stopPropagation();
      this._closePopover_();
      if (inside) this._q_(GasNativeSearch.TRIGGER_ID)?.focus?.();
      return;
    }
    if (!inside || e.isComposing) return;
    const items = Array.from(popover.querySelectorAll('.qc__nativeSearchPopover-item'));
    const isFilter = e.target?.id === GasNativeSearch.FILTER_ID;
    if (isFilter) {
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault?.();
        e.stopPropagation?.();
        items[0].focus?.();
      } else if (e.key === 'Enter' && items.length) {
        e.preventDefault?.();
        e.stopPropagation?.();
        items[0].click?.();
      }
      return;
    }
    this._moveFocus_(e, items);
  }

  /**
   * Texto traducido "N match(es)" / "N file(s)" con singular/plural.
   * @param {number} count
   * @param {'match'|'file'} kind
   * @returns {string}
   * @private
   */
  _countLabel_(count, kind) {
    if (kind === 'file') {
      return count === 1
        ? DomUtils.t('edSearchFileOne', '$1 file', count)
        : DomUtils.t('edSearchFileMany', '$1 files', count);
    }
    return count === 1
      ? DomUtils.t('edSearchMatchOne', '$1 match', count)
      : DomUtils.t('edSearchMatchMany', '$1 matches', count);
  }

  /**
   * Igual que `_countLabel_` pero con el número en `<strong>`: parte el
   * texto crudo y escapa cada trozo.
   * @param {number} count
   * @param {'match'|'file'} kind
   * @returns {string} HTML seguro.
   * @private
   */
  _countHtml_(count, kind) {
    const label = String(this._countLabel_(count, kind));
    const num = String(count);
    const at = label.indexOf(num);
    if (at < 0) return DomUtils.escapeHtml(label);
    return DomUtils.escapeHtml(label.slice(0, at))
      + `<strong>${DomUtils.escapeHtml(num)}</strong>`
      + DomUtils.escapeHtml(label.slice(at + num.length));
  }

  /** @private */
  _chevronDownSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 6 8 10 12 6"/></svg>`;
  }

  /** @private */
  _chevronLeftSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 4 6 8 10 12"/></svg>`;
  }

  /** @private */
  _chevronRightSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 4 10 8 6 12"/></svg>`;
  }

  /** @private */
  _fileSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h6.5L13 5.5V14H3z"/><path d="M9.5 2v3.5H13" stroke-linecap="round"/></svg>`;
  }

  /** @private */
  _magnifierSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4"/><path d="m13 13-2.7-2.7"/></svg>`;
  }

  /** @private */
  _listSvg_() {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h8M5 8h8M5 12h8"/><circle cx="2.5" cy="4" r=".75" fill="currentColor"/><circle cx="2.5" cy="8" r=".75" fill="currentColor"/><circle cx="2.5" cy="12" r=".75" fill="currentColor"/></svg>`;
  }
}

(function () {
  const service = new GasNativeSearch();
  if (typeof window !== 'undefined') window.gasNativeSearch = service;

  let initialApplied = false;

  document.addEventListener('GAS_TransferData', (e) => {
    if (initialApplied) return;
    initialApplied = true;
    try {
      const data = JSON.parse(e.detail);
      const settings = data.settings || {};
      if (settings['global-enable'] !== false) service.enable();
    } catch (err) {
      console.warn('[GasNativeSearch] Error en GAS_TransferData:', err);
    }
  });

  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('global-enable' in options) {
        options['global-enable'] ? service.enable() : service.disable();
      }
    } catch (err) {
      console.warn('[GasNativeSearch] Error en GAS_SettingsUpdated:', err);
    }
  });

  document.addEventListener('GAS_GlobalDisable', () => service.disable());
  document.addEventListener('GAS_GlobalEnable',  () => service.enable());
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasNativeSearch };
} else {
  window.GasNativeSearch = GasNativeSearch;
}
