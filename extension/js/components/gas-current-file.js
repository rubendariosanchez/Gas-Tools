"use strict";

/**
 * @fileoverview <gas-current-file> - Popover con detalles del archivo activo.
 *
 * Componente "headless" de UI: no renderiza botón propio. El botón visible
 * lo inyecta `gas-tools.js` desde `currentFileButton.html` (estilo nativo
 * de GAS). Este componente solo se ocupa del **popover** que aparece al
 * hacer clic en el botón, anclado a él, con:
 *  - Nombre completo del archivo.
 *  - Lenguaje, líneas y tamaño.
 *  - Lista de markers de Error Lens con círculo de color por severidad.
 *
 * Web Component aislado en Shadow DOM. API pública: `open(anchor)`,
 * `close()`, `toggle(anchor)`, `setEditor(editor)`,
 * `setFileNameObjectMap(map)`, `refresh()`.
 */
class GasCurrentFile extends HTMLElement {

  /** CSS propio (sobre `GasUi.BASE_CSS`); se adopta una sola vez por raíz. */
  static STYLES = `
    :host {
      position: fixed;
      top: 0;
      left: 0;
      z-index: var(--gt-z-popover);
      pointer-events: none;
      font-family: var(--gt-font-plain);
    }

    .qc__popover { pointer-events: auto; }
    .qc__popover .gt-popover__header { padding: var(--gt-space-3) 14px; }
    .qc__popover .gt-popover__icon { color: var(--gt-on-surface-variant); }
    .qc__popover .gt-popover__icon svg { width: 18px; height: 18px; }
    .qc__pop-name { word-break: break-all; }

    .qc__pop-body { padding: var(--gt-space-3) 14px; }

    .qc__stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin-bottom: var(--gt-space-3);
    }
    .qc__stat {
      background: var(--gt-surface-container);
      border: 1px solid var(--gt-outline-variant);
      border-radius: var(--gt-shape-s);
      padding: var(--gt-space-2) 6px;
      text-align: center;
    }
    .qc__stat-value {
      font-size: 14px;
      font-weight: 700;
      color: var(--gt-on-surface);
      line-height: 1.2;
    }
    .qc__stat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--gt-on-surface-variant);
      margin-top: 2px;
    }

    .qc__section-title {
      font-weight: 600;
      color: var(--gt-on-surface);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: var(--gt-space-2) 0 6px;
    }

    /* Siempre los 3 niveles; las filas con conteo > 0 llevan acento de estado. */
    .qc__markers {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--gt-space-1);
    }
    .qc__marker {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: var(--gt-space-2) 10px;
      border-radius: var(--gt-shape-s);
      font-size: 12px;
      background: var(--gt-surface-bright);
      border: 1px solid var(--gt-outline-variant);
      border-left-width: 3px;
    }
    .qc__marker.qc__zero {
      background: var(--gt-surface-container);
      color: var(--gt-on-surface-variant);
    }
    .qc__marker.qc__has.qc__error   { border-color: color-mix(in srgb, var(--gt-error) 16%, transparent); border-left-color: var(--gt-error); background: var(--gt-error-container); }
    .qc__marker.qc__has.qc__warning { border-color: var(--gt-warning-container); border-left-color: var(--gt-warning); background: var(--gt-warning-container); }
    .qc__marker.qc__has.qc__info    { border-color: color-mix(in srgb, var(--gt-primary) 24%, transparent); border-left-color: var(--gt-primary); background: var(--gt-primary-container); }

    .qc__circle {
      width: 10px;
      height: 10px;
      border-radius: var(--gt-shape-full);
      flex: 0 0 auto;
    }
    .qc__circle.qc__error   { background: var(--gt-error); }
    .qc__circle.qc__warning { background: var(--gt-warning); }
    .qc__circle.qc__info    { background: var(--gt-primary); }

    .qc__marker .qc__label { flex: 1 1 auto; color: var(--gt-on-surface); font-weight: 500; }
    .qc__marker.qc__zero .qc__label { color: var(--gt-on-surface-variant); }
    .qc__marker .qc__count {
      font-weight: 700;
      color: var(--gt-on-surface);
      min-width: 18px;
      text-align: right;
    }
    .qc__marker.qc__zero .qc__count { color: var(--gt-outline); font-weight: 600; }
  `;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** @type {object|null} Instancia de Monaco Editor. */
    this._editor = null;
    /**
     * Mapa URI → nombre legible. Por defecto apunta al singleton global
     * `window.gasFileMap` para que el componente lea siempre el estado
     * más reciente sin necesidad de inyecciones manuales.
     * @type {Map<string,string>|object}
     */
    this._fileNameObjectMap = window.gasFileMap || new Map();
    /** @type {Array<{dispose:Function}>} Disposables de Monaco. */
    this._monacoDisposables = [];
    /** @type {boolean} Estado de visibilidad del popover. */
    this._popoverOpen = false;
    /** @type {HTMLElement|null} Botón ancla actual (re-posicionamiento). */
    this._anchorEl = null;

