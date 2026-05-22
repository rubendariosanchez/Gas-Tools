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
  }

  connectedCallback() {
    DomUtils.syncHostTheme(this);
    this._render_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);
    // Suscripción al singleton global: nos refrescamos automáticamente
    // cuando `gas-tools.js` actualiza el mapa.
    window.gasFileMap?.addEventListener?.('change', this._onFileMapChange);
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
    const pop = this.shadowRoot.getElementById('qcPopover');
    pop?.classList.remove('qc__open');
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

  /** Pinta el shadow DOM inicial (estilos + contenedor del popover). @private */
  _render_() {
    DomUtils.setHTML(this.shadowRoot, `
      <style>
        /* Design tokens compartidos: ver DomUtils.themeTokensCss(). */
        ${DomUtils.themeTokensCss()}

        :host {
          position: fixed;
          top: 0;
          left: 0;
          z-index: 100000;
          pointer-events: none;
          font-family: 'Google Sans', 'Roboto', sans-serif;
        }

        .qc__popover {
          position: fixed;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: 12px;
          box-shadow: var(--gc-shadow-menu);
          padding: 0;
          font-size: 12px;
          color: var(--gc-text);
          width: 280px;
          overflow: visible;
          display: none;
          pointer-events: auto;
        }
        .qc__popover.qc__open { display: block; }

        /* Flecha conectora apuntando al botón. Usa el color del header
           para no romper la continuidad visual. */
        .qc__popover::before,
        .qc__popover::after {
          content: '';
          position: absolute;
          top: -7px;
          right: var(--qc-arrow-offset, 24px);
          width: 0;
          height: 0;
          border-left: 7px solid transparent;
          border-right: 7px solid transparent;
        }
        .qc__popover::before { border-bottom: 7px solid var(--gc-border); }
        .qc__popover::after  { top: -6px; border-bottom: 7px solid var(--gc-accent-dim); }

        .qc__popover.qc__above::before,
        .qc__popover.qc__above::after {
          top: auto;
          bottom: -7px;
          border-bottom: none;
          border-top: 7px solid var(--gc-border);
        }
        .qc__popover.qc__above::after {
          bottom: -6px;
          border-top-color: var(--gc-bg-elevated);
        }

        /* Cabecera con icono + nombre destacado (color sólido). */
        .qc__pop-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          background: var(--gc-accent-dim);
          border-bottom: 1px solid var(--gc-border);
          border-top-left-radius: 12px;
          border-top-right-radius: 12px;
        }
        .qc__pop-icon {
          flex: 0 0 auto;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--gc-bg-elevated);
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }
        .qc__pop-icon svg { width: 18px; height: 18px; }
        .qc__pop-name {
          flex: 1 1 auto;
          font-size: 13px;
          font-weight: 600;
          color: var(--gc-accent);
          word-break: break-all;
          line-height: 1.3;
        }

        .qc__pop-body { padding: 12px 14px; }

        /* Grilla de stats principales. */
        .qc__stats {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 6px;
          margin-bottom: 12px;
        }
        .qc__stat {
          background: var(--gc-bg-raised);
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          padding: 8px 6px;
          text-align: center;
        }
        .qc__stat-value {
          font-size: 14px;
          font-weight: 700;
          color: var(--gc-text);
          line-height: 1.2;
        }
        .qc__stat-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: var(--gc-text-muted);
          margin-top: 2px;
        }

        .qc__section-title {
          font-weight: 600;
          color: var(--gc-text);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin: 8px 0 6px;
        }

        /* Lista de markers: siempre los 3 niveles principales. Las filas
           con conteo > 0 reciben un acento de color a la izquierda y
           contraste fuerte para que se distingan de un vistazo. */
        .qc__markers {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .qc__marker {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 6px;
          font-size: 12px;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-left-width: 3px;
        }
        .qc__marker.qc__zero {
          background: var(--gc-bg-raised);
          border-color: var(--gc-border);
          border-left-color: var(--gc-border);
          color: var(--gc-text-muted);
        }
        .qc__marker.qc__has.qc__error   { border-left-color: var(--gc-red);   background: var(--gc-red-dim);   border-color: var(--gc-red-soft); }
        .qc__marker.qc__has.qc__warning { border-left-color: var(--gc-amber); background: var(--gc-amber-soft); border-color: var(--gc-amber-soft); }
        .qc__marker.qc__has.qc__info    { border-left-color: var(--gc-accent); background: var(--gc-info-soft); border-color: var(--gc-accent-glow); }

        .qc__circle {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .qc__circle.qc__error   { background: var(--gc-red); }
        .qc__circle.qc__warning { background: var(--gc-amber); }
        .qc__circle.qc__info    { background: var(--gc-accent); }

        .qc__marker .qc__label { flex: 1 1 auto; color: var(--gc-text); font-weight: 500; }
        .qc__marker.qc__zero .qc__label { color: var(--gc-text-muted); font-weight: 500; }
        .qc__marker .qc__count {
          font-weight: 700;
          color: var(--gc-text);
          min-width: 18px;
          text-align: right;
        }
        .qc__marker.qc__zero .qc__count { color: var(--gc-text-faint); font-weight: 600; }
      </style>

      <div class="qc__popover" id="qcPopover" role="dialog" aria-label="File info"></div>
    `);
  }

  /** Engancha listeners de Monaco para auto-refresh del popover abierto. @private */
  _setupMonacoListeners_() {
    if (!this._editor || !window.monaco?.editor) return;

    const refresh = () => { if (this._popoverOpen) this.refresh(); };
    [
      this._editor.onDidChangeModel?.(refresh),
      this._editor.onDidChangeModelContent?.(refresh),
      window.monaco.editor.onDidChangeMarkers?.(refresh),
    ].forEach((d) => d && this._monacoDisposables.push(d));
  }

  /** Libera disposables de Monaco. @private */
  _teardownMonaco_() {
    this._monacoDisposables.forEach((d) => d?.dispose?.());
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
    return 'Untitled';
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
        <div class="qc__pop-header">
          <span class="qc__pop-icon">${this._svgFor_('generic')}</span>
          <span class="qc__pop-name">No active file</span>
        </div>
      `);
      pop.classList.add('qc__open');
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
      <div class="qc__pop-header">
        <span class="qc__pop-icon">${icon}</span>
        <span class="qc__pop-name">${this._escape_(info.name)}</span>
      </div>
      <div class="qc__pop-body">
        <div class="qc__stats">
          <div class="qc__stat">
            <div class="qc__stat-value">${this._escape_(lang)}</div>
            <div class="qc__stat-label">Language</div>
          </div>
          <div class="qc__stat">
            <div class="qc__stat-value">${info.lines.toLocaleString()}</div>
            <div class="qc__stat-label">Lines</div>
          </div>
          <div class="qc__stat">
            <div class="qc__stat-value">${sizeStr}</div>
            <div class="qc__stat-label">Size</div>
          </div>
        </div>
        <div class="qc__section-title">Diagnostics</div>
        ${this._renderMarkersList_(info.markers)}
      </div>
    `);
    pop.classList.add('qc__open');
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
      this._markerRow_('error',   'Errors',   m.error),
      this._markerRow_('warning', 'Warnings', m.warning),
      this._markerRow_('info',    'Info',     m.info),
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
        <span class="qc__label">${label}</span>
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
    // Fallback mínimo si gasFolders no está disponible.
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
      '<path d="M3 2h6.5L13 5.5V14H3z" stroke="#5f6368" stroke-width="1.2" stroke-linejoin="round"/>' +
      '</svg>';
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
   * Posiciona el popover relativo al ancla.
   *
   * Estrategia: alineamos el borde DERECHO del popover con el borde
   * derecho del ancla (crece hacia la izquierda). Si la altura no cabe
   * abajo, lo invertimos arriba (clase `qc__above`). La flecha se centra
   * sobre el ancla mediante la custom property `--qc-arrow-offset`.
   * @private
   */
  _positionPopover_() {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop || !this._anchorEl) return;

    const rect = this._anchorEl.getBoundingClientRect();
    const popW = pop.offsetWidth || 280;
    const popH = pop.offsetHeight || 240;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: alinear borde derecho del popover al borde derecho
    // del ancla; clampeamos al viewport en ambos extremos.
    let left = rect.right - popW;
    if (left < margin) left = margin;
    if (left + popW + margin > vw) left = vw - popW - margin;

    // Vertical: preferir abajo; si no cabe, intentamos arriba; si tampoco,
    // tomamos el lado con más espacio y clampeamos para no salirnos.
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    let top;
    let above = false;
    if (spaceBelow >= popH + 10) {
      top = rect.bottom + 10;
    } else if (spaceAbove >= popH + 10) {
      top = rect.top - popH - 10;
      above = true;
    } else if (spaceAbove >= spaceBelow) {
      top = Math.max(margin, rect.top - popH - 10);
      above = true;
    } else {
      top = Math.min(vh - popH - margin, rect.bottom + 10);
    }

    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;

    // Flecha apuntando al centro del ancla.
    const anchorCenter = rect.left + rect.width / 2;
    const arrowOffset = Math.max(
      14,
      Math.min(popW - 14, left + popW - anchorCenter - 7)
    );
    pop.style.setProperty('--qc-arrow-offset', `${arrowOffset}px`);
    pop.classList.toggle('qc__above', above);
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

  /** Escapa caracteres HTML para evitar XSS al pintar nombres. @private */
  _escape_(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

if (!customElements.get('gas-current-file')) {
  customElements.define('gas-current-file', GasCurrentFile);
}
