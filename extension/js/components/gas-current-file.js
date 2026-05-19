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
    /** @type {Map<string,string>} Mapa URI → nombre legible. */
    this._fileNameObjectMap = new Map();
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
  }

  connectedCallback() {
    this._render_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);
  }

  disconnectedCallback() {
    this._teardownMonaco_();
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('keydown',     this._onWindowKeyDown);
    window.removeEventListener('resize',      this._onWindowResize);
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
   * Inyecta el resolver URI → nombre real construido por gasTools.
   * @param {Map<string,string>} map
   */
  setFileNameObjectMap(map) {
    this._fileNameObjectMap = map || new Map();
    if (this._popoverOpen) this.refresh();
  }

  /**
   * Abre el popover anclado al elemento dado.
   * @param {HTMLElement} anchorEl Botón que actúa de ancla visual.
   */
  open(anchorEl) {
    if (anchorEl) this._anchorEl = anchorEl;
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
          background: #ffffff;
          border: 1px solid rgba(0,0,0,0.08);
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.16);
          padding: 12px 14px;
          font-size: 12px;
          color: #3c4043;
          width: 240px;
          display: none;
          pointer-events: auto;
        }
        .qc__popover.qc__open { display: block; }

        /* Flecha conectora apuntando al botón. */
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
        .qc__popover::before { border-bottom: 7px solid rgba(0,0,0,0.08); }
        .qc__popover::after  { top: -6px; border-bottom: 7px solid #ffffff; }

        .qc__popover.qc__above::before,
        .qc__popover.qc__above::after {
          top: auto;
          bottom: -7px;
          border-bottom: none;
          border-top: 7px solid rgba(0,0,0,0.08);
        }
        .qc__popover.qc__above::after {
          bottom: -6px;
          border-top-color: #ffffff;
        }

        .qc__pop-title {
          margin: 0 0 10px;
          font-size: 13px;
          font-weight: 600;
          color: #202124;
          word-break: break-all;
          line-height: 1.3;
        }

        .qc__row {
          display: flex;
          justify-content: space-between;
          padding: 5px 0;
          border-bottom: 1px solid rgba(0,0,0,0.06);
        }
        .qc__row:last-of-type { border-bottom: none; }
        .qc__row .qc__k { color: #5f6368; }
        .qc__row .qc__v { color: #202124; font-weight: 500; }

        .qc__section-title {
          margin-top: 12px;
          font-weight: 600;
          color: #202124;
          font-size: 12px;
        }

        .qc__markers {
          list-style: none;
          margin: 8px 0 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .qc__marker {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          font-size: 12px;
        }
        .qc__circle {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .qc__circle.qc__error   { background: #d93025; }
        .qc__circle.qc__warning { background: #f9ab00; }
        .qc__circle.qc__info    { background: #1a73e8; }
        .qc__circle.qc__hint    { background: #34a853; }

        .qc__marker .qc__label { flex: 1 1 auto; color: #3c4043; }
        .qc__marker .qc__count { font-weight: 600; color: #202124; }

        .qc__no-issues {
          color: #5f6368;
          font-style: italic;
          padding: 4px 0;
        }
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

    const markers = { error: 0, warning: 0, info: 0, hint: 0 };
    const list = window.monaco?.editor?.getModelMarkers?.({ resource: model.uri }) || [];
    for (const m of list) {
      switch (m.severity) {
        case 8: markers.error++;   break; // Error
        case 4: markers.warning++; break; // Warning
        case 2: markers.info++;    break; // Info
        case 1: markers.hint++;    break; // Hint
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
      DomUtils.setHTML(pop, '<h4 class="qc__pop-title">No active file</h4>');
      pop.classList.add('qc__open');
      return;
    }

    const sizeStr = info.bytes < 1024
      ? `${info.bytes} B`
      : `${(info.bytes / 1024).toFixed(1)} KB`;

    DomUtils.setHTML(pop, `
      <h4 class="qc__pop-title">${this._escape_(info.name)}</h4>
      <div class="qc__row"><span class="qc__k">Language</span><span class="qc__v">${this._escape_(info.language)}</span></div>
      <div class="qc__row"><span class="qc__k">Lines</span><span class="qc__v">${info.lines.toLocaleString()}</span></div>
      <div class="qc__row"><span class="qc__k">Size</span><span class="qc__v">${sizeStr}</span></div>
      <div class="qc__section-title">Diagnostics</div>
      ${this._renderMarkersList_(info.markers)}
    `);
    pop.classList.add('qc__open');
  }

  /**
   * Lista de markers (círculo + categoría + cantidad). Solo severidades > 0.
   * @param {{error:number, warning:number, info:number, hint:number}} m
   * @returns {string}
   * @private
   */
  _renderMarkersList_(m) {
    const total = m.error + m.warning + m.info + m.hint;
    if (total === 0) return '<div class="qc__no-issues">No issues found</div>';

    const rows = [];
    if (m.error)   rows.push(this._markerRow_('error',   'Errors',   m.error));
    if (m.warning) rows.push(this._markerRow_('warning', 'Warnings', m.warning));
    if (m.info)    rows.push(this._markerRow_('info',    'Info',     m.info));
    if (m.hint)    rows.push(this._markerRow_('hint',    'Hints',    m.hint));
    return `<ul class="qc__markers">${rows.join('')}</ul>`;
  }

  /** Una fila: punto de color + label + cantidad. @private */
  _markerRow_(severity, label, count) {
    return `
      <li class="qc__marker">
        <span class="qc__circle qc__${severity}"></span>
        <span class="qc__label">${label}</span>
        <span class="qc__count">${count}</span>
      </li>
    `;
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
    const popW = pop.offsetWidth || 240;
    const margin = 8;

    // Borde derecho del popover = borde derecho del ancla.
    let left = rect.right - popW;
    if (left < margin) left = margin;
    if (left + popW + margin > window.innerWidth) {
      left = window.innerWidth - popW - margin;
    }

    let top = rect.bottom + 10;
    const popH = pop.offsetHeight || 200;
    let above = false;
    if (top + popH + margin > window.innerHeight) {
      top = rect.top - popH - 10;
      above = true;
    }

    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;

    // Flecha apuntando al centro del ancla, expresada como offset desde el
    // borde derecho del popover.
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
