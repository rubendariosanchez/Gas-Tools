"use strict";

/**
 * @fileoverview gas-native-search.js
 *
 * Extiende el find widget nativo de Monaco con navegación entre archivos:
 *  - Inserta un contador `current/total` y dos botones de navegación
 *    (anterior / siguiente archivo) dentro del propio widget de búsqueda.
 *  - Registra atajos en el editor: `Ctrl+Alt+F` (siguiente archivo) y
 *    `Ctrl+Shift+F` (anterior archivo).
 *  - Limita la búsqueda a los modelos del proyecto (lee `window.gasFileMap`)
 *    para descartar workers, peek views y diff editors internos.
 *
 * Auto-inicializado: no requiere cableado desde gas-tools.js. Espera a
 * que `window.jsWireMonacoEditor` esté disponible y se engancha solo.
 * Respeta el toggle global de la extensión.
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
  static ACTION_NEXT  = 'qc__nativeSearch.findNextFile';
  static ACTION_PREV  = 'qc__nativeSearch.findPrevFile';
  static POPOVER_ID   = 'qc__nativeSearchPopover';
  static MATCHES_ID   = 'qc__nativeSearchMatchesPopover';
  static MATCHES_BTN  = 'qc__nativeSearchMatchesBtn';

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
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._debounceTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._readyTimer = null;
    /** Estado del popover de archivos. */
    this._popoverOpen = false;
    /** @type {Array<{uri:string,name:string,count:number,first:object}>} */
    this._lastGroups = [];
    /** @type {string} */
    this._lastQuery = '';
    /** Filtro local del popover. */
    this._popoverFilter = '';
    /** Query con la que el usuario cerró el popover; evita auto-reabrir. */
    this._userClosedQuery = '';
    /** Query para la que ya hicimos el auto-expand del replace-part. */
    this._autoExpandedFor = '';
    this._onPopoverOutside = this._onPopoverOutside.bind(this);
    this._onPopoverKey     = this._onPopoverKey.bind(this);
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

  // ── Inicialización ───────────────────────────────────────────────

  /** Polling ligero hasta que `jsWireMonacoEditor` exponga el contribution. @private */
  _waitForEditor_() {
    this._stopReadyTimer_();
    const tryAttach = () => {
      const editor = window.jsWireMonacoEditor;
      if (!editor || !window.monaco?.KeyCode) return false;
      const controller = editor.getContribution?.('editor.contrib.findController');
      if (!controller) return false;
      this._attach_(editor, controller);
      return true;
    };
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
   * Engancha el editor y el controller dados, registra los atajos y la
   * suscripción al state. Idempotente: si ya estamos enganchados al
   * mismo controller, no hace nada.
   * @private
   */
  _attach_(editor, controller) {
    if (this._editor === editor && this._controller === controller) return;
    this._teardown_();
    this._editor     = editor;
    this._controller = controller;

    const state = controller.getState?.();
    if (state?.onFindReplaceStateChange) {
      this._stateSub = state.onFindReplaceStateChange(() => this._onStateChange_());
    }

    this._registerActions_();
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
    this._actionDisposables.forEach((d) => { try { d.dispose?.(); } catch (_) {} });
    this._actionDisposables = [];
    if (this._stateSub?.dispose) {
      try { this._stateSub.dispose(); } catch (_) {}
    }
    this._stateSub   = null;
    this._controller = null;
    this._editor     = null;
    this._removeUi_();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  // ── Reacción a cambios de estado del find widget ─────────────────

  /** @private */
  _onStateChange_() {
    if (!this._enabled) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._refreshUi_(), 80);
  }

  /**
   * Sincroniza el UI extra (badge + botones) con el state actual.
   * @private
   */
  _refreshUi_() {
    if (!this._controller) return;
    const state = this._controller.getState?.();
    const query = state?.searchString || '';
    if (!query) {
      this._setButtonsDisabled_(true);
      this._setBadge_('', '', false);
      this._lastGroups = [];
      this._lastQuery  = '';
      this._userClosedQuery = '';
      this._autoExpandedFor = '';
      this._closePopover_();
      return;
    }
    this._ensureUi_();
    const matches = this._findAllMatches_(this._buildSearchParams_(state));
    const fileGroups = this._groupByFile_(matches);
    const total = fileGroups.length;
    const currentUri = this._editor.getModel?.().uri.toString();
    const idx = fileGroups.findIndex((g) => g.uri === currentUri);

    const hasOthers = total > 1 || (total === 1 && fileGroups[0].uri !== currentUri);
    this._setButtonsDisabled_(!hasOthers);

    const fileName = idx >= 0 ? fileGroups[idx].name : '';
    const position = total ? `${Math.max(idx, 0) + 1}/${total} files` : '';
    this._setBadge_(fileName, position, total > 0);

    // Mostrar el botón de "matches in this file" solo si el archivo
    // activo tiene más de una coincidencia: con una sola, no aporta
    // nada (la flecha siguiente del find widget basta).
    const currentGroup = idx >= 0 ? fileGroups[idx] : null;
    const matchesInCurrent = currentGroup?.count || 0;
    this._setMatchesBtnVisible_(matchesInCurrent > 1);
    if (matchesInCurrent <= 1) this._closeMatchesPopover_();

    this._lastGroups = fileGroups;
    this._lastQuery  = query;

    // Si la query trae matches y el panel de reemplazo (donde vive el
    // badge) está colapsado, abrirlo automáticamente la primera vez
    // para que el usuario vea la info de archivos sin tener que
    // expandirlo a mano.
    if (total > 0 && this._autoExpandedFor !== query) {
      if (this._expandReplacePart_()) {
        this._autoExpandedFor = query;
      }
    }

    if (this._popoverOpen) {
      this._renderPopover_();
      this._positionPopover_();
    }
  }

  /**
   * Si el toggle nativo de "alternar reemplazar" está colapsado,
   * lo expande (un click programático). Devuelve `true` cuando hizo
   * el click; `false` si ya estaba expandido o si no encontró el
   * botón aún (el widget no se ha pintado).
   * @returns {boolean}
   * @private
   */
  _expandReplacePart_() {
    const root = this._findWidgetRoot_();
    if (!root) return false;
    const toggle = root.querySelector('.button.toggle.left');
    if (!toggle) return false;
    if (!toggle.classList.contains('codicon-find-collapsed')) return false;
    toggle.click();
    return true;
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
    const params = this._buildSearchParams_(state);
    if (!params.searchString) return;

    const matches = this._findAllMatches_(params);
    const groups  = this._groupByFile_(matches);
    if (!groups.length) return;

    const currentUri = this._editor.getModel?.().uri.toString();
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
    this._setBadge_(groups[nextIdx].name, `${nextIdx + 1}/${groups.length} files`, true);
  }

  /**
   * Cambia (si hace falta) el modelo activo del editor y deja
   * seleccionado el match dado, sincronizando el findController para
   * que su contador "n de m" se actualice (evita el "? de m").
   *
   * Truco: posicionamos el cursor justo antes del match y disparamos
   * `nextMatchFindAction`, que es el comando que el widget nativo usa
   * cuando el usuario pulsa "siguiente".
   *
   * @param {{model:object, range:object}} target
   * @private
   */
  _jumpToMatch_(target) {
    if (!this._editor || !target?.model || !target?.range) return;
    if (this._editor.getModel() !== target.model) {
      this._editor.setModel(target.model);
    }
    const range = target.range;
    this._editor.setPosition({
      lineNumber: range.startLineNumber,
      column:     Math.max(1, range.startColumn - 1),
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
   * Agrupa los matches por archivo, preservando el orden de aparición
   * de los modelos. Para cada grupo guarda el primer match (para saltar)
   * y el nombre legible.
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
          || 'File';
        order.set(m.uri, { uri: m.uri, name, count: 1, first: m });
      }
    }
    return Array.from(order.values());
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
   * Recorre todos los modelos del proyecto y devuelve los matches
   * agrupados por archivo. Solo modelos presentes en `window.gasFileMap`
   * cuentan: descartamos workers, peek views, diff editors, etc.
   * @param {object} params
   * @returns {Array<{model:object, uri:string, range:object}>}
   * @private
   */
  _findAllMatches_(params) {
    if (!params.searchString) return [];
    const allModels = window.monaco?.editor?.getModels?.() || [];
    const map = window.gasFileMap;
    const hasMap = map && typeof map.has === 'function' && map.size > 0;
    const models = hasMap
      ? allModels.filter((m) => map.has(String(m.uri)))
      : allModels;

    const out = [];
    for (const model of models) {
      const found = model.findMatches(
        params.searchString, false,
        params.isRegex, params.matchCase, params.wholeWord, false,
      );
      for (const m of found || []) {
        out.push({ model, uri: model.uri.toString(), range: m.range });
      }
    }
    return out;
  }

  // ── UI ──────────────────────────────────────────────────────────

  /** @private */
  _findWidgetRoot_() {
    return this._controller?._widget?._domNode || null;
  }

  /**
   * Inserta el badge como una fila adicional dentro de `.replace-part`
   * del widget, con flex-wrap para que aparezca debajo de los inputs.
   * @private
   */
  _ensureUi_() {
    const root = this._findWidgetRoot_();
    if (!root) return;
    if (root.querySelector(`#${GasNativeSearch.BUTTONS_ID}`)) return;

    const replacePart = root.querySelector('.replace-part');
    if (!replacePart) return;

    const wrap = document.createElement('div');
    wrap.id = GasNativeSearch.BUTTONS_ID;
    wrap.className = 'qc__nativeSearchBar';

    DomUtils.setHTML(wrap, `
      <span class="qc__nativeSearchInfo">
        <span class="qc__nativeSearchIcon" aria-hidden="true"></span>
        <span class="qc__nativeSearchLabel">In file</span>
        <button id="qc__nativeSearchTrigger" type="button"
                class="qc__nativeSearchTrigger"
                aria-haspopup="listbox" aria-expanded="false"
                title="Show files with matches">
          <span id="qc__nativeSearchFile" class="qc__nativeSearchFile" title=""></span>
          <span class="qc__nativeSearchTriggerCaret" aria-hidden="true"></span>
        </button>
        <span id="qc__nativeSearchPos"  class="qc__nativeSearchPos"></span>
      </span>
      <span class="qc__nativeSearchActions">
        <button id="${GasNativeSearch.MATCHES_BTN}" type="button"
                class="qc__nativeSearchBtn"
                title="Show matches in this file" aria-label="Show matches"
                aria-haspopup="listbox" aria-expanded="false"></button>
        <button id="${GasNativeSearch.PREV_ID}" type="button"
                class="qc__nativeSearchBtn"
                title="Previous file (Ctrl+Shift+F)" aria-label="Previous file"></button>
        <button id="${GasNativeSearch.NEXT_ID}" type="button"
                class="qc__nativeSearchBtn"
                title="Next file (Ctrl+Alt+F)" aria-label="Next file"></button>
      </span>
    `);

    DomUtils.setHTML(wrap.querySelector('.qc__nativeSearchIcon'), this._fileSvg_());
    const prev = wrap.querySelector(`#${GasNativeSearch.PREV_ID}`);
    const next = wrap.querySelector(`#${GasNativeSearch.NEXT_ID}`);
    const list = wrap.querySelector(`#${GasNativeSearch.MATCHES_BTN}`);
    DomUtils.setHTML(prev, this._chevronLeftSvg_());
    DomUtils.setHTML(next, this._chevronRightSvg_());
    DomUtils.setHTML(list, this._listSvg_());

    const trigger = wrap.querySelector('#qc__nativeSearchTrigger');
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

    // Lo metemos en el contenedor de replace para que herede el flujo
    // del widget; el CSS lo fuerza a su propia fila vía flex-wrap.
    replacePart.appendChild(wrap);
    this._injectStyles_();
  }

  /** @private */
  _removeUi_() {
    document.getElementById(GasNativeSearch.BUTTONS_ID)?.remove();
    document.getElementById('qc__nativeSearchStyles')?.remove();
  }

  /** @private */
  _setButtonsDisabled_(disabled) {
    const root = this._findWidgetRoot_();
    if (!root) return;
    [GasNativeSearch.PREV_ID, GasNativeSearch.NEXT_ID].forEach((id) => {
      const btn = root.querySelector(`#${id}`);
      if (!btn) return;
      btn.toggleAttribute('disabled', !!disabled);
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  /** @private */
  _setMatchesBtnVisible_(visible) {
    const btn = document.getElementById(GasNativeSearch.MATCHES_BTN);
    if (!btn) return;
    btn.style.display = visible ? '' : 'none';
  }

  /**
   * Pinta el nombre del archivo actual y la posición `n/m files`.
   * @param {string} fileName
   * @param {string} position
   * @param {boolean} visible
   * @private
   */
  _setBadge_(fileName, position, visible) {
    const wrap = document.getElementById(GasNativeSearch.BUTTONS_ID);
    if (!wrap) return;
    wrap.classList.toggle('qc__nativeSearchBar--hidden', !visible);
    const fileEl = wrap.querySelector('#qc__nativeSearchFile');
    const posEl  = wrap.querySelector('#qc__nativeSearchPos');
    if (fileEl) {
      fileEl.textContent = fileName || '—';
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
      /* Permitir que la barra extra fluya a una nueva línea dentro
         del replace-part del find widget, sin afectar a otros widgets. */
      .monaco-editor .find-widget .replace-part {
        flex-wrap: wrap;
      }
      .monaco-editor .find-widget:has(#qc__nativeSearchButtons) {
        height: auto !important;
      }

      .qc__nativeSearchBar {
        display: flex;
        flex: 0 0 100%;
        align-items: center;
        gap: 8px;
        margin: 8px 4px 4px;
        padding: 4px 10px;
        height: 26px;
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
        color: var(--vscode-descriptionForeground, #888);
        text-transform: uppercase;
        letter-spacing: .04em;
        font-size: 10px;
      }
      .qc__nativeSearchFile {
        flex: 0 1 auto;
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
        background: transparent;
        border: 0;
        border-radius: 4px;
        color: inherit;
        font: inherit;
        cursor: pointer;
        padding: 2px 6px;
        max-width: 198px;
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
      .qc__nativeSearchTriggerCaret svg { width: 11px; height: 11px; display: block; }
      .qc__nativeSearchPos {
        flex: 0 0 auto;
        color: var(--vscode-descriptionForeground, #888);
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

      /* Popover de archivos con matches */
      .qc__nativeSearchPopover {
        position: fixed;
        z-index: 2147483647;
        width: 240px;
        max-height: 260px;
        display: flex;
        flex-direction: column;
        background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
        color: var(--vscode-foreground, #cccccc);
        border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.30));
        border-radius: 4px;
        box-shadow: 0 6px 20px rgba(0,0,0,.45);
        font-size: 12px;
        line-height: 1.4;
        overflow: visible;
      }
      /* Flecha tipo "tooltip": cuadrado rotado 45° con dos bordes
         visibles (los lados diagonales del triángulo). El fondo
         replica el stack del header: overlay rgba(127,127,127,.10)
         sobre var(--vscode-editorWidget-background). */
      .qc__nativeSearchPopover-arrow {
        position: absolute;
        width: 12px;
        height: 12px;
        margin-left: -6px;
        pointer-events: none;
        background:
          linear-gradient(rgba(127,127,127,.10), rgba(127,127,127,.10)),
          var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
        background-clip: padding-box;
        border: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.30));
        transform: rotate(45deg);
      }
      /* Popover DEBAJO del trigger: flecha apunta arriba; mostramos
         los bordes top+left, el resto se oculta detrás del popover. */
      .qc__nativeSearchPopover[data-placement="bottom"] .qc__nativeSearchPopover-arrow {
        top: -7px;
        border-right: 0;
        border-bottom: 0;
      }
      /* Popover ARRIBA: flecha apunta abajo; mostramos bottom+right. */
      .qc__nativeSearchPopover[data-placement="top"] .qc__nativeSearchPopover-arrow {
        bottom: -7px;
        border-top: 0;
        border-left: 0;
        background:
          var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
      }
      .qc__nativeSearchPopover-head {
        padding: 6px 10px;
        background: rgba(127,127,127,.10);
        border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25));
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #9d9d9d);
        border-top-left-radius: 4px;
        border-top-right-radius: 4px;
      }
      .qc__nativeSearchPopover-stat strong {
        color: var(--vscode-foreground, #cccccc);
        font-weight: 600;
      }
      .qc__nativeSearchPopover-sep {
        margin: 0 4px;
        opacity: .6;
      }
      .qc__nativeSearchPopover-search {
        padding: 6px 8px;
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25));
      }
      .qc__nativeSearchPopover-searchIcon {
        display: inline-flex;
        flex: 0 0 auto;
        color: var(--vscode-descriptionForeground, #9d9d9d);
      }
      .qc__nativeSearchPopover-searchIcon svg {
        width: 13px; height: 13px; display: block;
      }
      .qc__nativeSearchPopover-input {
        flex: 1 1 auto;
        background: var(--vscode-input-background, rgba(255,255,255,.04));
        color: var(--vscode-input-foreground, var(--vscode-foreground, #cccccc));
        border: 1px solid var(--vscode-input-border, rgba(127,127,127,.25));
        border-radius: 3px;
        padding: 3px 6px;
        font: inherit;
        outline: none;
      }
      .qc__nativeSearchPopover-input:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
      }
      .qc__nativeSearchPopover-list {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 4px;
        scrollbar-width: thin;
        scrollbar-color: rgba(127,127,127,.40) transparent;
      }
      .qc__nativeSearchPopover-list::-webkit-scrollbar { width: 8px; }
      .qc__nativeSearchPopover-list::-webkit-scrollbar-thumb {
        background: rgba(127,127,127,.40);
        border-radius: 8px;
      }
      .qc__nativeSearchPopover-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 4px 8px;
        background: transparent;
        border: 0;
        border-radius: 3px;
        color: var(--vscode-foreground, #cccccc);
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .qc__nativeSearchPopover-item:hover {
        background: var(--vscode-list-hoverBackground, rgba(127,127,127,.18));
      }
      .qc__nativeSearchPopover-item--active {
        background: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,.6));
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground, #ffffff));
      }
      .qc__nativeSearchPopover-icon {
        flex: 0 0 auto;
        display: inline-flex;
        width: 16px; height: 16px;
        align-items: center;
        justify-content: center;
      }
      .qc__nativeSearchPopover-icon svg { width: 14px; height: 14px; display: block; }
      .qc__nativeSearchPopover-name {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: inherit;
      }
      .qc__nativeSearchPopover-name mark {
        background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
        color: inherit;
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
        border-radius: 999px;
        background: var(--vscode-badge-background, rgba(127,127,127,.30));
        color: var(--vscode-badge-foreground, var(--vscode-foreground, #cccccc));
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .qc__nativeSearchPopover-item--active .qc__nativeSearchPopover-count {
        background: rgba(255,255,255,.22);
        color: inherit;
      }
      .qc__nativeSearchPopover-empty {
        padding: 16px;
        text-align: center;
        color: var(--vscode-descriptionForeground, #9d9d9d);
      }

      /* Match list (popover de matches del archivo actual). */
      .qc__nativeSearchMatchesPopover { width: 300px; }
      .qc__nativeSearchMatch-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 4px 8px;
        background: transparent;
        border: 0;
        border-radius: 3px;
        color: var(--vscode-foreground, #cccccc);
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .qc__nativeSearchMatch-item:hover {
        background: var(--vscode-list-hoverBackground, rgba(127,127,127,.18));
      }
      .qc__nativeSearchMatch-line {
        flex: 0 0 auto;
        min-width: 32px;
        padding: 1px 6px;
        text-align: right;
        color: var(--vscode-descriptionForeground, #9d9d9d);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      .qc__nativeSearchMatch-snippet {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11.5px;
      }
      .qc__nativeSearchMatch-snippet mark {
        background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,.33));
        color: inherit;
        padding: 0 1px;
        border-radius: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Popover de matches en el archivo actual ──────────────────────

  /** @private */
  _toggleMatchesPopover_() {
    const exists = document.getElementById(GasNativeSearch.MATCHES_ID);
    if (exists) {
      this._closeMatchesPopover_();
    } else {
      this._openMatchesPopover_();
    }
  }

  /** @private */
  _openMatchesPopover_() {
    const matches = this._currentFileMatches_();
    if (!matches.length) return;

    const popover = document.createElement('div');
    popover.id = GasNativeSearch.MATCHES_ID;
    popover.className = 'qc__nativeSearchPopover qc__nativeSearchMatchesPopover';
    popover.setAttribute('role', 'listbox');
    document.body.appendChild(popover);

    this._renderMatchesPopover_();
    this._positionMatchesPopover_();

    const btn = document.getElementById(GasNativeSearch.MATCHES_BTN);
    btn?.setAttribute('aria-expanded', 'true');

    this._onMatchesOutside = (e) => {
      const path = e.composedPath?.() || [];
      if (path.includes(popover)) return;
      if (btn && path.includes(btn)) return;
      this._closeMatchesPopover_();
    };
    this._onMatchesKey = (e) => {
      if (e.type === 'keydown' && e.key === 'Escape') {
        e.stopPropagation();
        this._closeMatchesPopover_();
        return;
      }
      if (e.type === 'resize') this._positionMatchesPopover_();
    };
    document.addEventListener('mousedown', this._onMatchesOutside, true);
    document.addEventListener('keydown', this._onMatchesKey, true);
    window.addEventListener('resize', this._onMatchesKey);
  }

  /** @private */
  _closeMatchesPopover_() {
    document.getElementById(GasNativeSearch.MATCHES_ID)?.remove();
    document.getElementById(GasNativeSearch.MATCHES_BTN)?.setAttribute('aria-expanded', 'false');
    if (this._onMatchesOutside) {
      document.removeEventListener('mousedown', this._onMatchesOutside, true);
      this._onMatchesOutside = null;
    }
    if (this._onMatchesKey) {
      document.removeEventListener('keydown', this._onMatchesKey, true);
      window.removeEventListener('resize', this._onMatchesKey);
      this._onMatchesKey = null;
    }
  }

  /** @private */
  _renderMatchesPopover_() {
    const popover = document.getElementById(GasNativeSearch.MATCHES_ID);
    if (!popover) return;
    const matches = this._currentFileMatches_();
    const fileName = this._editor?.getModel?.()
      ? (window.gasFileMap?.get?.(this._editor.getModel().uri.toString()) || '')
      : '';

    if (!matches.length) {
      DomUtils.setHTML(popover, `
        <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
        <div class="qc__nativeSearchPopover-empty">No matches in this file</div>
      `);
      return;
    }

    const itemsHtml = matches.map((m, i) => {
      return `
        <button class="qc__nativeSearchMatch-item" data-idx="${i}" type="button" role="option"
                title="Line ${m.line}, column ${m.column}">
          <span class="qc__nativeSearchMatch-line">${m.line}</span>
          <span class="qc__nativeSearchMatch-snippet">${this._renderSnippet_(m.text, m.matchText)}</span>
        </button>
      `;
    }).join('');

    DomUtils.setHTML(popover, `
      <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
      <div class="qc__nativeSearchPopover-head">
        <span class="qc__nativeSearchPopover-stat">
          <strong>${matches.length}</strong> match(es)${fileName ? ` · <span class="qc__nativeSearchPopover-name" title="${this._escapeAttr_(fileName)}">${this._escapeHtml_(fileName)}</span>` : ''}
        </span>
      </div>
      <div class="qc__nativeSearchPopover-list">${itemsHtml}</div>
    `);

    popover.querySelectorAll('.qc__nativeSearchMatch-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.idx);
        const target = matches[idx];
        if (!target) return;
        this._jumpToMatch_({ model: this._editor.getModel(), range: target.range });
        this._closeMatchesPopover_();
      });
    });
  }

  /** @private */
  _positionMatchesPopover_() {
    const popover = document.getElementById(GasNativeSearch.MATCHES_ID);
    const trigger = document.getElementById(GasNativeSearch.MATCHES_BTN);
    if (!popover || !trigger) return;

    const rect = trigger.getBoundingClientRect();
    const arrowSize = 6;
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = popover.offsetWidth  || 300;
    const h  = popover.offsetHeight || 240;

    // Alinear el borde derecho del popover con el botón.
    let left = rect.right - w;
    if (left < margin) left = margin;
    if (left + w + margin > vw) left = vw - w - margin;

    let top = rect.bottom + arrowSize;
    let placement = 'bottom';
    if (top + h + margin > vh && rect.top - h - arrowSize > margin) {
      top = rect.top - h - arrowSize;
      placement = 'top';
    }

    popover.style.left = `${left}px`;
    popover.style.top  = `${top}px`;
    popover.dataset.placement = placement;

    const arrow = popover.querySelector('.qc__nativeSearchPopover-arrow');
    if (arrow) {
      const triggerCenter = rect.left + rect.width / 2;
      const arrowLeft = Math.max(14, Math.min(w - 14, triggerCenter - left));
      arrow.style.left = `${arrowLeft}px`;
    }
  }

  /**
   * Devuelve los matches en el modelo activo con la línea ya recortada
   * para mostrar en el popover.
   * @returns {Array<{line:number, column:number, text:string, matchText:string, range:object}>}
   * @private
   */
  _currentFileMatches_() {
    const model = this._editor?.getModel?.();
    if (!model || !this._controller) return [];
    const params = this._buildSearchParams_(this._controller.getState?.());
    if (!params.searchString) return [];

    const found = model.findMatches(
      params.searchString, false,
      params.isRegex, params.matchCase, params.wholeWord, true,
    ) || [];

    return found.map((m) => {
      const lineText = model.getLineContent(m.range.startLineNumber);
      const matchText = lineText.slice(m.range.startColumn - 1, m.range.endColumn - 1);
      return {
        line: m.range.startLineNumber,
        column: m.range.startColumn,
        text: lineText,
        matchText,
        range: m.range,
      };
    });
  }

  /**
   * Recorta la línea alrededor del match y resalta la coincidencia.
   * @param {string} lineText
   * @param {string} matchText
   * @returns {string}
   * @private
   */
  _renderSnippet_(lineText, matchText) {
    if (!lineText) return '';
    const trimmed = lineText.replace(/^\s+/, '');
    const idx = matchText ? trimmed.toLowerCase().indexOf(matchText.toLowerCase()) : -1;
    const max = 80;
    let snippet = trimmed;
    if (snippet.length > max) {
      const start = Math.max(0, (idx >= 0 ? idx : 0) - 20);
      snippet = (start > 0 ? '…' : '') + snippet.slice(start, start + max) + (start + max < trimmed.length ? '…' : '');
    }
    if (!matchText) return this._escapeHtml_(snippet);
    const lower = snippet.toLowerCase();
    const at = lower.indexOf(matchText.toLowerCase());
    if (at < 0) return this._escapeHtml_(snippet);
    return this._escapeHtml_(snippet.slice(0, at))
      + `<mark>${this._escapeHtml_(snippet.slice(at, at + matchText.length))}</mark>`
      + this._escapeHtml_(snippet.slice(at + matchText.length));
  }

  // ── Popover de archivos ──────────────────────────────────────────

  /** @private */
  _togglePopover_() {
    if (this._popoverOpen) this._closePopover_();
    else                   this._openPopover_({ autoFocusFilter: true });
  }

  /**
   * Abre el popover. Si `autoFocusFilter` es true (apertura manual por
   * click) damos foco al input del filtro; si es false (auto-apertura
   * al tipear en el find widget nativo) NO robamos el foco al usuario.
   * @param {{autoFocusFilter?:boolean}} [opts]
   * @private
   */
  _openPopover_(opts = {}) {
    if (!this._lastGroups.length) return;
    const autoFocusFilter = opts.autoFocusFilter !== false;
    this._popoverOpen = true;
    this._popoverFilter = '';
    this._userClosedQuery = '';

    const popover = document.createElement('div');
    popover.id = GasNativeSearch.POPOVER_ID;
    popover.className = 'qc__nativeSearchPopover';
    popover.setAttribute('role', 'dialog');
    document.body.appendChild(popover);

    this._renderPopover_();
    this._positionPopover_();

    const trigger = document.getElementById('qc__nativeSearchTrigger');
    trigger?.setAttribute('aria-expanded', 'true');

    document.addEventListener('mousedown', this._onPopoverOutside, true);
    document.addEventListener('keydown', this._onPopoverKey, true);
    window.addEventListener('resize', this._onPopoverKey);

    if (autoFocusFilter) {
      requestAnimationFrame(() => {
        popover.querySelector('#qc__nativeSearchPopoverFilter')?.focus();
      });
    }
  }

  /** @private */
  _closePopover_() {
    if (!this._popoverOpen) return;
    this._popoverOpen = false;
    // Recordamos qué query tenía el usuario al cerrar para no
    // re-abrirlo automáticamente sin que cambie la búsqueda.
    this._userClosedQuery = this._lastQuery;
    document.getElementById(GasNativeSearch.POPOVER_ID)?.remove();
    document.removeEventListener('mousedown', this._onPopoverOutside, true);
    document.removeEventListener('keydown', this._onPopoverKey, true);
    window.removeEventListener('resize', this._onPopoverKey);
    document.getElementById('qc__nativeSearchTrigger')?.setAttribute('aria-expanded', 'false');
  }

  /** @private */
  _renderPopover_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    if (!popover) return;
    const currentUri = this._editor?.getModel?.().uri.toString();
    const groups = this._lastGroups;

    const filter = this._popoverFilter.toLowerCase();
    const visible = filter
      ? groups.filter((g) => g.name.toLowerCase().includes(filter))
      : groups;

    const totalMatches = groups.reduce((acc, g) => acc + g.count, 0);

    const itemsHtml = visible.map((g) => {
      const realIdx = groups.indexOf(g);
      const isActive = g.uri === currentUri;
      return `
        <button class="qc__nativeSearchPopover-item ${isActive ? 'qc__nativeSearchPopover-item--active' : ''}"
                data-idx="${realIdx}" type="button" role="option" aria-selected="${isActive}"
                title="${this._escapeAttr_(g.name)}">
          <span class="qc__nativeSearchPopover-icon" aria-hidden="true">${this._iconForFile_(g.name)}</span>
          <span class="qc__nativeSearchPopover-name">${this._highlightFilter_(g.name, this._popoverFilter)}</span>
          <span class="qc__nativeSearchPopover-count" title="${g.count} match(es)">${g.count}</span>
        </button>
      `;
    }).join('');

    DomUtils.setHTML(popover, `
      <div class="qc__nativeSearchPopover-arrow" aria-hidden="true"></div>
      <div class="qc__nativeSearchPopover-head">
        <span class="qc__nativeSearchPopover-stat">
          <strong>${groups.length}</strong> file(s)
          <span class="qc__nativeSearchPopover-sep">·</span>
          <strong>${totalMatches}</strong> match(es)
        </span>
      </div>
      <div class="qc__nativeSearchPopover-search">
        <span class="qc__nativeSearchPopover-searchIcon" aria-hidden="true"></span>
        <input id="qc__nativeSearchPopoverFilter" type="text"
               class="qc__nativeSearchPopover-input"
               placeholder="Filter files…"
               autocomplete="off" spellcheck="false"
               value="${this._escapeAttr_(this._popoverFilter)}">
      </div>
      <div class="qc__nativeSearchPopover-list" role="listbox">${itemsHtml || `<div class="qc__nativeSearchPopover-empty">No files match this filter</div>`}</div>
    `);

    DomUtils.setHTML(
      popover.querySelector('.qc__nativeSearchPopover-searchIcon'),
      this._magnifierSvg_(),
    );

    const input = popover.querySelector('#qc__nativeSearchPopoverFilter');
    input.addEventListener('input', (e) => {
      this._popoverFilter = String(e.target.value || '');
      this._renderPopover_();
      // Reposicionamos por si el alto del popover cambió.
      this._positionPopover_();
      // Mantener foco tras el re-render.
      requestAnimationFrame(() => {
        const next = document.getElementById('qc__nativeSearchPopoverFilter');
        if (next && document.activeElement !== next) {
          next.focus();
          next.setSelectionRange(this._popoverFilter.length, this._popoverFilter.length);
        }
      });
    });

    popover.querySelectorAll('.qc__nativeSearchPopover-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.idx);
        const target = this._lastGroups[idx];
        if (!target?.first) return;
        this._jumpToMatch_(target.first);
        this._closePopover_();
      });
    });
  }

  /**
   * Devuelve el SVG del icono usando la instancia compartida
   * `window.gasFolders` (la misma que pinta el árbol de archivos).
   * @param {string} fileName
   * @returns {string}
   * @private
   */
  _iconForFile_(fileName) {
    const folders = window.gasFolders;
    if (folders?._renderFileSvg_) {
      const ext = String(fileName || '').split('.').pop().toLowerCase();
      const type = (ext === 'gs' || ext === 'html' || ext === 'json') ? ext : 'generic';
      try { return folders._renderFileSvg_(type); }
      catch (_) { /* noop */ }
    }
    return this._fileSvg_();
  }

  /**
   * Devuelve el nombre con el filtro resaltado como `<mark>` para
   * dar retroalimentación visual al usuario que está filtrando.
   * @param {string} name
   * @param {string} filter
   * @returns {string}
   * @private
   */
  _highlightFilter_(name, filter) {
    if (!filter) return this._escapeHtml_(name);
    const lower = name.toLowerCase();
    const idx = lower.indexOf(filter.toLowerCase());
    if (idx < 0) return this._escapeHtml_(name);
    const before = name.slice(0, idx);
    const match  = name.slice(idx, idx + filter.length);
    const after  = name.slice(idx + filter.length);
    return `${this._escapeHtml_(before)}<mark>${this._escapeHtml_(match)}</mark>${this._escapeHtml_(after)}`;
  }

  /** @private */
  _positionPopover_() {
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const trigger = document.getElementById('qc__nativeSearchTrigger');
    if (!popover || !trigger) return;

    const rect = trigger.getBoundingClientRect();
    const margin = 6;
    const arrowSize = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = popover.offsetWidth  || 240;
    const h  = popover.offsetHeight || 240;

    let left = rect.left;
    if (left + w + margin > vw) left = vw - w - margin;
    if (left < margin) left = margin;

    let top = rect.bottom + arrowSize;
    let placement = 'bottom';
    if (top + h + margin > vh && rect.top - h - arrowSize > margin) {
      top = rect.top - h - arrowSize;
      placement = 'top';
    }

    popover.style.left = `${left}px`;
    popover.style.top  = `${top}px`;
    popover.dataset.placement = placement;

    // Posicionar la flecha apuntando al centro del trigger.
    const arrow = popover.querySelector('.qc__nativeSearchPopover-arrow');
    if (arrow) {
      const triggerCenter = rect.left + rect.width / 2;
      const arrowLeft = Math.max(14, Math.min(w - 14, triggerCenter - left));
      arrow.style.left = `${arrowLeft}px`;
    }
  }

  /** @private */
  _onPopoverOutside(e) {
    if (!this._popoverOpen) return;
    const popover = document.getElementById(GasNativeSearch.POPOVER_ID);
    const trigger = document.getElementById('qc__nativeSearchTrigger');
    const path = e.composedPath?.() || [];
    if (popover && path.includes(popover)) return;
    if (trigger && path.includes(trigger)) return;
    this._closePopover_();
  }

  /** @private */
  _onPopoverKey(e) {
    if (!this._popoverOpen) return;
    if (e.type === 'keydown' && e.key === 'Escape') {
      e.stopPropagation();
      this._closePopover_();
      return;
    }
    if (e.type === 'resize') this._positionPopover_();
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

  /** @private */
  _escapeHtml_(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** @private */
  _escapeAttr_(value) {
    return this._escapeHtml_(value).replace(/"/g, '&quot;');
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
