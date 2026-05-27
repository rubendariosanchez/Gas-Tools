"use strict";

/**
 * @fileoverview <gas-actions-panel> - Popover con utilidades del proyecto.
 *
 * Headless UI: el botón visible lo inyecta `gas-tools.js` desde
 * `actionsButton.html`. Este componente solo se ocupa del **popover**
 * que aparece al hacer clic, anclado al botón. Mantiene estado propio
 * para los toggles persistentes (p. ej. ocultar el árbol de archivos)
 * vía `localStorage`.
 *
 * API pública: `open(anchor)`, `close()`, `toggle(anchor)`, `refresh()`.
 *
 * Convenciones:
 *  - Clases CSS con prefijo `qc__` (Shadow DOM aislado).
 *  - Iconos Material Icons, igual que el resto del IDE.
 */
class GasActionsPanel extends HTMLElement {

  /** Clave del flag persistente "ocultar árbol de archivos". */
  static STORAGE_KEY_HIDE_TREE = 'qc__hideFileTree';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** @type {boolean} Estado de visibilidad del popover. */
    this._open = false;
    /** @type {HTMLElement|null} Botón ancla (re-posicionamiento). */
    this._anchorEl = null;

    // Binds estables.
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onWindowResize      = this._onWindowResize.bind(this);
    this._onActionClick       = this._onActionClick.bind(this);
  }

  connectedCallback() {
    DomUtils.syncHostTheme(this);
    this._render_();
    this._watchSidebar_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);
    // Aplicar el estado persistido al cargar (ocultar árbol si correspondía).
    if (this._readHideTree_()) this._applyHideTree_(true);
  }

  disconnectedCallback() {
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('keydown',     this._onWindowKeyDown);
    window.removeEventListener('resize',      this._onWindowResize);
    this._sidebarObserver?.disconnect();
    this._sidebarObserver = null;
  }

  // ── API pública ────────────────────────────────────────────────────────

  /**
   * Abre el popover anclado al elemento dado. Cierra otros paneles
   * flotantes para que la información no quede tapada.
   * @param {HTMLElement} anchorEl
   */
  open(anchorEl) {
    if (anchorEl) this._anchorEl = anchorEl;
    DomUtils.closeOtherFloatingPanels('gas-actions-panel');
    this._open = true;
    this._renderPopover_();
    this._positionPopover_();
  }

  /** Cierra el popover. */
  close() {
    this._open = false;
    this.shadowRoot.getElementById('qcPopover')?.classList.remove('qc__open');
  }

  /**
   * Alterna el popover.
   * @param {HTMLElement} anchorEl
   */
  toggle(anchorEl) {
    if (this._open) this.close();
    else            this.open(anchorEl);
  }

  /** Repinta el popover si está abierto (refleja cambios de estado). */
  refresh() {
    if (this._open) this._renderPopover_();
  }

  // ── Render base ────────────────────────────────────────────────────────

  /** Pinta el shadow DOM inicial (estilos + contenedor). @private */
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

        /* Material Icons dentro del Shadow: la fuente la carga GAS, pero
           el Shadow DOM aisla los estilos, así que repetimos el set de
           reglas oficial para que las ligaduras funcionen. */
        .material-icons {
          font-family: 'Material Icons', 'Material Icons Extended', 'Google Material Icons', sans-serif;
          font-weight: normal;
          font-style: normal;
          font-size: 18px;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          direction: ltr;
          -webkit-font-feature-settings: 'liga';
          -webkit-font-smoothing: antialiased;
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
        .qc__popover::before { border-bottom: 7px solid var(--gc-border); }
        .qc__popover::after  { top: -6px; border-bottom: 7px solid var(--gc-bg-elevated); }

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

        .qc__pop-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          background: var(--gc-accent-dim);
          border-bottom: 1px solid var(--gc-border);
          border-top-left-radius: 12px;
          border-top-right-radius: 12px;
        }
        .qc__pop-icon {
          flex: 0 0 auto;
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--gc-bg-elevated);
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          color: var(--gc-accent);
        }
        .qc__pop-icon .material-icons { font-size: 18px; }
        .qc__pop-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--gc-accent);
        }

        .qc__pop-body { padding: 6px; }

        .qc__group-title {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--gc-text-muted);
          padding: 6px 8px 4px;
        }

        .qc__action {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 8px 10px;
          background: transparent;
          border: none;
          border-radius: 6px;
          font: inherit;
          font-size: 12px;
          color: var(--gc-text);
          text-align: left;
          cursor: pointer;
        }
        .qc__action:hover { background: var(--gc-bg-raised); }
        .qc__action:focus-visible {
          outline: 2px solid var(--gc-accent);
          outline-offset: -2px;
        }
        .qc__action-icon {
          flex: 0 0 auto;
          color: var(--gc-text-muted);
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .qc__action-icon .material-icons { font-size: 18px; }
        .qc__action-label { flex: 1 1 auto; }
        .qc__action-meta {
          flex: 0 0 auto;
          font-size: 11px;
          color: var(--gc-text-muted);
        }

        /* Toggle pill al final de la fila. */
        .qc__pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.4px;
          text-transform: uppercase;
        }
        .qc__pill.qc__on  { background: var(--gc-green-soft); color: var(--gc-green-text); }
        .qc__pill.qc__off { background: var(--gc-bg-raised); color: var(--gc-text-muted); }

        .qc__action.qc__danger { color: var(--gc-red-text); }
        .qc__action.qc__danger .qc__action-icon { color: var(--gc-red-text); }
        .qc__action.qc__danger:hover { background: var(--gc-red-dim); }

        /* Fila estática (no clicable) con label + botón ícono al final.
           Usada para "Script ID" donde el ID se mantiene oculto y el
           usuario interactúa solo con el botón copiar. */
        .qc__row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          font-size: 12px;
          color: var(--gc-text);
        }
        .qc__row .qc__action-icon {
          flex: 0 0 auto;
          color: var(--gc-text-muted);
          display: inline-flex;
        }
        .qc__row .qc__action-icon .material-icons { font-size: 18px; }
        .qc__row .qc__action-label { flex: 1 1 auto; }

        /* Botón icónico al final de una fila, solo afecta al icono. */
        .qc__icon-btn {
          flex: 0 0 auto;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 6px;
          width: 28px;
          height: 28px;
          padding: 0;
          margin: 0;
          box-sizing: border-box;
          cursor: pointer;
          color: var(--gc-accent);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
        }
        .qc__icon-btn:hover {
          background: var(--gc-accent-dim);
          border-color: var(--gc-accent-glow);
        }
        .qc__icon-btn:disabled {
          color: var(--gc-text-faint);
          cursor: default;
        }
        .qc__icon-btn:disabled:hover { background: transparent; border-color: transparent; }
        .qc__icon-btn .material-icons {
          font-size: 18px;
          line-height: 1;
          display: block;
        }
        .qc__icon-btn.qc__copied {
          color: var(--gc-green-text);
          background: var(--gc-green-soft);
          border-color: var(--gc-green-dim);
        }

        .qc__divider {
          height: 1px;
          background: var(--gc-border);
          margin: 4px 6px;
        }
      </style>

      <div class="qc__popover" id="qcPopover" role="dialog" aria-label="Project actions"></div>
    `);
  }

  // ── Render del popover ────────────────────────────────────────────────

  /** Pinta el contenido del popover. @private */
  _renderPopover_() {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;

    const hideTree = this._readHideTree_();
    const scriptId = this._getScriptId_();

    DomUtils.setHTML(pop, `
      <div class="qc__pop-header">
        <span class="qc__pop-icon"><i class="material-icons">tune</i></span>
        <span class="qc__pop-title">Project actions</span>
      </div>
      <div class="qc__pop-body">
        <div class="qc__group-title">View</div>
        <button class="qc__action" data-action="toggle-tree">
          <span class="qc__action-icon"><i class="material-icons">${hideTree ? 'chevron_right' : 'chevron_left'}</i></span>
          <span class="qc__action-label">${hideTree ? 'Show' : 'Hide'} file tree</span>
          <span class="qc__pill ${hideTree ? 'qc__off' : 'qc__on'}">${hideTree ? 'Off' : 'On'}</span>
        </button>

        <div class="qc__divider"></div>
        <div class="qc__group-title">Project</div>

        <!-- Fila Script ID con botón copiar a la derecha -->
        <div class="qc__row">
          <span class="qc__action-icon"><i class="material-icons">tag</i></span>
          <span class="qc__action-label">Script ID</span>
          <button class="qc__icon-btn" data-action="copy-id"
                  ${scriptId ? '' : 'disabled'}
                  title="Copy script ID" aria-label="Copy script ID">
            <i class="material-icons" id="qcCopyIcon">content_copy</i>
          </button>
        </div>

        <button class="qc__action" data-action="download" ${scriptId ? '' : 'disabled'}>
          <span class="qc__action-icon"><i class="material-icons">download</i></span>
          <span class="qc__action-label">Download project</span>
          <span class="qc__action-meta" id="qcDownloadStatus"></span>
        </button>

        <button class="qc__action qc__danger" data-action="bulk-delete" ${scriptId ? '' : 'disabled'}>
          <span class="qc__action-icon"><i class="material-icons">delete_sweep</i></span>
          <span class="qc__action-label">Bulk delete files…</span>
        </button>
      </div>
    `);

    // Click delegado.
    pop.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', this._onActionClick);
    });
    pop.classList.add('qc__open');
  }

  // ── Acciones ──────────────────────────────────────────────────────────

  /** @private */
  _onActionClick(e) {
    const btn = e.currentTarget;
    const action = btn?.dataset?.action;
    if (!action || btn.hasAttribute('disabled')) return;

    switch (action) {
      case 'toggle-tree':  this._toggleFileTree_(); break;
      case 'copy-id':      this._copyScriptId_(btn); break;
      case 'download':     this._downloadProject_(btn); break;
      case 'bulk-delete':  this._openBulkDeleteModal_(); break;
    }
  }

  /**
   * Permite tener un metodo para forzar la apertura delpanel de archivos.
   */
  showPanel() {

    // Forzamos que el panel de archivos esté abierto.
    this._writeHideTree_(false);
    this._applyHideTree_(false);
    this.refresh();
  }

  /** Persiste y aplica el toggle de visibilidad del árbol. @private */
  _toggleFileTree_() {
    const next = !this._readHideTree_();
    this._writeHideTree_(next);
    this._applyHideTree_(next);
    this.refresh();
  }

  /**
   * Aplica visualmente el toggle del árbol de archivos. GAS muestra el
   * árbol dentro de un contenedor con `aria-label="File browser"`; lo
   * ocultamos / mostramos cambiando su `display`.
   * @param {boolean} hidden
   * @private
   */
  _applyHideTree_(hidden) {
    const tree = document.querySelector('[aria-label="File browser"]')
              || document.querySelector('.Kp2okb.SQyOec'); // fallback selector legado.
    if (!tree) return;
    tree.style.display = hidden ? 'none' : '';

    // Reposicionar tras el reflow causado por el cambio de display.
    if (this._open) requestAnimationFrame(() => this._positionPopover_());
  }

  /**
   * Copia el script ID al portapapeles. Muestra feedback visual en el
   * propio botón (icono cambia a `done` con fondo verde) en lugar de
   * imprimir el ID, manteniéndolo privado.
   * @param {HTMLButtonElement} btn Botón origen del click.
   * @private
   */
  async _copyScriptId_(btn) {
    const id = this._getScriptId_();
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this._flashCopyOk_(btn);
    } catch (_) {
      this._toast_('Could not copy to clipboard');
    }
  }

  /**
   * Pinta el botón en verde con icono `done` durante 1.4 s y luego lo
   * restaura.
   * @param {HTMLButtonElement} btn
   * @private
   */
  _flashCopyOk_(btn) {
    if (!btn) return;
    const icon = btn.querySelector('.material-icons');
    if (!icon) return;
    btn.classList.add('qc__copied');
    icon.textContent = 'done';
    btn.setAttribute('aria-label', 'Copied');
    clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      btn.classList.remove('qc__copied');
      icon.textContent = 'content_copy';
      btn.setAttribute('aria-label', 'Copy script ID');
    }, 1400);
  }

  /**
   * Observa el sidebar con ResizeObserver para reposicionar el popover
   * cuando cambia de tamaño (colapso, expansión, toggle del árbol).
   * Se llama una sola vez en connectedCallback; se desconecta en
   * disconnectedCallback.
   * @private
   */
  _watchSidebar_() {
    this._sidebarObserver?.disconnect();
    const sidebar = document.querySelector('[aria-label="File browser"]')
                || document.querySelector('.Kp2okb.SQyOec');
    if (!sidebar) return;
    this._sidebarObserver = new ResizeObserver(() => {
      if (this._open) this._positionPopover_();
    });
    // Observamos el padre del sidebar para capturar también el caso en que
    // el elemento se oculta con display:none (ResizeObserver no dispara en
    // ese caso directamente, pero sí en el contenedor padre que colapsa).
    this._sidebarObserver.observe(sidebar.parentElement || sidebar);
  }

  /**
   * Descarga el proyecto Apps Script como ZIP usando el bridge al
   * background service worker.
   *
   * @param {HTMLButtonElement} btn Botón origen del click.
   * @private
   */
  async _downloadProject_(btn) {
    const id = this._getScriptId_();
    if (!id) return;
    const status = this.shadowRoot.getElementById('qcDownloadStatus');
    const setStatus = (text) => { if (status) status.textContent = text; };
    setStatus('Fetching…');
    btn.setAttribute('disabled', '');
    try {
      const response = await this._requestDownload_(id);
      if (!response?.ok) throw new Error(response?.error || 'Unknown error');
      const data = response.data;
      if (!data) throw new Error('Empty response');

      setStatus('Packing…');

      const zipFiles = [];
      for (const file of data.files || []) {
        const ext      = file.type === 'html' ? '.html' : '.gs';
        const filePath = file.name.includes('.') ? file.name : `${file.name}${ext}`;
        zipFiles.push({ name: filePath, content: file.source || '' });
      }

      // appsscript.json
      const hasMeta = (data.files || []).some(f => f.name === 'appsscript');
      if (data.scriptId && !hasMeta) {
        const meta = {
          timeZone:         data.timeZone         || 'America/New_York',
          dependencies:     data.dependencies     || {},
          exceptionLogging: data.exceptionLogging || 'STACKDRIVER',
          runtimeVersion:   data.runtimeVersion   || 'V8',
        };
        zipFiles.push({ name: 'appsscript.json', content: JSON.stringify(meta, null, 2) });
      }

      const zipBytes = this._buildZip_(zipFiles);
      const blob     = new Blob([zipBytes], { type: 'application/zip' });
      setStatus('Saving…');
      const dlUrl = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href     = dlUrl;
      a.download = this._buildDownloadFileName_();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 2000);

      setStatus('Done ✓');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      console.warn('[GASTools] Download failed:', err);
      setStatus('Failed');
      setTimeout(() => setStatus(''), 2400);
    } finally {
      btn.removeAttribute('disabled');
    }
  }

  /**
   * Genera el nombre del archivo ZIP de descarga con marca de tiempo.
   * Formato: Project_AAAAMMDD_HHMMSS_milisegundos.zip
   * Ejemplo:  Project_20260520_143022_847.zip
   * @returns {string}
   * @private
   */
  _buildDownloadFileName_() {
    const now_ = new Date();
    const rellenar = (n, largo = 2) => String(n).padStart(largo, '0');

    // Fecha: año (4 dígitos) + mes + día
    const currDateStr_ = `${now_.getFullYear()}${rellenar(now_.getMonth() + 1)}${rellenar(now_.getDate())}`;

    // Hora: horas + minutos + segundos (cada uno con 2 dígitos)
    const currTimeStr_ = `${rellenar(now_.getHours())}${rellenar(now_.getMinutes())}${rellenar(now_.getSeconds())}`;

    // Milisegundos al final para unicidad dentro del mismo segundo
    return `Project_${currDateStr_}_${currTimeStr_}_${now_.getMilliseconds()}.zip`;
  }

  /**
   * Construye un archivo ZIP en memoria sin librerías externas.
   * Solo soporta almacenamiento sin compresión (method=0), suficiente
   * para archivos de texto como .gs, .html y .json.
   * @param {Array<{name:string, content:string}>} files
   * @returns {Uint8Array}
   * @private
   */
  _buildZip_(files) {
    const enc = new TextEncoder();
    const localHeaders = [];
    const centralDir   = [];
    let offset = 0;

    for (const { name, content } of files) {
      const nameBytes = enc.encode(name);
      const data      = enc.encode(content);
      const crc       = this._crc32_(data);
      const size      = data.length;
      const date      = this._dosDateTime_();

      // Local file header (30 bytes + name + data)
      const local = new Uint8Array(30 + nameBytes.length + size);
      const lv = new DataView(local.buffer);
      lv.setUint32(0,  0x04034b50, true); // signature
      lv.setUint16(4,  20,         true); // version needed
      lv.setUint16(6,  0,          true); // flags
      lv.setUint16(8,  0,          true); // compression: store
      lv.setUint16(10, date.time,  true);
      lv.setUint16(12, date.date,  true);
      lv.setUint32(14, crc,        true);
      lv.setUint32(18, size,       true); // compressed
      lv.setUint32(22, size,       true); // uncompressed
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0,          true); // extra field length
      local.set(nameBytes, 30);
      local.set(data, 30 + nameBytes.length);
      localHeaders.push(local);

      // Central directory entry (46 bytes + name)
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0,  0x02014b50, true); // signature
      cv.setUint16(4,  20,         true); // version made by
      cv.setUint16(6,  20,         true); // version needed
      cv.setUint16(8,  0,          true); // flags
      cv.setUint16(10, 0,          true); // compression: store
      cv.setUint16(12, date.time,  true);
      cv.setUint16(14, date.date,  true);
      cv.setUint32(16, crc,        true);
      cv.setUint32(20, size,       true); // compressed
      cv.setUint32(24, size,       true); // uncompressed
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0,          true); // extra
      cv.setUint16(32, 0,          true); // comment
      cv.setUint16(34, 0,          true); // disk start
      cv.setUint16(36, 0,          true); // internal attr
      cv.setUint32(38, 0,          true); // external attr
      cv.setUint32(42, offset,     true); // local header offset
      cd.set(nameBytes, 46);
      centralDir.push(cd);

      offset += local.length;
    }

    // End of central directory (22 bytes)
    const cdSize   = centralDir.reduce((s, c) => s + c.length, 0);
    const eocd     = new Uint8Array(22);
    const ev       = new DataView(eocd.buffer);
    ev.setUint32(0,  0x06054b50,       true); // signature
    ev.setUint16(4,  0,                true); // disk number
    ev.setUint16(6,  0,                true); // disk with CD
    ev.setUint16(8,  files.length,     true); // entries this disk
    ev.setUint16(10, files.length,     true); // total entries
    ev.setUint32(12, cdSize,           true); // CD size
    ev.setUint32(16, offset,           true); // CD offset
    ev.setUint16(20, 0,                true); // comment length

    // Concatenar todo
    const total  = new Uint8Array(offset + cdSize + 22);
    let pos = 0;
    for (const chunk of [...localHeaders, ...centralDir, eocd]) {
      total.set(chunk, pos);
      pos += chunk.length;
    }
    return total;
  }

  /**
   * CRC-32 estándar (polinomio 0xEDB88320).
   * @param {Uint8Array} data
   * @returns {number}
   * @private
   */
  _crc32_(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Fecha/hora actual en formato MS-DOS para la cabecera ZIP.
   * @returns {{date:number, time:number}}
   * @private
   */
  _dosDateTime_() {
    const d = new Date();
    return {
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    };
  }

  /**
   * Solicita al background la descarga del proyecto via CustomEvent.
   * Resuelve con `{ ok, bytes?, error? }`.
   *
   * @param {string} scriptId
   * @returns {Promise<{ok:boolean, bytes?:number[], error?:string}>}
   * @private
   */
  _requestDownload_(scriptId) {
    return new Promise((resolve) => {
      const requestId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const handler = (e) => {
        let detail; try { detail = JSON.parse(e.detail); } catch (_) { return; }
        if (detail?.requestId !== requestId) return;
        document.removeEventListener('GAS_DownloadProjectResult', handler);
        resolve(detail);
      };
      document.addEventListener('GAS_DownloadProjectResult', handler);
      document.dispatchEvent(new CustomEvent('GAS_DownloadProject', {
        detail: JSON.stringify({ requestId, scriptId }),
      }));
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Extrae el script ID de la URL actual.
   * Formato: `/home/projects/<scriptId>/<subroute>`.
   * @returns {string|null}
   * @private
   */
  _getScriptId_() {
    const m = location.pathname.match(/\/home\/projects\/([^/]+)/)
         || location.pathname.match(/\/d\/([^/]+)/);
    return m ? m[1] : null;
  }

  /** Lee el flag persistente del árbol oculto. @private */
  _readHideTree_() {
    try { return localStorage.getItem(GasActionsPanel.STORAGE_KEY_HIDE_TREE) === '1'; }
    catch (_) { return false; }
  }

  /** Persiste el flag del árbol. @private */
  _writeHideTree_(value) {
    try { localStorage.setItem(GasActionsPanel.STORAGE_KEY_HIDE_TREE, value ? '1' : '0'); }
    catch (_) { /* localStorage bloqueado: ignoramos */ }
  }

  /**
   * Toast efímero usando un elemento absoluto en el shadow DOM.
   * @private
   */
  _toast_(text) {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;
    let toast = this.shadowRoot.getElementById('qcToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'qcToast';
      toast.style.cssText = [
        'position:absolute',
        'left:50%',
        'bottom:8px',
        'transform:translateX(-50%)',
        'background: var(--gc-bg)',
        'color:#fff',
        'padding:6px 10px',
        'border-radius:6px',
        'font-size:11px',
        'pointer-events:none',
        'opacity:0',
        'transition:opacity 0.2s',
      ].join(';');
      pop.appendChild(toast);
    }
    toast.textContent = text;
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
  }

  // ── Posicionamiento del popover ───────────────────────────────────────

  /**
   * Posiciona el popover relativo al ancla, garantizando que siempre
   * quede dentro del viewport.
   *
   * Estrategia:
   *  - Borde derecho del popover alineado con el borde derecho del
   *    ancla (crece hacia la izquierda).
   *  - Si la altura desbordaría abajo, intentamos arriba; si tampoco
   *    cabe arriba, usamos la posición que deje más espacio y clampeamos
   *    al borde superior.
   *  - El offset de la flecha se calcula sobre el `left` final para
   *    mantenerla apuntando al centro del ancla.
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

    // Horizontal: alinear borde derecho al borde derecho del ancla.
    let left = rect.right - popW;
    if (left < margin) left = margin;
    if (left + popW + margin > vw) left = vw - popW - margin;

    // Vertical: preferir abajo; si no cabe, arriba; si tampoco, el lado
    // con más espacio y clampeado al viewport.
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

  // ── Listeners globales ────────────────────────────────────────────────

  _onDocumentMouseDown(e) {
    if (!this._open) return;
    const path = e.composedPath?.() || [];
    if (path.includes(this)) return;
    if (this._anchorEl && path.includes(this._anchorEl)) return;
    this.close();
  }

  _onWindowKeyDown(e) {
    if (this._open && e.key === 'Escape') this.close();
  }

  _onWindowResize() {
    if (this._open) this._positionPopover_();
  }


  // ── Bulk delete ────────────────────────────────────────────────
  // Reutiliza el bridge ya cableado por gas-github-panel para hablar
  // con la Apps Script API (GET_CONTENT / PUT_CONTENT).

  /**
   * Despacha un CustomEvent al bridge y resuelve con la respuesta.
   * @param {string} eventName
   * @param {object} [payload]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<*>}
   * @private
   */
  _bridgeCall_(eventName, payload = {}, opts = {}) {
    return new Promise((resolve) => {
      const requestId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const events = [
        'GAS_GG_AUTH_RESULT',
        'GAS_GG_AUTH_DONE',
        'GAS_GG_API_RESULT',
      ];
      const onResult = (e) => {
        let detail; try { detail = JSON.parse(e.detail); } catch (_) { return; }
        if (detail?.requestId !== requestId) return;
        events.forEach((ev) => document.removeEventListener(ev, onResult));
        clearTimeout(timer);
        if ('ok' in detail) {
          const { requestId: _, ...rest } = detail;
          resolve(rest);
        } else if ('data' in detail) {
          resolve(detail.data);
        } else {
          resolve(detail);
        }
      };
      const interactive = eventName === 'GAS_GG_AUTHENTICATE';
      const ms = opts.timeoutMs ?? (interactive ? 16 * 60 * 1000 : 30000);
      const timer = setTimeout(() => {
        events.forEach((ev) => document.removeEventListener(ev, onResult));
        resolve({ ok: false, error: 'Timeout' });
      }, ms);
      events.forEach((ev) => document.addEventListener(ev, onResult));
      document.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }

  /**
   * Atajo para llamar a la Apps Script API a través del background.
   * @param {string} action
   * @param {object} [payload]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
   * @private
   */
  _ggApi_(action, payload = {}, opts = {}) {
    return this._bridgeCall_('GAS_GG_API_CALL', { action, payload }, opts);
  }

  /**
   * Garantiza una sesión Google válida y devuelve el perfil, o `null`
   * si el usuario rechaza el consentimiento.
   * @returns {Promise<object|null>}
   * @private
   */
  async _ensureGoogleAuth_() {
    const cached = await this._bridgeCall_('GAS_GG_GET_AUTH');
    if (cached?.user) return cached.user;
    this._toast_('Opening Google sign-in…');
    const res = await this._bridgeCall_('GAS_GG_AUTHENTICATE');
    return res?.ok ? (res.user || null) : null;
  }

  /**
   * Abre el modal de borrado masivo y carga la lista del proyecto.
   * @private
   */
  async _openBulkDeleteModal_() {
    const scriptId = this._getScriptId_();
    if (!scriptId) {
      this._toast_('No script id available.');
      return;
    }

    this.close();

    const user = await this._ensureGoogleAuth_();
    if (!user) {
      this._toast_('Google sign-in is required to use this action.');
      return;
    }

    const overlay = this._buildBulkDeleteOverlay_();
    const list = this._bulkRoot_(overlay).getElementById('qcBdList');
    list.replaceChildren(this._bulkDeleteSpinner_('Loading project files…'));

    const res = await this._ggApi_('GET_CONTENT', { scriptId });
    if (!res?.ok || !res.data) {
      list.replaceChildren(this._bulkDeleteEmpty_(res?.error || 'Could not read project'));
      return;
    }

    const files = (res.data.files || [])
      .map((f) => ({ ...f, path: f.path || `${f.name}.${f.type === 'HTML' ? 'html' : f.type === 'JSON' ? 'json' : 'gs'}` }))
      .sort((a, b) => a.path.localeCompare(b.path));

    this._bulkDeleteState = {
      scriptId,
      files,
      selected: new Set(),
      collapsed: new Set(),
      filter: '',
    };
    this._renderBulkDeleteList_(overlay);
  }

  /** @returns {ShadowRoot} raíz Shadow del modal. @private */
  _bulkRoot_(overlay) {
    return overlay.shadowRoot;
  }

  /** @returns {boolean} si el IDE está en modo oscuro. @private */
  _isDarkMode_() {
    const cl = document.body.classList;
    return cl.contains('gc__is-dark-mode') || cl.contains('ide-dark-mode');
  }

  /**
   * Construye el shell del modal de borrado masivo en Shadow DOM y
   * cablea sus listeners. El click sobre el backdrop NO cierra el modal.
   *
   * @returns {HTMLElement} Host del modal.
   * @private
   */
  _buildBulkDeleteOverlay_() {
    document.getElementById('qcBulkDeleteOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'qcBulkDeleteOverlay';
    overlay.setAttribute('theme', this._isDarkMode_() ? 'dark' : 'light');
    document.body.appendChild(overlay);

    const shadow = overlay.attachShadow({ mode: 'open' });
    DomUtils.setHTML(shadow, `
      <style>${DomUtils.themeTokensCss()}${this._bulkDeleteStyles_()}</style>
      <div class="qc__bd-backdrop">
        <div class="qc__bd-modal" role="dialog" aria-modal="true" aria-label="Bulk delete files">
          <div class="qc__bd-head">
            <i class="material-icons">delete_sweep</i>
            <span class="qc__bd-title">Bulk delete files</span>
            <button class="qc__bd-close" id="qcBdClose" aria-label="Close">
              <i class="material-icons">close</i>
            </button>
          </div>
          <div class="qc__bd-search">
            <i class="material-icons">search</i>
            <input id="qcBdFilter" type="text" placeholder="Search files…" autocomplete="off">
          </div>
          <div class="qc__bd-toolbar">
            <label class="qc__bd-selectall" for="qcBdSelectAllChk">
              <input type="checkbox" id="qcBdSelectAllChk">
              <span>Select all (visible)</span>
            </label>
            <span class="qc__bd-counter" id="qcBdCounter">0 selected</span>
          </div>
          <div class="qc__bd-list" id="qcBdList"></div>
          <div class="qc__bd-progress" id="qcBdProgress" hidden></div>
          <div class="qc__bd-foot">
            <span class="qc__bd-status" id="qcBdStatus"></span>
            <button class="qc__bd-btn" id="qcBdCancel">Cancel</button>
            <button class="qc__bd-btn qc__bd-danger" id="qcBdConfirm" disabled>Delete selected</button>
          </div>
        </div>
      </div>
    `);

    const themeObserver = new MutationObserver(() => {
      overlay.setAttribute('theme', this._isDarkMode_() ? 'dark' : 'light');
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    const onKey = (e) => {
      if (e.key === 'Escape' && !this._isBulkBusy_()) closeOverlay();
    };
    const closeOverlay = () => {
      if (this._isBulkBusy_()) return;
      document.removeEventListener('keydown', onKey);
      themeObserver.disconnect();
      overlay.remove();
    };

    shadow.getElementById('qcBdClose').addEventListener('click', closeOverlay);
    shadow.getElementById('qcBdCancel').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', onKey);

    shadow.getElementById('qcBdFilter').addEventListener('input', (e) => {
      if (!this._bulkDeleteState || this._isBulkBusy_()) return;
      this._bulkDeleteState.filter = String(e.target.value || '').trim().toLowerCase();
      this._renderBulkDeleteList_(overlay);
    });

    shadow.getElementById('qcBdSelectAllChk').addEventListener('change', (e) => {
      if (!this._bulkDeleteState || this._isBulkBusy_()) {
        e.target.checked = !e.target.checked;
        return;
      }
      const visible = this._getVisibleBulkFiles_();
      if (e.target.checked) visible.forEach((f) => this._bulkDeleteState.selected.add(f.path));
      else                  visible.forEach((f) => this._bulkDeleteState.selected.delete(f.path));
      this._renderBulkDeleteList_(overlay);
    });

    shadow.getElementById('qcBdConfirm').addEventListener('click', async () => {
      if (this._isBulkBusy_()) return;
      const ok = await this._confirmBulkDelete_(overlay);
      if (ok) this._showBulkDeleteCompleted_(overlay);
    });

    return overlay;
  }

  /** `true` si hay una eliminación en curso. @private */
  _isBulkBusy_() {
    return !!this._bulkDeleteState?.busy;
  }

  /**
   * CSS scoped del modal de borrado masivo. Se sirve junto con
   * `DomUtils.themeTokensCss()` para resolver light/dark via el
   * atributo `theme` del host.
   *
   * @returns {string}
   * @private
   */
  _bulkDeleteStyles_() {
    return `
      /* --qc-folder-color es heredada desde :root (gas-folders),
         así el icono respeta el color elegido en el popup. */
      :host {
        position: fixed; inset: 0;
        z-index: 2147483646;
        font-family: var(--gc-font);
        color: var(--gc-text);
      }

      .qc__bd-backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.55);
        display: grid; place-items: center;
      }

      .material-icons {
        font-family: 'Material Icons', 'Material Icons Extended', 'Google Material Icons', sans-serif;
        font-weight: normal; font-style: normal;
        font-size: 18px; line-height: 1;
        letter-spacing: normal; text-transform: none;
        display: inline-block; white-space: nowrap;
        direction: ltr;
        -webkit-font-feature-settings: 'liga';
        -webkit-font-smoothing: antialiased;
      }

      .qc__bd-modal {
        width: min(560px, calc(100vw - 32px));
        max-height: min(640px, calc(100vh - 64px));
        display: flex; flex-direction: column;
        background: var(--gc-bg-elevated);
        border: 1px solid var(--gc-border);
        border-radius: 14px;
        box-shadow: var(--gc-shadow-panel);
        overflow: hidden;
        position: relative;
      }
      .qc__bd-head {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--gc-border);
        background: var(--gc-red-dim);
      }
      .qc__bd-head .material-icons {
        color: var(--gc-red-text);
        font-size: 20px;
      }
      .qc__bd-title {
        flex: 1; font-weight: 600; font-size: 14px;
        color: var(--gc-red-text);
      }
      .qc__bd-close {
        background: transparent; border: 0;
        color: var(--gc-text-muted);
        width: 28px; height: 28px; border-radius: 7px;
        cursor: pointer; display: grid; place-items: center;
        transition: background .15s, color .15s;
      }
      .qc__bd-close:hover {
        background: var(--gc-hover-strong);
        color: var(--gc-text);
      }

      .qc__bd-search {
        padding: 12px 18px;
        display: flex; align-items: center; gap: 8px;
        border-bottom: 1px solid var(--gc-border);
      }
      .qc__bd-search .material-icons {
        color: var(--gc-text-muted);
        font-size: 18px;
      }
      .qc__bd-search input {
        flex: 1; height: 34px;
        background: var(--gc-bg-input, var(--gc-bg-elevated));
        color: var(--gc-text);
        border: 1px solid var(--gc-border);
        border-radius: 8px; padding: 0 12px;
        font: inherit; outline: none;
        transition: border-color .15s, box-shadow .15s;
      }
      .qc__bd-search input:focus {
        border-color: var(--gc-accent);
        box-shadow: 0 0 0 3px var(--gc-accent-glow);
      }
      .qc__bd-search input::placeholder {
        color: var(--gc-text-faint);
      }

      .qc__bd-toolbar {
        padding: 8px 18px;
        display: flex; align-items: center; gap: 12px;
        border-bottom: 1px solid var(--gc-border);
        font-size: 12px; color: var(--gc-text-muted);
        background: var(--gc-surface-soft);
      }
      .qc__bd-selectall {
        display: inline-flex; align-items: center; gap: 8px;
        background: transparent;
        color: var(--gc-text);
        cursor: pointer;
        font-family: inherit;
        transition: color .15s;
      }
      .qc__bd-selectall:hover {
        color: var(--gc-accent);
      }
      .qc__bd-counter {
        margin-left: auto;
        color: var(--gc-text-muted);
      }

      .qc__bd-list {
        flex: 1; min-height: 200px; max-height: 340px;
        overflow-y: auto; padding: 4px;
        scrollbar-width: thin;
        scrollbar-color: var(--gc-border) transparent;
      }
      .qc__bd-list::-webkit-scrollbar { width: 8px; }
      .qc__bd-list::-webkit-scrollbar-track { background: transparent; }
      .qc__bd-list::-webkit-scrollbar-thumb {
        background: var(--gc-border);
        border-radius: 8px;
      }
      .qc__bd-list::-webkit-scrollbar-thumb:hover {
        background: var(--gc-text-faint);
      }

      /* Folder rows — el icono usa --qc-folder-color (lo define gas-folders
         a partir del color picker del popup). Si no está disponible, cae
         al accent color. */
      .qc__bd-folder { margin: 2px 0; }
      .qc__bd-folder-header {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 12px; border-radius: 6px;
        font-size: 13px; font-weight: 500;
        cursor: pointer;
        transition: background .12s;
      }
      .qc__bd-folder-header:hover {
        background: var(--gc-hover-soft);
      }
      .qc__bd-folder-chevron {
        font-size: 18px !important;
        color: var(--gc-text-muted);
        transition: transform .15s;
      }
      .qc__bd-folder.qc__bd-collapsed .qc__bd-folder-chevron {
        transform: rotate(-90deg);
      }
      .qc__bd-folder-icon {
        color: var(--qc-folder-color, var(--gc-accent));
        font-size: 18px !important;
      }
      .qc__bd-folder-name {
        flex: 1;
        color: var(--gc-text);
      }
      .qc__bd-folder-check {
        margin-left: auto;
        cursor: pointer;
        accent-color: var(--gc-accent);
      }
      .qc__bd-folder-children {
        margin-left: 20px;
        padding-left: 12px;
        border-left: 1px dotted var(--gc-border);
      }
      .qc__bd-folder.qc__bd-collapsed .qc__bd-folder-children {
        display: none;
      }

      .qc__bd-row {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 12px; border-radius: 6px;
        font-size: 13px;
        transition: background .12s;
      }
      .qc__bd-row:hover {
        background: var(--gc-hover-soft);
      }
      .qc__bd-row input[type="checkbox"] {
        margin: 0; cursor: pointer;
        width: 16px; height: 16px;
        accent-color: var(--gc-accent);
      }
      .qc__bd-row label {
        flex: 1; cursor: pointer;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--gc-text);
      }
      .qc__bd-row .qc__bd-type {
        color: var(--gc-text-muted);
        font-size: 11px;
        font-family: 'Roboto Mono', Consolas, monospace;
        text-transform: uppercase;
        padding: 2px 6px;
        background: var(--gc-hover-soft);
        border-radius: 4px;
      }

      .qc__bd-empty,
      .qc__bd-spinner {
        padding: 36px 16px; text-align: center;
        color: var(--gc-text-muted); font-size: 13px;
      }
      .qc__bd-spinner::before {
        content: ''; display: inline-block;
        width: 14px; height: 14px; margin-right: 8px;
        border: 2px solid var(--gc-border);
        border-top-color: var(--gc-accent);
        border-radius: 50%; vertical-align: middle;
        animation: qc__bd-spin .7s linear infinite;
      }
      @keyframes qc__bd-spin { to { transform: rotate(360deg); } }

      .qc__bd-foot {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 18px;
        border-top: 1px solid var(--gc-border);
      }
      .qc__bd-foot .qc__bd-status {
        flex: 1; font-size: 12px;
        color: var(--gc-text-muted);
      }

      button.qc__bd-btn {
        padding: 8px 16px; border-radius: 8px;
        border: 1px solid var(--gc-border);
        background: transparent;
        color: var(--gc-text);
        cursor: pointer; font: inherit;
        transition: background .15s, border-color .15s;
      }
      button.qc__bd-btn:hover {
        background: var(--gc-hover-soft);
      }
      button.qc__bd-danger {
        background: var(--gc-red-strong);
        border-color: var(--gc-red-strong);
        color: var(--gc-text-on-accent);
      }
      button.qc__bd-danger[disabled] {
        opacity: .55; cursor: not-allowed;
      }
      button.qc__bd-danger:not([disabled]):hover {
        background: var(--gc-red-text);
        border-color: var(--gc-red-text);
      }
      button.qc__bd-primary {
        background: var(--gc-accent);
        border-color: var(--gc-accent);
        color: var(--gc-text-on-accent);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      button.qc__bd-primary .material-icons {
        font-size: 16px;
      }
      button.qc__bd-primary:hover {
        background: var(--gc-accent);
        border-color: var(--gc-accent);
        filter: brightness(.92);
      }

      /* Modo busy: oculta search/toolbar/lista y agranda el progress
         para que ocupe el centro del modal. */
      :host([data-busy]) .qc__bd-search,
      :host([data-busy]) .qc__bd-toolbar,
      :host([data-busy]) .qc__bd-list {
        display: none;
      }
      :host([data-busy]) .qc__bd-close,
      :host([data-busy]) .qc__bd-foot {
        pointer-events: none;
        opacity: .65;
      }
      :host([data-busy]) .qc__bd-progress {
        flex: 1 1 auto;
        margin: 18px;
        display: flex;
        flex-direction: column;
        min-height: 0;
        pointer-events: auto;
      }
      :host([data-busy]) .qc__bd-progressBody {
        flex: 1 1 auto;
        max-height: none;
      }

      /* Status indicator post-éxito */
      .qc__bd-status-ok {
        display: inline-flex; align-items: center; gap: 8px;
        color: var(--gc-green-text);
        font-size: 12px;
      }
      .qc__bd-status-ok .material-icons {
        font-size: 16px;
      }

      /* Progress panel */
      .qc__bd-progress {
        margin: 0 14px 12px;
        background: var(--gc-surface-soft);
        border: 1px solid var(--gc-border);
        border-radius: 10px;
        font-size: 12px;
        color: var(--gc-text);
        overflow: hidden;
      }
      .qc__bd-progressHead {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        cursor: pointer;
        user-select: none;
      }
      .qc__bd-progressHead:hover { background: var(--gc-hover-soft); }
      .qc__bd-progressIcon {
        width: 18px; height: 18px; flex: 0 0 auto;
        display: grid; place-items: center;
      }
      .qc__bd-progressIcon .material-icons {
        font-size: 18px;
        color: var(--gc-accent);
      }
      .qc__bd-progress.qc__bd-progressDone .qc__bd-progressIcon .material-icons {
        color: var(--gc-green-text);
      }
      .qc__bd-progress.qc__bd-progressError .qc__bd-progressIcon .material-icons {
        color: var(--gc-red-text);
      }
      .qc__bd-spinnerInline {
        display: inline-block;
        width: 14px; height: 14px;
        border: 2px solid var(--gc-border);
        border-top-color: var(--gc-accent);
        border-radius: 50%;
        animation: qc__bd-spin .7s linear infinite;
      }
      .qc__bd-progressTitle {
        flex: 1; min-width: 0;
        font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .qc__bd-progressMeta {
        margin-left: 8px;
        color: var(--gc-text-muted);
        font-weight: 400;
        font-size: 11.5px;
      }
      .qc__bd-progressChevron {
        font-size: 18px !important;
        color: var(--gc-text-muted);
        transition: transform .15s;
      }
      .qc__bd-progress.qc__bd-progressOpen .qc__bd-progressChevron {
        transform: rotate(180deg);
      }
      .qc__bd-progressBody {
        display: none;
        border-top: 1px solid var(--gc-border);
        max-height: 200px;
        overflow-y: auto;
        padding: 8px 4px;
        scrollbar-width: thin;
        scrollbar-color: var(--gc-border) transparent;
      }
      .qc__bd-progressBody::-webkit-scrollbar { width: 6px; }
      .qc__bd-progressBody::-webkit-scrollbar-thumb {
        background: var(--gc-border);
        border-radius: 6px;
      }
      .qc__bd-progress.qc__bd-progressOpen .qc__bd-progressBody {
        display: block;
      }
      .qc__bd-progressFiles {
        list-style: none;
        margin: 0;
        padding: 0 8px;
        font-family: 'Roboto Mono', Consolas, monospace;
        font-size: 11.5px;
      }
      .qc__bd-progressFiles li {
        display: flex; align-items: center; gap: 6px;
        padding: 3px 4px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        border-radius: 4px;
      }
      .qc__bd-progressFiles li .material-icons {
        font-size: 14px;
        flex: 0 0 auto;
      }
      .qc__bd-progressFile-pending {
        color: var(--gc-text-muted);
      }
      .qc__bd-progressFile-pending .material-icons {
        color: var(--gc-text-faint);
      }
      .qc__bd-progressFile-done {
        color: var(--gc-text);
      }
      .qc__bd-progressFile-done .material-icons {
        color: var(--gc-green-text);
      }
      .qc__bd-progressFile-error .material-icons {
        color: var(--gc-red-text);
      }

      /* Confirmation modal interno (overlay sobre el modal principal). */
      .qc__bd-confirm-overlay {
        position: absolute; inset: 0;
        background: rgba(0,0,0,0.7);
        display: grid; place-items: center;
        z-index: 10;
      }
      .qc__bd-confirm-dialog {
        background: var(--gc-bg-elevated);
        border: 1px solid var(--gc-border);
        border-radius: 12px;
        box-shadow: var(--gc-shadow-panel);
        width: min(420px, calc(100% - 32px));
        overflow: hidden;
      }
      .qc__bd-confirm-head {
        padding: 16px 18px;
        border-bottom: 1px solid var(--gc-border);
        background: var(--gc-red-dim);
      }
      .qc__bd-confirm-head--ok {
        background: var(--gc-green-soft);
      }
      .qc__bd-confirm-title {
        font-size: 15px; font-weight: 600;
        color: var(--gc-red-text);
        display: flex; align-items: center; gap: 10px;
      }
      .qc__bd-confirm-title--ok {
        color: var(--gc-green-text);
      }
      .qc__bd-confirm-title .material-icons { font-size: 22px; }
      .qc__bd-confirm-body { padding: 18px; }
      .qc__bd-confirm-message {
        font-size: 13px; line-height: 1.5;
        color: var(--gc-text);
        margin-bottom: 12px;
      }
      .qc__bd-confirm-list {
        max-height: 180px;
        overflow-y: auto;
        background: var(--gc-surface-soft);
        border: 1px solid var(--gc-border);
        border-radius: 8px;
        padding: 8px;
        font-size: 12px;
        font-family: 'Roboto Mono', Consolas, monospace;
        color: var(--gc-text-muted);
        scrollbar-width: thin;
        scrollbar-color: var(--gc-border) transparent;
      }
      .qc__bd-confirm-list::-webkit-scrollbar { width: 6px; }
      .qc__bd-confirm-list::-webkit-scrollbar-track { background: transparent; }
      .qc__bd-confirm-list::-webkit-scrollbar-thumb {
        background: var(--gc-border);
        border-radius: 6px;
      }
      .qc__bd-confirm-list-item {
        padding: 4px 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .qc__bd-confirm-foot {
        display: flex; gap: 10px;
        justify-content: flex-end;
        padding: 14px 18px;
        border-top: 1px solid var(--gc-border);
      }
    `;
  }

  /**
   * Devuelve los archivos del state que pasan el filtro actual.
   * @returns {Array}
   * @private
   */
  _getVisibleBulkFiles_() {
    const s = this._bulkDeleteState;
    if (!s) return [];
    const q = s.filter;
    if (!q) return s.files;
    return s.files.filter((f) =>
      f.path.toLowerCase().includes(q) || (f.name || '').toLowerCase().includes(q),
    );
  }

  /**
   * Repinta la lista del modal con el filtro y selección actuales.
   * @param {HTMLElement} overlay
   * @private
   */
  _renderBulkDeleteList_(overlay) {
    const s = this._bulkDeleteState;
    if (!s) return;
    const root      = this._bulkRoot_(overlay);
    const list      = root.getElementById('qcBdList');
    const counter   = root.getElementById('qcBdCounter');
    const confirm   = root.getElementById('qcBdConfirm');
    const selectChk = root.getElementById('qcBdSelectAllChk');

    const visible = this._getVisibleBulkFiles_();
    if (!visible.length) {
      list.replaceChildren(this._bulkDeleteEmpty_(s.files.length
        ? 'No files match this filter.'
        : 'The project has no files.'));
    } else {
      const frag = document.createDocumentFragment();
      const tree = this._buildFileTree_(visible);
      this._renderTreeNode_(tree, frag, s, overlay);
      list.replaceChildren(frag);
    }

    // Actualizamos contadores y el checkbox "select all".
    counter.textContent = `${s.selected.size} selected`;
    confirm.disabled = s.selected.size === 0;
    const allVisibleSelected = visible.length > 0 &&
      visible.every((f) => s.selected.has(f.path));
    selectChk.checked = allVisibleSelected;
    selectChk.indeterminate = !allVisibleSelected &&
      visible.some((f) => s.selected.has(f.path));
  }

  /**
   * Construye un árbol jerárquico a partir de la lista plana de archivos.
   * @param {Array} files
   * @returns {object} Nodo raíz con estructura { folders: Map, files: Array }
   * @private
   */
  _buildFileTree_(files) {
    const root = { folders: new Map(), files: [] };
    
    for (const file of files) {
      const path = file.path || file.name;
      if (!path.includes('/')) {
        root.files.push(file);
        continue;
      }
      
      const parts = path.split('/');
      const fileName = parts.pop();
      let current = root;
      
      for (const part of parts) {
        if (!current.folders.has(part)) {
          current.folders.set(part, { folders: new Map(), files: [] });
        }
        current = current.folders.get(part);
      }
      
      current.files.push({ ...file, displayName: fileName });
    }
    
    return root;
  }

  /**
   * Renderiza recursivamente un nodo del árbol (carpeta o archivo).
   *
   * @param {object} node
   * @param {DocumentFragment|HTMLElement} parent
   * @param {object} state
   * @param {HTMLElement} overlay
   * @param {string} [pathPrefix='']
   * @private
   */
  _renderTreeNode_(node, parent, state, overlay, pathPrefix = '') {
    for (const [folderName, folderNode] of node.folders) {
      const folderPath = pathPrefix ? `${pathPrefix}/${folderName}` : folderName;
      const folderDiv = document.createElement('div');
      folderDiv.className = 'qc__bd-folder';
      if (state.collapsed?.has(folderPath)) {
        folderDiv.classList.add('qc__bd-collapsed');
      }

      const header = document.createElement('div');
      header.className = 'qc__bd-folder-header';

      const allFilesInFolder = this._getAllFilesInFolder_(folderNode, folderPath);
      const allSelected = allFilesInFolder.every(f => state.selected.has(f));
      const someSelected = allFilesInFolder.some(f => state.selected.has(f));

      DomUtils.setHTML(header, `
        <i class="material-icons qc__bd-folder-chevron">expand_more</i>
        <i class="material-icons qc__bd-folder-icon">folder</i>
        <span class="qc__bd-folder-name">${this._escapeHtml_(folderName)}</span>
        <input type="checkbox" class="qc__bd-folder-check" ${allSelected ? 'checked' : ''}
               data-folder="${this._escapeAttr_(folderPath)}">
      `);

      const checkbox = header.querySelector('input[type="checkbox"]');
      if (someSelected && !allSelected) checkbox.indeterminate = true;

      header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (this._isBulkBusy_()) return;
        const collapsed = folderDiv.classList.toggle('qc__bd-collapsed');
        if (collapsed) state.collapsed.add(folderPath);
        else           state.collapsed.delete(folderPath);
      });

      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (this._isBulkBusy_()) {
          e.target.checked = !e.target.checked;
          return;
        }
        const files = this._getAllFilesInFolder_(folderNode, folderPath);
        if (e.target.checked) files.forEach(f => state.selected.add(f));
        else                  files.forEach(f => state.selected.delete(f));
        this._renderBulkDeleteList_(overlay);
      });

      folderDiv.appendChild(header);

      const children = document.createElement('div');
      children.className = 'qc__bd-folder-children';
      this._renderTreeNode_(folderNode, children, state, overlay, folderPath);
      folderDiv.appendChild(children);

      parent.appendChild(folderDiv);
    }

    for (const file of node.files) {
      const row = document.createElement('div');
      row.className = 'qc__bd-row';
      const displayName = file.displayName || file.path || file.name;
      const fullPath = file.path || file.name;
      const id = `qcBd_${fullPath.replace(/[^A-Za-z0-9]+/g, '_')}`;
      const checked = state.selected.has(fullPath) ? 'checked' : '';

      DomUtils.setHTML(row, `
        <input type="checkbox" id="${id}" data-path="${this._escapeAttr_(fullPath)}" ${checked}>
        <label for="${id}">${this._escapeHtml_(displayName)}</label>
        <span class="qc__bd-type">${this._escapeHtml_(file.type || '')}</span>
      `);

      row.querySelector('input').addEventListener('change', (e) => {
        if (this._isBulkBusy_()) {
          e.target.checked = !e.target.checked;
          return;
        }
        const path = e.target.dataset.path;
        if (e.target.checked) state.selected.add(path);
        else                  state.selected.delete(path);
        this._refreshBulkDeleteCounters_(overlay);
      });

      parent.appendChild(row);
    }
  }

  /**
   * Obtiene recursivamente todos los paths de archivos dentro de una carpeta.
   * @param {object} folderNode
   * @param {string} folderPath
   * @returns {Array<string>}
   * @private
   */
  _getAllFilesInFolder_(folderNode, folderPath) {
    const result = [];
    
    for (const file of folderNode.files) {
      result.push(file.path || file.name);
    }
    
    for (const [subFolderName, subFolderNode] of folderNode.folders) {
      const subPath = `${folderPath}/${subFolderName}`;
      result.push(...this._getAllFilesInFolder_(subFolderNode, subPath));
    }
    
    return result;
  }

  /** Refresca solo contadores y el checkbox global. @private */
  _refreshBulkDeleteCounters_(overlay) {
    const s = this._bulkDeleteState;
    if (!s) return;
    const root = this._bulkRoot_(overlay);
    root.getElementById('qcBdCounter').textContent = `${s.selected.size} selected`;
    root.getElementById('qcBdConfirm').disabled = s.selected.size === 0;
    const visible = this._getVisibleBulkFiles_();
    const selectChk = root.getElementById('qcBdSelectAllChk');
    const allVisibleSelected = visible.length > 0 &&
      visible.every((f) => s.selected.has(f.path));
    selectChk.checked = allVisibleSelected;
    selectChk.indeterminate = !allVisibleSelected &&
      visible.some((f) => s.selected.has(f.path));
  }

  /**
   * Muestra un modal interno de confirmación previo a la eliminación.
   * @param {HTMLElement} overlay
   * @returns {Promise<boolean>}
   * @private
   */
  async _showDeleteConfirmation_(overlay) {
    const s = this._bulkDeleteState;
    if (!s || !s.selected.size) return false;

    return new Promise((resolve) => {
      const confirmOverlay = document.createElement('div');
      confirmOverlay.className = 'qc__bd-confirm-overlay';

      const selectedFiles = Array.from(s.selected).sort();
      const fileListHtml = selectedFiles
        .map(f => `<div class="qc__bd-confirm-list-item">${this._escapeHtml_(f)}</div>`)
        .join('');

      DomUtils.setHTML(confirmOverlay, `
        <div class="qc__bd-confirm-dialog">
          <div class="qc__bd-confirm-head">
            <div class="qc__bd-confirm-title">
              <i class="material-icons">warning</i>
              Confirm deletion
            </div>
          </div>
          <div class="qc__bd-confirm-body">
            <div class="qc__bd-confirm-message">
              You are about to permanently delete <strong>${s.selected.size} file(s)</strong>
              from this project. This action cannot be undone.
            </div>
            <div class="qc__bd-confirm-list">${fileListHtml}</div>
          </div>
          <div class="qc__bd-confirm-foot">
            <button class="qc__bd-btn" id="qcBdConfirmCancel">Cancel</button>
            <button class="qc__bd-btn qc__bd-danger" id="qcBdConfirmOk">Delete ${s.selected.size} file(s)</button>
          </div>
        </div>
      `);

      const modal = this._bulkRoot_(overlay).querySelector('.qc__bd-modal');
      modal.appendChild(confirmOverlay);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          cleanup();
          resolve(false);
        }
      };
      const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        confirmOverlay.remove();
      };

      confirmOverlay.querySelector('#qcBdConfirmCancel').addEventListener('click', () => {
        cleanup();
        resolve(false);
      });
      confirmOverlay.querySelector('#qcBdConfirmOk').addEventListener('click', () => {
        cleanup();
        resolve(true);
      });
      document.addEventListener('keydown', onKey, true);
    });
  }

  /**
   * Ejecuta la eliminación: confirma, lanza el `PUT_CONTENT`, anima el
   * marcado de archivos en el log y devuelve `true` en caso de éxito.
   * @param {HTMLElement} overlay
   * @returns {Promise<boolean>}
   * @private
   */
  async _confirmBulkDelete_(overlay) {
    const s = this._bulkDeleteState;
    if (!s || !s.selected.size) return false;

    const confirmed = await this._showDeleteConfirmation_(overlay);
    if (!confirmed) return false;

    s.busy = true;
    overlay.setAttribute('data-busy', '');

    const root    = this._bulkRoot_(overlay);
    const status  = root.getElementById('qcBdStatus');
    const confirm = root.getElementById('qcBdConfirm');
    const cancel  = root.getElementById('qcBdCancel');
    const closeBt = root.getElementById('qcBdClose');
    confirm.disabled = true;
    cancel.disabled  = true;
    closeBt.disabled = true;
    status.textContent = '';

    const targets = Array.from(s.selected).sort();
    this._openBulkProgress_(overlay, targets);

    const survivors = s.files
      .filter((f) => !s.selected.has(f.path))
      .map((f) => ({
        name:   String(f.name || '').replace(/\.(gs|html|json)$/i, ''),
        type:   (f.type || '').toUpperCase(),
        source: String(f.source ?? ''),
      }));

    const res = await this._ggApi_(
      'PUT_CONTENT',
      { scriptId: s.scriptId, files: survivors },
      { timeoutMs: 60000 },
    );

    if (!res?.ok) {
      this._markBulkProgress_(overlay, targets, 'error');
      this._finishBulkProgress_(overlay, {
        success: false,
        message: res?.error || 'Failed to delete files.',
      });
      s.busy = false;
      overlay.removeAttribute('data-busy');
      confirm.disabled = false;
      cancel.disabled  = false;
      closeBt.disabled = false;
      status.textContent = res?.error || 'Failed to delete files.';
      return false;
    }

    this._markBulkProgress_(overlay, targets, 'done');
    this._finishBulkProgress_(overlay, {
      success: true,
      message: `${targets.length} file(s) deleted.`,
    });
    return true;
  }

  /**
   * Muestra un prompt bloqueante con un único botón que recarga la
   * pestaña tras una eliminación exitosa.
   * @param {HTMLElement} overlay
   * @private
   */
  _showBulkDeleteCompleted_(overlay) {
    const s = this._bulkDeleteState;
    if (!s) return;
    const modal = this._bulkRoot_(overlay).querySelector('.qc__bd-modal');
    if (!modal) return;

    const completedOverlay = document.createElement('div');
    completedOverlay.className = 'qc__bd-confirm-overlay qc__bd-completed-overlay';

    DomUtils.setHTML(completedOverlay, `
      <div class="qc__bd-confirm-dialog">
        <div class="qc__bd-confirm-head qc__bd-confirm-head--ok">
          <div class="qc__bd-confirm-title qc__bd-confirm-title--ok">
            <i class="material-icons">check_circle</i>
            Files deleted
          </div>
        </div>
        <div class="qc__bd-confirm-body">
          <div class="qc__bd-confirm-message">
            <strong>${s.selected.size} file(s)</strong> were removed from this project.
            The Apps Script editor needs to reload to refresh its file tree;
            otherwise you would still see the old files in the sidebar.
          </div>
        </div>
        <div class="qc__bd-confirm-foot">
          <button class="qc__bd-btn qc__bd-primary" id="qcBdReloadOk">
            <i class="material-icons">refresh</i>
            Reload page now
          </button>
        </div>
      </div>
    `);

    modal.appendChild(completedOverlay);

    const swallowKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', swallowKey, true);

    completedOverlay.querySelector('#qcBdReloadOk').addEventListener('click', () => {
      document.removeEventListener('keydown', swallowKey, true);
      window.location.reload();
    });
  }

  /**
   * Construye el panel de progreso con la lista de archivos pendientes.
   * @param {HTMLElement} overlay
   * @param {string[]} files
   * @private
   */
  _openBulkProgress_(overlay, files) {
    const panel = this._bulkRoot_(overlay).getElementById('qcBdProgress');
    if (!panel) return;

    DomUtils.setHTML(panel, `
      <div class="qc__bd-progressHead" id="qcBdProgressHead">
        <span class="qc__bd-progressIcon">
          <span class="qc__bd-spinnerInline" aria-hidden="true"></span>
        </span>
        <span class="qc__bd-progressTitle">
          Deleting files
          <span class="qc__bd-progressMeta" id="qcBdProgressMeta">0/${files.length}</span>
        </span>
        <i class="material-icons qc__bd-progressChevron">expand_more</i>
      </div>
      <div class="qc__bd-progressBody" id="qcBdProgressBody">
        <ul class="qc__bd-progressFiles" id="qcBdProgressFiles">
          ${files.map((path) => `
            <li data-path="${this._escapeAttr_(path)}" class="qc__bd-progressFile-pending">
              <i class="material-icons">radio_button_unchecked</i>
              <span>${this._escapeHtml_(path)}</span>
            </li>
          `).join('')}
        </ul>
      </div>
    `);

    panel.classList.add('qc__bd-progressOpen');
    panel.classList.remove('qc__bd-progressDone', 'qc__bd-progressError');
    panel.hidden = false;

    panel.querySelector('#qcBdProgressHead').addEventListener('click', () => {
      panel.classList.toggle('qc__bd-progressOpen');
    });
  }

  /**
   * Marca un conjunto de archivos del log con un nuevo estado y
   * refresca el contador `done/total`.
   * @param {HTMLElement} overlay
   * @param {string[]} paths
   * @param {'pending'|'done'|'error'} status
   * @private
   */
  _markBulkProgress_(overlay, paths, status) {
    const root = this._bulkRoot_(overlay);
    const list = root.getElementById('qcBdProgressFiles');
    const meta = root.getElementById('qcBdProgressMeta');
    if (!list) return;

    const iconByStatus = {
      pending: 'radio_button_unchecked',
      done:    'check_circle',
      error:   'error',
    };

    for (const path of paths) {
      const li = list.querySelector(`li[data-path="${CSS.escape(path)}"]`);
      if (!li) continue;
      li.classList.remove(
        'qc__bd-progressFile-pending',
        'qc__bd-progressFile-done',
        'qc__bd-progressFile-error',
      );
      li.classList.add(`qc__bd-progressFile-${status}`);
      const icon = li.querySelector('.material-icons');
      if (icon) icon.textContent = iconByStatus[status] || 'radio_button_unchecked';
    }

    if (meta) {
      const total = list.children.length;
      const done = list.querySelectorAll('.qc__bd-progressFile-done').length;
      const failed = list.querySelectorAll('.qc__bd-progressFile-error').length;
      meta.textContent = failed
        ? `${done}/${total} (${failed} failed)`
        : `${done}/${total}`;
    }
  }

  /**
   * Cambia el panel de progreso a su estado final (done/error).
   * @param {HTMLElement} overlay
   * @param {{success:boolean, message?:string}} result
   * @private
   */
  _finishBulkProgress_(overlay, result) {
    const panel = this._bulkRoot_(overlay).getElementById('qcBdProgress');
    if (!panel) return;

    const iconWrap = panel.querySelector('.qc__bd-progressIcon');
    if (iconWrap) {
      DomUtils.setHTML(iconWrap, `<i class="material-icons">${result.success ? 'check_circle' : 'error'}</i>`);
    }

    panel.classList.toggle('qc__bd-progressDone',  !!result.success);
    panel.classList.toggle('qc__bd-progressError', !result.success);

    const titleNode = panel.querySelector('.qc__bd-progressTitle');
    if (titleNode) {
      const meta = titleNode.querySelector('.qc__bd-progressMeta')?.textContent || '';
      DomUtils.setHTML(titleNode, `
        ${result.success ? 'Files deleted' : 'Deletion failed'}
        <span class="qc__bd-progressMeta">${this._escapeHtml_(meta)}</span>
      `);
    }
  }

  /** Devuelve el spinner usado durante el "loading" inicial. @private */
  _bulkDeleteSpinner_(text) {
    const el = document.createElement('div');
    el.className = 'qc__bd-spinner';
    el.textContent = text;
    return el;
  }

  /** Devuelve el placeholder de estado vacío. @private */
  _bulkDeleteEmpty_(text) {
    const el = document.createElement('div');
    el.className = 'qc__bd-empty';
    el.textContent = text;
    return el;
  }

  /** Escape mínimo HTML para usar en el modal. @private */
  _escapeHtml_(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Escape para atributos. @private */
  _escapeAttr_(value) {
    return this._escapeHtml_(value).replace(/"/g, '&quot;');
  }
}

if (!customElements.get('gas-actions-panel')) {
  customElements.define('gas-actions-panel', GasActionsPanel);
}
