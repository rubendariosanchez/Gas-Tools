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
      case 'toggle-tree': this._toggleFileTree_(); break;
      case 'copy-id':     this._copyScriptId_(btn); break;
      case 'download':    this._downloadProject_(btn); break;
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
}

if (!customElements.get('gas-actions-panel')) {
  customElements.define('gas-actions-panel', GasActionsPanel);
}