    // Binds estables para poder remover los mismos listeners.
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onWindowResize      = this._onWindowResize.bind(this);
    this._onFileMapChange     = this._onFileMapChange.bind(this);

    // Refresco diferido: evita reconstruir el popover en cada keystroke
    // o en cada ráfaga de `onDidChangeMarkers`.
    this._debouncedRefresh = DomUtils.debounce(() => this.refresh(), 250);
  }

  connectedCallback() {
    this._render_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);
    // Suscripción al singleton global: nos refrescamos automáticamente
    // cuando `gas-tools.js` actualiza el mapa.
    window.gasFileMap?.addEventListener?.('change', this._onFileMapChange);
    // Si se reconecta con un editor ya inyectado, re-enganchar Monaco
    // (disconnectedCallback los libera).
    if (this._editor && !this._monacoDisposables.length) this._setupMonacoListeners_();
  }

  disconnectedCallback() {
    this._teardownMonaco_();
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('keydown',     this._onWindowKeyDown);
    window.removeEventListener('resize',      this._onWindowResize);
    window.gasFileMap?.removeEventListener?.('change', this._onFileMapChange);
  }

  // ── API pública ────────────────────────────────────────────────────────

  /**
   * Inyecta el editor activo y reengancha listeners de Monaco para que el
   * popover se mantenga en sync mientras está abierto.
   * @param {object|null} editor
   */
  setEditor(editor) {
    this._editor = editor || null;
    this._teardownMonaco_();
    this._setupMonacoListeners_();
    if (this._popoverOpen) this.refresh();
  }

  /**
   * Sobre-escribe el mapa URI → nombre real con un Map externo.
   *
   * Mantenido por compatibilidad: el componente lee el singleton
   * `window.gasFileMap` automáticamente, así que normalmente no es
   * necesario llamar este método.
   *
   * @param {Map<string,string>|object} map
   */
  setFileNameObjectMap(map) {
    this._fileNameObjectMap = map || window.gasFileMap || new Map();
    if (this._popoverOpen) this.refresh();
  }

  /** Handler del evento `change` del singleton. @private */
  _onFileMapChange() {
    if (this._popoverOpen) this.refresh();
  }

  /**
   * Abre el popover anclado al elemento dado. Cierra otros paneles
   * flotantes (búsqueda y chat) para que la información no quede tapada.
   * @param {HTMLElement} anchorEl Botón que actúa de ancla visual.
   */
  open(anchorEl) {
    if (anchorEl) this._anchorEl = anchorEl;
    // Cerramos paneles que ocuparían el mismo espacio visual.
    DomUtils.closeOtherFloatingPanels('gas-current-file');
    this._popoverOpen = true;
    this._renderPopover_(this._collectInfo_());
    this._positionPopover_();
  }

  /** Cierra el popover. */
  close() {
    this._popoverOpen = false;
    this._debouncedRefresh.cancel();
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (pop) pop.hidden = true;
  }

  /**
   * Alterna el popover. Si está cerrado lo abre con el ancla dado; si
   * está abierto lo cierra.
   * @param {HTMLElement} anchorEl
   */
  toggle(anchorEl) {
    if (this._popoverOpen) this.close();
    else                    this.open(anchorEl);
  }

  /** Recalcula y repinta el popover si está abierto. */
  refresh() {
    if (!this._popoverOpen) return;
    this._renderPopover_(this._collectInfo_());
    this._positionPopover_();
  }

  // ── Render base ────────────────────────────────────────────────────────

  /** Pinta el shadow DOM inicial (contenedor del popover) y adopta estilos. @private */
  _render_() {
    DomUtils.setHTML(this.shadowRoot, `
      <div class="gt-popover gt-popover--card qc__popover" id="qcPopover" role="dialog" hidden aria-label="${DomUtils.escapeHtml(DomUtils.t('edFileInfo', 'File info'))}"></div>
    `);
    GasUi.adopt(this.shadowRoot, GasCurrentFile.STYLES);
  }

  /** Engancha listeners de Monaco para auto-refresh del popover abierto. @private */
  _setupMonacoListeners_() {
    if (!this._editor || !window.monaco?.editor) return;

    // Cambio de archivo: refresco inmediato (descarta uno pendiente).
    const refreshNow = () => {
      if (!this._popoverOpen || this._isPreviewModel_()) return;
      this._debouncedRefresh.cancel();
      this.refresh();
    };
    // Edición y markers: diferido (~250 ms) y solo con el popover abierto.
    const refreshLater = () => { if (this._popoverOpen && !this._isPreviewModel_()) this._debouncedRefresh(); };
    [
      this._editor.onDidChangeModel?.(refreshNow),
      this._editor.onDidChangeModelContent?.(refreshLater),
      window.monaco.editor.onDidChangeMarkers?.(refreshLater),
    ].forEach((d) => d && this._monacoDisposables.push(d));
  }

  /** `true` si el modelo activo es temporal (vista previa de cambios). @private */
  _isPreviewModel_() {
    return this._editor?.getModel?.()?.uri?.scheme === 'gas-preview';
  }

  /** Libera disposables de Monaco y cancela refrescos pendientes. @private */
  _teardownMonaco_() {
    this._debouncedRefresh.cancel();
    this._monacoDisposables.forEach((d) => { try { d?.dispose?.(); } catch (_) { /* editor ya destruido */ } });
    this._monacoDisposables = [];
  }

  // ── Información del modelo ────────────────────────────────────────────

  /**
   * Recoge información del archivo activo.
   * @returns {{name:string, language:string, lines:number, bytes:number, uri:string, markers:{error:number, warning:number, info:number, hint:number}}|null}
   * @private
   */
  _collectInfo_() {
    const model = this._editor?.getModel?.();
    if (!model) return null;

    const uri = String(model.uri || '');
    const name = this._resolveName_(model, uri);
    const text = model.getValue();
    const language = model.getLanguageId?.() || '—';
    const lines = model.getLineCount?.() || 0;
    const bytes = new Blob([text]).size;

    // Contadores de markers. Tratamos `hint` (severity 1) como `info`
    // (severity 2) para simplificar la lectura: ambos son sugerencias o
    // mejoras no bloqueantes que el usuario interpreta igual.
    const markers = { error: 0, warning: 0, info: 0 };
    const list = window.monaco?.editor?.getModelMarkers?.({ resource: model.uri }) || [];
    for (const m of list) {
      switch (m.severity) {
        case 8: markers.error++;   break; // Error
        case 4: markers.warning++; break; // Warning
        case 2: markers.info++;    break; // Info
        case 1: markers.info++;    break; // Hint → unificado con Info
      }
    }

    return { name, language, lines, bytes, uri, markers };
  }

  /**
   * Resuelve el nombre del archivo por mapa o por basename de la URI.
   * @param {object} model
   * @param {string} uri
   * @returns {string}
   * @private
   */
  _resolveName_(model, uri) {
    if (this._fileNameObjectMap?.has?.(uri)) {
      return this._fileNameObjectMap.get(uri);
    }
    const raw = String(model?.uri?.path || '').split('/').filter(Boolean).pop() || '';
    if (raw && /\.[a-z]+$/i.test(raw)) return raw;
    return DomUtils.t('edFileUntitled', 'Untitled');
  }

  // ── Render del popover ────────────────────────────────────────────────

  /**
   * Pinta el contenido del popover.
   * @param {object|null} info
   * @private
   */
  _renderPopover_(info) {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;
    if (!info) {
      DomUtils.setHTML(pop, `
        <div class="gt-popover__header">
          <span class="gt-popover__icon">${this._svgFor_('generic')}</span>
          <span class="gt-popover__title qc__pop-name">${DomUtils.escapeHtml(DomUtils.t('edFileNoActive', 'No active file'))}</span>
        </div>
      `);
      pop.hidden = false;
      return;
    }

    const sizeStr = info.bytes < 1024
      ? `${info.bytes} B`
      : info.bytes < 1024 * 1024
        ? `${(info.bytes / 1024).toFixed(1)} KB`
        : `${(info.bytes / 1024 / 1024).toFixed(2)} MB`;

    const icon = this._iconForLanguage_(info.language, info.name);
    const lang = this._humanLanguage_(info.language);

    DomUtils.setHTML(pop, `
      <div class="gt-popover__header">
        <span class="gt-popover__icon">${icon}</span>
        <span class="gt-popover__title qc__pop-name">${DomUtils.escapeHtml(info.name)}</span>
      </div>
      <div class="qc__pop-body">
        <div class="qc__stats">
          <div class="qc__stat">
            <div class="qc__stat-value">${DomUtils.escapeHtml(lang)}</div>
            <div class="qc__stat-label">${DomUtils.escapeHtml(DomUtils.t('edFileLanguage', 'Language'))}</div>
          </div>
          <div class="qc__stat">
            <div class="qc__stat-value">${info.lines.toLocaleString()}</div>
            <div class="qc__stat-label">${DomUtils.escapeHtml(DomUtils.t('edFileLines', 'Lines'))}</div>
          </div>
          <div class="qc__stat">
            <div class="qc__stat-value">${sizeStr}</div>
            <div class="qc__stat-label">${DomUtils.escapeHtml(DomUtils.t('edFileSize', 'Size'))}</div>
          </div>
        </div>
        <div class="qc__section-title">${DomUtils.escapeHtml(DomUtils.t('edFileDiagnostics', 'Diagnostics'))}</div>
        ${this._renderMarkersList_(info.markers)}
      </div>
    `);
    pop.hidden = false;
  }

  /**
   * Lista de markers. Muestra siempre los 3 niveles principales (error,
   * warning, info) aunque el conteo sea cero, para que el usuario tenga
   * una lectura inmediata del estado del archivo.
   *
   * @param {{error:number, warning:number, info:number, hint:number}} m
   * @returns {string}
   * @private
   */
  _renderMarkersList_(m) {
    const rows = [
      this._markerRow_('error',   DomUtils.t('edFileErrors', 'Errors'),   m.error),
      this._markerRow_('warning', DomUtils.t('edFileWarnings', 'Warnings'), m.warning),
      this._markerRow_('info',    DomUtils.t('edFileInfoLabel', 'Info'),     m.info),
    ];
    return `<ul class="qc__markers">${rows.join('')}</ul>`;
  }

  /**
   * Una fila: punto de color + label + cantidad. Las filas con conteo
   * cero se atenúan con `qc__zero` para distinguirlas de las activas.
   * @private
   */
  _markerRow_(severity, label, count) {
    const cls = count > 0
      ? `qc__has qc__${severity}`
      : `qc__zero qc__${severity}`;
    return `
      <li class="qc__marker ${cls}">
        <span class="qc__circle qc__${severity}"></span>
        <span class="qc__label">${DomUtils.escapeHtml(label)}</span>
        <span class="qc__count">${count}</span>
      </li>
    `;
  }

  /**
   * Devuelve el SVG del icono de archivo usando la instancia compartida
   * `window.gasFolders` (la misma que pinta los iconos del árbol). Así el
   * popover mantiene coherencia visual con el resto del IDE y respeta
   * cualquier color personalizado que el usuario haya configurado.
   *
   * @param {'gs'|'html'|'json'|'generic'} type
   * @returns {string}
   * @private
   */
  _svgFor_(type) {
    const folders = window.gasFolders;
    if (folders?._renderFileSvg_) {
      try { return folders._renderFileSvg_(type); }
      catch (_) { /* fallback inline */ }
    }
    // Fallback: icono del registro compartido (hereda currentColor).
    return GasUi.icon('file', 18);
  }

  /**
   * Mapea el lenguaje del modelo o la extensión del archivo a uno de los
   * 4 tipos que entiende `gasFolders._renderFileSvg_`.
   * @private
   */
  _iconForLanguage_(language, name) {
    const lang = String(language || '').toLowerCase();
    const ext  = String(name || '').toLowerCase().split('.').pop();
    if (ext === 'gs'   || lang === 'google apps script') return this._svgFor_('gs');
    if (ext === 'html' || lang === 'html')               return this._svgFor_('html');
    if (ext === 'json' || lang === 'json')               return this._svgFor_('json');
    return this._svgFor_('generic');
  }

  /**
   * Pasa el id de lenguaje de Monaco a una etiqueta legible.
   * @private
   */
  _humanLanguage_(language) {
    const lang = String(language || '').toLowerCase();
    if (lang === 'google apps script') return 'GAS';
    if (lang === 'javascript')         return 'GS';
    if (lang === 'typescript')         return 'GS';
    if (lang === 'html')               return 'HTML';
    if (lang === 'css')                return 'CSS';
    if (lang === 'json')               return 'JSON';
    if (lang === 'markdown')           return 'MD';
    if (!lang || lang === '—')         return '—';
    return language;
  }

  /**
   * Posiciona el popover alineado al borde derecho del ancla (flip vertical
   * y flecha en `GasUi.positionPopover`). Cierra si el ancla ya no existe.
   * @private
   */
  _positionPopover_() {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;
    // La toolbar se reinyecta al cambiar settings: re-resolvemos el ancla o cerramos.
    if (!this._resolveAnchor_()) {
      this.close();
      return;
    }
    GasUi.positionPopover(pop, this._anchorEl, { align: 'end', gap: 10 });
  }

  /**
   * Garantiza que `_anchorEl` siga en el DOM y sea visible. Si fue
   * reemplazado, toma el botón `#rsBtnCurrentFile` visible actual.
   * @returns {boolean} `true` si hay un ancla utilizable.
   * @private
   */
  _resolveAnchor_() {
    this._anchorEl = GasUi.liveAnchor(this._anchorEl, '#ctnCurrentFileName #rsBtnCurrentFile');
    return !!this._anchorEl;
  }

  /** Cierra al click fuera del popover y del ancla. @private */
  _onDocumentMouseDown(e) {
    if (!this._popoverOpen) return;
    const path = e.composedPath?.() || [];
    if (path.includes(this)) return;                  // dentro del popover
    if (this._anchorEl && path.includes(this._anchorEl)) return; // sobre el botón
    this.close();
  }

  /** Cierra con Escape. @private */
  _onWindowKeyDown(e) {
    if (this._popoverOpen && e.key === 'Escape') this.close();
  }

  /** Resize: reposiciona si está abierto. @private */
  _onWindowResize() {
    if (this._popoverOpen) this._positionPopover_();
  }
}

if (!customElements.get('gas-current-file')) {
  customElements.define('gas-current-file', GasCurrentFile);
}
