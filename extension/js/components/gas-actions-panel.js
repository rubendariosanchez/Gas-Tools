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
 *  - Clases CSS con prefijo `qc__` (Shadow DOM aislado) sobre `GasUi.BASE_CSS`.
 *  - Iconos SVG del registro compartido (`GasUi.icon`).
 */
class GasActionsPanel extends HTMLElement {

  /** Clave del flag persistente "ocultar árbol de archivos". */
  static STORAGE_KEY_HIDE_TREE = 'qc__hideFileTree';

  /** Selector del botón ancla (la toolbar puede reinyectarse). */
  static ANCHOR_SELECTOR = '#rsBtnActionsGas';

  /** CSS del popover (sobre `GasUi.BASE_CSS`). */
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
    .qc__pop-body { padding: 6px; }

    .qc__group-title {
      font: var(--gt-type-label-s);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--gt-on-surface-variant);
      padding: 6px var(--gt-space-2) var(--gt-space-1);
    }

    .qc__action { gap: 10px; font-size: 12px; }
    .qc__action-icon {
      display: inline-flex;
      flex: 0 0 auto;
      color: var(--gt-on-surface-variant);
    }
    .qc__action-label { flex: 1 1 auto; }
    .qc__action-meta {
      flex: 0 0 auto;
      font-size: 11px;
      color: var(--gt-on-surface-variant);
    }

    .qc__pill {
      display: inline-block;
      padding: 2px var(--gt-space-2);
      border-radius: var(--gt-shape-full);
      font: var(--gt-type-label-s);
      font-size: 10px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    .qc__pill.qc__on  { background: var(--gt-success-container); color: var(--gt-on-success-container); }
    .qc__pill.qc__off { background: var(--gt-surface-container); color: var(--gt-on-surface-variant); }

    .qc__action.qc__danger,
    .qc__action.qc__danger .qc__action-icon { color: var(--gt-error); }
    .qc__action.qc__danger:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-error) 8%, transparent); }

    /* Fila estática: el Script ID queda oculto; solo se copia. */
    .qc__row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px var(--gt-space-1) 2px var(--gt-space-3);
      font-size: 12px;
      color: var(--gt-on-surface);
    }
    .qc__row .qc__action-label { flex: 1 1 auto; }
    .qc__row .gt-icon-btn { color: var(--gt-primary); }
    .qc__row .gt-icon-btn.qc__copied {
      background: var(--gt-success-container);
      color: var(--gt-on-success-container);
    }

    .qc__divider {
      height: 1px;
      background: var(--gt-outline-variant);
      margin: var(--gt-space-1) 6px;
    }
  `;

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
    // Overlay de borrado masivo huérfano: se retira si no hay borrado en curso.
    if (!this._isBulkBusy_()) document.getElementById('qcBulkDeleteOverlay')?.remove();
    clearTimeout(this._copyTimer);
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
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (pop) pop.hidden = true;
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

  /** Pinta el shadow DOM inicial (contenedor) y adopta estilos. @private */
  _render_() {
    DomUtils.setHTML(this.shadowRoot, `
      <div class="gt-popover gt-popover--card qc__popover" id="qcPopover" role="dialog" hidden aria-label="${DomUtils.escapeHtml(DomUtils.t('edActionsTitle', 'Project actions'))}"></div>
    `);
    GasUi.adopt(this.shadowRoot, GasActionsPanel.STYLES);
  }

  // ── Render del popover ────────────────────────────────────────────────

  /** Pinta el contenido del popover. @private */
  _renderPopover_() {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;

    const hideTree = this._readHideTree_();
    const scriptId = this._getScriptId_();

    const esc = (key, fallback) => DomUtils.escapeHtml(DomUtils.t(key, fallback));
    const copyLabel = esc('edActionsCopyScriptId', 'Copy script ID');
    DomUtils.setHTML(pop, `
      <div class="gt-popover__header">
        <span class="gt-popover__icon">${GasUi.icon('sliders', 18)}</span>
        <span class="gt-popover__title">${esc('edActionsTitle', 'Project actions')}</span>
      </div>
      <div class="qc__pop-body">
        <div class="qc__group-title">${esc('edActionsGroupView', 'View')}</div>
        <button class="gt-menu-item qc__action" data-action="toggle-tree">
          <span class="qc__action-icon">${GasUi.icon(hideTree ? 'chevronRight' : 'chevronLeft', 18)}</span>
          <span class="qc__action-label">${hideTree ? esc('edActionsShowFileTree', 'Show file tree') : esc('edActionsHideFileTree', 'Hide file tree')}</span>
          <span class="qc__pill ${hideTree ? 'qc__off' : 'qc__on'}">${hideTree ? esc('edActionsOff', 'Off') : esc('edActionsOn', 'On')}</span>
        </button>

        <div class="qc__divider"></div>
        <div class="qc__group-title">${esc('edActionsGroupProject', 'Project')}</div>

        <!-- Fila Script ID con botón copiar a la derecha -->
        <div class="qc__row">
          <span class="qc__action-icon">${GasUi.icon('tag', 18)}</span>
          <span class="qc__action-label">${esc('edActionsScriptId', 'Script ID')}</span>
          <button class="gt-icon-btn" data-action="copy-id" ${scriptId ? '' : 'disabled'}
                  title="${copyLabel}" aria-label="${copyLabel}">${GasUi.icon('copy', 18)}</button>
        </div>

        <button class="gt-menu-item qc__action" data-action="download" ${scriptId ? '' : 'disabled'}>
          <span class="qc__action-icon">${GasUi.icon('download', 18)}</span>
          <span class="qc__action-label">${esc('edActionsDownloadProject', 'Download project')}</span>
          <span class="qc__action-meta" id="qcDownloadStatus"></span>
        </button>

        <button class="gt-menu-item qc__action qc__danger" data-action="bulk-delete" ${scriptId ? '' : 'disabled'}>
          <span class="qc__action-icon">${GasUi.icon('deleteSweep', 18)}</span>
          <span class="qc__action-label">${esc('edActionsBulkDeleteEllipsis', 'Bulk delete files…')}</span>
        </button>
      </div>
    `);

    // Click delegado.
    pop.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', this._onActionClick);
    });
    pop.hidden = false;
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
    const tree = this._findFileTree_();
    if (!tree) return;
    tree.style.display = hidden ? 'none' : '';

    // Reposicionar tras el reflow causado por el cambio de display.
    if (this._open) requestAnimationFrame(() => this._positionPopover_());
  }

  /**
   * Localiza el contenedor del árbol de archivos de GAS.
   * Orden: `aria-label` estable → clases ofuscadas legadas → lista de
   * archivos (`ul[role="listbox"]` con `li[data-res-id]`) dentro de la
   * `c-wiz` activa, por si GAS cambia las dos anteriores.
   * @returns {HTMLElement|null}
   * @private
   */
  _findFileTree_() {
    return document.querySelector('[aria-label="File browser"]')
      || document.querySelector('.Kp2okb.SQyOec') // selector legado (clases ofuscadas).
      || document
        .querySelector('c-wiz[data-p][aria-busy="false"] ul[role="listbox"] li[role="option"][data-res-id]')
        ?.closest('ul[role="listbox"]')
      || null;
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
      this._toast_(DomUtils.t('edActionsCopyFailed', 'Could not copy to clipboard'));
    }
  }

  /**
   * Feedback de copiado: icono `check` en verde durante 1.4 s.
   * @param {HTMLButtonElement} btn
   * @private
   */
  _flashCopyOk_(btn) {
    if (!btn) return;
    const setIcon_ = (name) => DomUtils.setHTML(btn, GasUi.icon(name, 18));
    btn.classList.add('qc__copied');
    setIcon_('check');
    btn.setAttribute('aria-label', DomUtils.t('edActionsCopied', 'Copied'));
    clearTimeout(this._copyTimer);
    this._copyTimer = setTimeout(() => {
      btn.classList.remove('qc__copied');
      setIcon_('copy');
      btn.setAttribute('aria-label', DomUtils.t('edActionsCopyScriptId', 'Copy script ID'));
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
    const sidebar = this._findFileTree_();
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
    setStatus(DomUtils.t('edActionsFetching', 'Fetching…'));
    btn.setAttribute('disabled', '');
    try {
      const response = await this._requestDownload_(id);
      if (!response?.ok) throw new Error(response?.error || DomUtils.t('edActionsUnknownError', 'Unknown error'));
      const data = response.data;
      if (!data) throw new Error(DomUtils.t('edActionsEmptyResponse', 'Empty response'));

      setStatus(DomUtils.t('edActionsPacking', 'Packing…'));

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
      setStatus(DomUtils.t('edActionsSaving', 'Saving…'));
      const dlUrl = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href     = dlUrl;
      a.download = this._buildDownloadFileName_();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 2000);

      setStatus(DomUtils.t('edActionsDone', 'Done ✓'));
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      console.warn('[GASTools] Download failed:', err);
      setStatus(DomUtils.t('edActionsFailed', 'Failed'));
      this._toast_(DomUtils.t('edActionsDownloadFailed', 'Download failed: $1', err?.message || err));
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
   * Resuelve con `{ ok, data?, error? }`; si el background no responde en
   * 60 s resuelve con `{ ok:false, error }` (el listener siempre se elimina).
   *
   * @param {string} scriptId
   * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
   * @private
   */
  async _requestDownload_(scriptId) {
    const detail = await DomUtils.bridgeRequest(
      'GAS_DownloadProject',
      'GAS_DownloadProjectResult',
      { scriptId },
      {
        timeoutMs: 60000,
        requestId: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      }
    );
    return detail || { ok: false, error: DomUtils.t('edActionsDownloadTimeout', 'Download timed out (no response from extension)') };
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
   * Toast compartido (`GasUi.toast`); sigue visible aunque el popover se cierre.
   * @param {string} text
   * @param {string} [kind='error']
   * @private
   */
  _toast_(text, kind = 'error') {
    GasUi.toast(this.shadowRoot, { text, kind, closeLabel: DomUtils.t('edActionsClose', 'Close') });
  }

  // ── Posicionamiento del popover ───────────────────────────────────────

  /**
   * Alinea el popover al borde derecho del ancla (`GasUi.positionPopover`).
   * Si la toolbar se reinyectó, re-resuelve el botón; sin ancla cierra
   * (antes saltaba a (0,0)).
   * @private
   */
  _positionPopover_() {
    const pop = this.shadowRoot.getElementById('qcPopover');
    if (!pop) return;
    this._anchorEl = GasUi.liveAnchor(this._anchorEl, GasActionsPanel.ANCHOR_SELECTOR);
    if (!this._anchorEl) { this.close(); return; }
    GasUi.positionPopover(pop, this._anchorEl, { align: 'end', gap: 10 });
  }

  // ── Listeners globales ────────────────────────────────────────────────

  _onDocumentMouseDown(e) {
    if (!this._open) return;
    const path = e.composedPath?.() || [];
    if (path.includes(this)) return;
    if (this._anchorEl && path.includes(this._anchorEl)) return;
    this.close();
  }

  /**
   * Gestor único de Escape: primero el modal de borrado (salvo en curso o
   * completado, que son bloqueantes) y luego el popover. `GasUi.confirm`
   * gestiona su propio Escape y detiene la propagación.
   * @param {KeyboardEvent} e
   * @private
   */
  _onWindowKeyDown(e) {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('qcBulkDeleteOverlay');
    if (overlay) {
      e.preventDefault();
      if (!this._isBulkBusy_() && !overlay.hasAttribute('data-completed')) this._closeBulkOverlay_(overlay);
      return;
    }
    if (this._open) this.close();
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
        resolve({ ok: false, error: DomUtils.t('edActionsTimeout', 'Timeout') });
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
  async _ensureGoogleAuth_({ onSignIn } = {}) {
    // Timeout corto: si el content script no responde (pestaña sin recargar
    // tras actualizar la extensión) hay que avisarlo, no esperar 16 minutos.
    const cached = await this._bridgeCall_('GAS_GG_GET_AUTH', {}, { timeoutMs: 10000 });
    if (cached?.user) return { user: cached.user };
    if (cached && cached.ok === false) return { user: null, reason: 'no-bridge', error: cached.error };
    onSignIn?.();
    const res = await this._bridgeCall_('GAS_GG_AUTHENTICATE');
    if (res?.ok && res.user) return { user: res.user };
    return { user: null, reason: 'sign-in', error: res?.error || '' };
  }

  /**
   * Abre el modal de borrado masivo y carga la lista del proyecto.
   * El modal se muestra de inmediato y cada paso (sesión de Google, carga)
   * se informa DENTRO de él: el menú de acciones se cierra al empezar, así
   * que sus toasts no se verían.
   * @private
   */
  async _openBulkDeleteModal_() {
    const scriptId = this._getScriptId_();
    if (!scriptId) {
      this._toast_(DomUtils.t('edActionsNoScriptId', 'No script id available.'));
      return;
    }

    this.close();
    const overlay = this._buildBulkDeleteOverlay_();
    await this._loadBulkDeleteFiles_(overlay, scriptId);
  }

  /**
   * Conecta con Google y carga los archivos del proyecto en el modal.
   * Reutilizable desde el botón "Reintentar".
   * @param {HTMLElement} overlay
   * @param {string} scriptId
   * @private
   */
  async _loadBulkDeleteFiles_(overlay, scriptId) {
    const list = this._bulkRoot_(overlay).getElementById('qcBdList');
    const spinner_ = (text) => list.replaceChildren(this._bulkDeleteSpinner_(text));

    spinner_(DomUtils.t('edActionsConnectingGoogle', 'Connecting to Google…'));
    const auth = await this._ensureGoogleAuth_({
      onSignIn: () => spinner_(DomUtils.t('edActionsWaitingSignIn', 'Complete the Google sign-in in the window that opened…')),
    });
    if (!overlay.isConnected) return;   // el usuario cerró el modal
    if (!auth.user) {
      const message = auth.reason === 'no-bridge'
        ? DomUtils.t('edActionsNoBridge', 'The extension is not responding in this tab. Reload the Apps Script tab and try again.')
        : DomUtils.t('edActionsSignInRequired', 'Google sign-in is required to use this action.');
      list.replaceChildren(this._bulkDeleteError_(overlay, scriptId, message, auth.error));
      return;
    }

    spinner_(DomUtils.t('edActionsLoadingFiles', 'Loading project files…'));
    const res = await this._ggApi_('GET_CONTENT', { scriptId });
    if (!overlay.isConnected) return;
    if (!res?.ok || !res.data) {
      list.replaceChildren(this._bulkDeleteError_(
        overlay, scriptId,
        DomUtils.t('edActionsReadProjectFailed', 'Could not read project'),
        res?.error || '',
      ));
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

  /**
   * Construye el modal de borrado masivo (`gt-scrim` + `gt-dialog`) en Shadow
   * DOM y cablea sus listeners. El click sobre el scrim NO cierra el modal;
   * Escape lo gestiona `_onWindowKeyDown`.
   *
   * @returns {HTMLElement} Host del modal.
   * @private
   */
  _buildBulkDeleteOverlay_() {
    document.getElementById('qcBulkDeleteOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'qcBulkDeleteOverlay';
    document.body.appendChild(overlay);

    const esc = (key, fallback, ...subs) => DomUtils.escapeHtml(DomUtils.t(key, fallback, ...subs));
    const shadow = overlay.attachShadow({ mode: 'open' });
    DomUtils.setHTML(shadow, `
      <div class="gt-scrim">
        <div class="gt-dialog qc__bd-modal" role="dialog" aria-modal="true" aria-labelledby="qcBdTitle">
          <div class="qc__bd-head">
            <span class="qc__bd-headIcon">${GasUi.icon('deleteSweep', 20)}</span>
            <h2 class="qc__bd-title" id="qcBdTitle">${esc('edActionsBulkDelete', 'Bulk delete files')}</h2>
            <button class="gt-icon-btn" id="qcBdClose" aria-label="${esc('edActionsClose', 'Close')}" title="${esc('edActionsClose', 'Close')}">${GasUi.icon('close', 18)}</button>
          </div>
          <div class="qc__bd-search">
            <span class="qc__bd-searchIcon">${GasUi.icon('search', 18)}</span>
            <input class="gt-input" id="qcBdFilter" type="text" placeholder="${esc('edActionsSearchFiles', 'Search files…')}" aria-label="${esc('edActionsSearchFiles', 'Search files…')}" autocomplete="off">
          </div>
          <div class="qc__bd-toolbar">
            <label class="qc__bd-selectall" for="qcBdSelectAllChk">
              <input type="checkbox" id="qcBdSelectAllChk">
              <span>${esc('edActionsSelectAllVisible', 'Select all (visible)')}</span>
            </label>
            <span class="qc__bd-counter" id="qcBdCounter">${esc('edActionsSelectedCount', 'Selected: $1', 0)}</span>
          </div>
          <div class="qc__bd-list" id="qcBdList"></div>
          <div class="qc__bd-progress" id="qcBdProgress" hidden></div>
          <div class="qc__bd-foot">
            <span class="qc__bd-status" id="qcBdStatus"></span>
            <button class="gt-btn gt-btn--text" id="qcBdCancel">${esc('edActionsCancel', 'Cancel')}</button>
            <button class="gt-btn gt-btn--filled gt-btn--danger" id="qcBdConfirm" disabled>${esc('edActionsDeleteSelected', 'Delete selected')}</button>
          </div>
        </div>
      </div>
    `);
    GasUi.adopt(shadow, GasActionsPanel.BULK_STYLES);

    const closeOverlay = () => this._closeBulkOverlay_(overlay);
    shadow.getElementById('qcBdClose').addEventListener('click', closeOverlay);
    shadow.getElementById('qcBdCancel').addEventListener('click', closeOverlay);

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

    shadow.getElementById('qcBdFilter').focus();
    return overlay;
  }

  /**
   * Cierra el modal de borrado salvo que haya una eliminación en curso.
   * @param {HTMLElement} overlay
   * @private
   */
  _closeBulkOverlay_(overlay) {
    if (this._isBulkBusy_()) return;
    overlay?.remove();
  }

  /** `true` si hay una eliminación en curso. @private */
  _isBulkBusy_() {
    return !!this._bulkDeleteState?.busy;
  }

  /**
   * CSS del modal de borrado masivo (sobre `GasUi.BASE_CSS`).
   * `--qc-folder-color` se hereda de :root (gas-folders): el icono de
   * carpeta respeta el color elegido en el popup.
   */
  static BULK_STYLES = `
    :host {
      position: fixed;
      inset: 0;
      z-index: var(--gt-z-modal);
      font-family: var(--gt-font-plain);
      color: var(--gt-on-surface);
    }

    .qc__bd-modal {
      position: relative;
      display: flex;
      flex-direction: column;
      width: min(560px, 100%);
      max-height: min(640px, calc(100vh - 64px));
      padding: 0;
      overflow: hidden;
      font-size: 13px;
    }
    .qc__bd-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: var(--gt-space-3) var(--gt-space-3) var(--gt-space-3) var(--gt-space-5);
      border-bottom: 1px solid var(--gt-outline-variant);
    }
    .qc__bd-headIcon { display: inline-flex; color: var(--gt-error); }
    .qc__bd-title {
      flex: 1;
      margin: 0;
      font: var(--gt-type-title-m);
      color: var(--gt-on-surface);
    }

    .qc__bd-search {
      display: flex;
      align-items: center;
      gap: var(--gt-space-2);
      padding: var(--gt-space-3) var(--gt-space-5);
      border-bottom: 1px solid var(--gt-outline-variant);
    }
    .qc__bd-searchIcon { display: inline-flex; color: var(--gt-on-surface-variant); }
    .qc__bd-search .gt-input { flex: 1; height: 34px; }

    .qc__bd-toolbar {
      display: flex;
      align-items: center;
      gap: var(--gt-space-3);
      padding: var(--gt-space-2) var(--gt-space-5) var(--gt-space-2) calc(var(--gt-space-1) + var(--gt-space-3));
      border-bottom: 1px solid var(--gt-outline-variant);
      background: var(--gt-surface-container);
      font-size: 12px;
      color: var(--gt-on-surface-variant);
    }
    .qc__bd-selectall {
      display: inline-flex;
      align-items: center;
      gap: var(--gt-space-2);
      color: var(--gt-on-surface);
      cursor: pointer;
    }
    .qc__bd-selectall:hover { color: var(--gt-primary); }
    .qc__bd-counter { margin-left: auto; }

    /* Mismo tamaño para todos los checkboxes (toolbar, carpetas y archivos). */
    input[type="checkbox"] {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--gt-primary);
      cursor: pointer;
    }

    .qc__bd-list,
    .qc__bd-progressBody {
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--gt-outline-variant) transparent;
    }
    .qc__bd-list {
      flex: 1 1 auto;
      min-height: 160px;
      padding: var(--gt-space-1);
    }

    .qc__bd-folder { margin: 2px 0; }
    .qc__bd-folder-header,
    .qc__bd-row {
      display: flex;
      align-items: center;
      gap: var(--gt-space-2);
      padding: 6px var(--gt-space-3);
      border-radius: var(--gt-shape-xs);
      transition: background-color var(--gt-motion-duration) var(--gt-motion-standard);
    }
    .qc__bd-folder-header { font-weight: 500; cursor: pointer; }
    .qc__bd-folder-header:hover,
    .qc__bd-row:hover { background: var(--gt-state-hover); }
    .qc__bd-folder-chevron {
      display: inline-flex;
      color: var(--gt-on-surface-variant);
      transition: transform var(--gt-motion-duration) var(--gt-motion-standard);
    }
    .qc__bd-folder.qc__bd-collapsed .qc__bd-folder-chevron { transform: rotate(-90deg); }
    .qc__bd-folder-icon { display: inline-flex; color: var(--qc-folder-color, var(--gt-primary)); }
    .qc__bd-folder-name { flex: 1; }
    .qc__bd-folder-children {
      margin-left: 20px;
      padding-left: var(--gt-space-3);
      border-left: 1px dotted var(--gt-outline-variant);
    }
    .qc__bd-folder.qc__bd-collapsed .qc__bd-folder-children { display: none; }

    .qc__bd-row label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    .qc__bd-type {
      padding: 2px 6px;
      border-radius: var(--gt-shape-xs);
      background: var(--gt-surface-container);
      color: var(--gt-on-surface-variant);
      font: 400 11px/1.4 var(--gt-font-mono);
      text-transform: uppercase;
    }

    .qc__bd-empty,
    .qc__bd-spinner {
      padding: 36px var(--gt-space-4);
      text-align: center;
      color: var(--gt-on-surface-variant);
    }
    .qc__bd-spinner::before,
    .qc__bd-spinnerInline {
      content: '';
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--gt-outline-variant);
      border-top-color: var(--gt-primary);
      border-radius: var(--gt-shape-full);
      vertical-align: middle;
      animation: qc__bd-spin .7s linear infinite;
    }
    .qc__bd-spinner::before { margin-right: var(--gt-space-2); }
    @keyframes qc__bd-spin { to { transform: rotate(360deg); } }
    .qc__bd-error { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .qc__bd-errorTitle { color: var(--gt-on-surface); font-weight: 600; }
    .qc__bd-errorDetail { max-width: 100%; font-size: 12px; color: var(--gt-error); word-break: break-word; }
    .qc__bd-errorHint { font-size: 12px; color: var(--gt-primary); }
    .qc__bd-retry { margin-top: var(--gt-space-1); }

    .qc__bd-foot {
      display: flex;
      align-items: center;
      gap: var(--gt-space-2);
      padding: var(--gt-space-3) var(--gt-space-5);
      border-top: 1px solid var(--gt-outline-variant);
    }
    .qc__bd-status { flex: 1; font-size: 12px; color: var(--gt-on-surface-variant); }

    /* Modo busy: el progreso ocupa el centro del modal. */
    :host([data-busy]) .qc__bd-search,
    :host([data-busy]) .qc__bd-toolbar,
    :host([data-busy]) .qc__bd-list { display: none; }
    :host([data-busy]) #qcBdClose,
    :host([data-busy]) .qc__bd-foot { pointer-events: none; opacity: .65; }
    :host([data-busy]) .qc__bd-progress {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
      margin: var(--gt-space-4);
      pointer-events: auto;
    }
    :host([data-busy]) .qc__bd-progressBody { flex: 1 1 auto; max-height: none; }

    .qc__bd-progress {
      flex: 0 0 auto;
      margin: 0 14px var(--gt-space-3);
      overflow: hidden;
      border: 1px solid var(--gt-outline-variant);
      border-radius: var(--gt-shape-m);
      background: var(--gt-surface-container);
      font-size: 12px;
    }
    .qc__bd-progressHead {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: var(--gt-space-3) 14px;
      cursor: pointer;
      user-select: none;
    }
    .qc__bd-progressHead:hover { background: var(--gt-state-hover); }
    .qc__bd-progressIcon { display: grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; color: var(--gt-primary); }
    .qc__bd-progressDone .qc__bd-progressIcon { color: var(--gt-success); }
    .qc__bd-progressError .qc__bd-progressIcon { color: var(--gt-error); }
    .qc__bd-progressTitle {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .qc__bd-progressMeta { margin-left: var(--gt-space-2); color: var(--gt-on-surface-variant); font-weight: 400; }
    .qc__bd-progressChevron {
      display: inline-flex;
      color: var(--gt-on-surface-variant);
      transition: transform var(--gt-motion-duration) var(--gt-motion-standard);
    }
    .qc__bd-progressOpen .qc__bd-progressChevron { transform: rotate(180deg); }
    .qc__bd-progressBody {
      display: none;
      max-height: 200px;
      padding: var(--gt-space-2) var(--gt-space-1);
      border-top: 1px solid var(--gt-outline-variant);
    }
    .qc__bd-progressOpen .qc__bd-progressBody { display: block; }
    .qc__bd-progressFiles { margin: 0; padding: 0 var(--gt-space-2); list-style: none; font: 400 11.5px/1.5 var(--gt-font-mono); }
    .qc__bd-progressFiles li {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px var(--gt-space-1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .qc__bd-fileIcon { display: inline-flex; flex: 0 0 auto; }
    .qc__bd-progressFile-pending { color: var(--gt-on-surface-variant); }
    .qc__bd-progressFile-pending .qc__bd-fileIcon { color: var(--gt-outline); }
    .qc__bd-progressFile-done .qc__bd-fileIcon { color: var(--gt-success); }
    .qc__bd-progressFile-error .qc__bd-fileIcon { color: var(--gt-error); }

    /* Aviso final bloqueante (recargar). */
    .qc__bd-okTitle { display: flex; align-items: center; gap: 10px; color: var(--gt-success); }
  `;

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
        ? DomUtils.t('edActionsNoFilterMatch', 'No files match this filter.')
        : DomUtils.t('edActionsNoFiles', 'The project has no files.')));
    } else {
      const frag = document.createDocumentFragment();
      const tree = this._buildFileTree_(visible);
      this._renderTreeNode_(tree, frag, s, overlay);
      list.replaceChildren(frag);
    }

    // Actualizamos contadores y el checkbox "select all".
    counter.textContent = DomUtils.t('edActionsSelectedCount', 'Selected: $1', s.selected.size);
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
        <input type="checkbox" class="qc__bd-folder-check" ${allSelected ? 'checked' : ''}
               data-folder="${DomUtils.escapeHtml(folderPath)}"
               aria-label="${DomUtils.escapeHtml(folderName)}">
        <span class="qc__bd-folder-chevron">${GasUi.icon('chevronDown', 18)}</span>
        <span class="qc__bd-folder-icon">${GasUi.icon('folder', 18)}</span>
        <span class="qc__bd-folder-name">${DomUtils.escapeHtml(folderName)}</span>
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
        <input type="checkbox" id="${id}" data-path="${DomUtils.escapeHtml(fullPath)}" ${checked}>
        <label for="${id}">${DomUtils.escapeHtml(displayName)}</label>
        <span class="qc__bd-type">${DomUtils.escapeHtml(file.type || '')}</span>
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
    root.getElementById('qcBdCounter').textContent = DomUtils.t('edActionsSelectedCount', 'Selected: $1', s.selected.size);
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
   * Confirmación previa a la eliminación (`GasUi.confirm` con la lista).
   * @param {HTMLElement} overlay
   * @returns {Promise<boolean>}
   * @private
   */
  _showDeleteConfirmation_(overlay) {
    const s = this._bulkDeleteState;
    if (!s || !s.selected.size) return Promise.resolve(false);
    const fileCount = this._fileCountLabel_(s.selected.size);
    return GasUi.confirm(this._bulkRoot_(overlay), {
      title: DomUtils.t('edActionsConfirmDeletion', 'Confirm deletion'),
      body: DomUtils.t('edActionsConfirmMessage', 'You are about to permanently delete $1 from this project. This action cannot be undone.', fileCount),
      items: Array.from(s.selected).sort(),
      confirmLabel: DomUtils.t('edActionsDeleteFilesBtn', 'Delete $1', fileCount),
      cancelLabel: DomUtils.t('edActionsCancel', 'Cancel'),
      danger: true,
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
        message: res?.error || DomUtils.t('edActionsDeleteFailed', 'Failed to delete files.'),
      });
      s.busy = false;
      overlay.removeAttribute('data-busy');
      confirm.disabled = false;
      cancel.disabled  = false;
      closeBt.disabled = false;
      status.textContent = res?.error || DomUtils.t('edActionsDeleteFailed', 'Failed to delete files.');
      return false;
    }

    this._markBulkProgress_(overlay, targets, 'done');
    this._finishBulkProgress_(overlay, {
      success: true,
      message: targets.length === 1 ? DomUtils.t('edActionsDeletedOne', '$1 file deleted.', 1) : DomUtils.t('edActionsDeletedMany', '$1 files deleted.', targets.length),
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
    const root = this._bulkRoot_(overlay);
    if (!s || !root) return;
    overlay.setAttribute('data-completed', '');

    const scrim = document.createElement('div');
    scrim.className = 'gt-scrim';
    const dialog = document.createElement('div');
    dialog.className = 'gt-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'qcBdOkTitle');

    const title = document.createElement('h2');
    title.className = 'gt-dialog__title qc__bd-okTitle';
    title.id = 'qcBdOkTitle';
    title.append(GasUi.iconNode(document, 'success', 22) || '', DomUtils.t('edActionsFilesDeleted', 'Files deleted'));

    // "$1" en negrita sin parsear HTML.
    const body = document.createElement('p');
    body.className = 'gt-dialog__body';
    const [before, after = ''] = DomUtils.t('edActionsCompletedMessage', '$1 were removed from this project. The Apps Script editor needs to reload to refresh its file tree; otherwise you would still see the old files in the sidebar.').split('$1');
    const strong = document.createElement('strong');
    strong.textContent = this._fileCountLabel_(s.selected.size);
    body.append(before, strong, after);

    const actions = document.createElement('div');
    actions.className = 'gt-dialog__actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'gt-btn gt-btn--filled';
    reload.append(GasUi.iconNode(document, 'refresh', 16) || '', DomUtils.t('edActionsReloadNow', 'Reload page now'));
    reload.addEventListener('click', () => window.location.reload());
    actions.appendChild(reload);

    dialog.append(title, body, actions);
    scrim.appendChild(dialog);
    root.appendChild(scrim);
    reload.focus();
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
          ${DomUtils.escapeHtml(DomUtils.t('edActionsDeletingFiles', 'Deleting files'))}
          <span class="qc__bd-progressMeta" id="qcBdProgressMeta">0/${files.length}</span>
        </span>
        <span class="qc__bd-progressChevron">${GasUi.icon('chevronDown', 18)}</span>
      </div>
      <div class="qc__bd-progressBody" id="qcBdProgressBody">
        <ul class="qc__bd-progressFiles" id="qcBdProgressFiles">
          ${files.map((path) => `
            <li data-path="${DomUtils.escapeHtml(path)}" class="qc__bd-progressFile-pending">
              <span class="qc__bd-fileIcon">${GasUi.icon('radioUnchecked', 14)}</span>
              <span>${DomUtils.escapeHtml(path)}</span>
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
      pending: 'radioUnchecked',
      done:    'success',
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
      const icon = li.querySelector('.qc__bd-fileIcon');
      if (icon) DomUtils.setHTML(icon, GasUi.icon(iconByStatus[status] || 'radioUnchecked', 14));
    }

    if (meta) {
      const total = list.children.length;
      const done = list.querySelectorAll('.qc__bd-progressFile-done').length;
      const failed = list.querySelectorAll('.qc__bd-progressFile-error').length;
      meta.textContent = failed
        ? DomUtils.t('edActionsProgressFailed', '$1/$2 ($3 failed)', done, total, failed)
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
      DomUtils.setHTML(iconWrap, GasUi.icon(result.success ? 'success' : 'error', 18));
    }

    panel.classList.toggle('qc__bd-progressDone',  !!result.success);
    panel.classList.toggle('qc__bd-progressError', !result.success);
    // Con error la lista vuelve a verse: plegamos el log para no apilar dos scrolls.
    if (!result.success) panel.classList.remove('qc__bd-progressOpen');

    const titleNode = panel.querySelector('.qc__bd-progressTitle');
    if (titleNode) {
      const meta = titleNode.querySelector('.qc__bd-progressMeta')?.textContent || '';
      DomUtils.setHTML(titleNode, `
        ${DomUtils.escapeHtml(result.success ? DomUtils.t('edActionsFilesDeleted', 'Files deleted') : DomUtils.t('edActionsDeletionFailed', 'Deletion failed'))}
        <span class="qc__bd-progressMeta">${DomUtils.escapeHtml(meta)}</span>
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

  /**
   * Estado de error dentro del modal: mensaje, detalle técnico, pista para
   * activar la API de Apps Script cuando aplica y botón "Reintentar".
   * Construido con DOM + textContent (el detalle viene de APIs externas).
   * @param {HTMLElement} overlay
   * @param {string} scriptId
   * @param {string} message
   * @param {string} [detail]
   * @returns {HTMLElement}
   * @private
   */
  _bulkDeleteError_(overlay, scriptId, message, detail = '') {
    const el = document.createElement('div');
    el.className = 'qc__bd-empty qc__bd-error';

    const title = document.createElement('div');
    title.className = 'qc__bd-errorTitle';
    title.textContent = message;
    el.appendChild(title);

    if (detail) {
      const det = document.createElement('div');
      det.className = 'qc__bd-errorDetail';
      det.textContent = detail;
      el.appendChild(det);
    }

    // La causa más común: la API de Apps Script desactivada en la cuenta.
    if (/apps script api|has not (been )?(used|enabled)|not enabled|disabled|\b403\b/i.test(detail)) {
      const hint = document.createElement('a');
      hint.className = 'qc__bd-errorHint';
      hint.href = 'https://script.google.com/home/usersettings';
      hint.target = '_blank';
      hint.rel = 'noopener noreferrer';
      hint.textContent = DomUtils.t('edActionsEnableApiHint', 'Turn on the Google Apps Script API in your Apps Script settings, wait a minute and retry.');
      el.appendChild(hint);
    }

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'gt-btn gt-btn--filled qc__bd-retry';
    retry.textContent = DomUtils.t('edActionsRetry', 'Retry');
    retry.addEventListener('click', () => this._loadBulkDeleteFiles_(overlay, scriptId));
    el.appendChild(retry);
    return el;
  }

  /** Devuelve el placeholder de estado vacío. @private */
  _bulkDeleteEmpty_(text) {
    const el = document.createElement('div');
    el.className = 'qc__bd-empty';
    el.textContent = text;
    return el;
  }

  /** Texto "N file(s)" traducido con singular/plural. @private */
  _fileCountLabel_(count) {
    return count === 1
      ? DomUtils.t('edActionsFileCountOne', '$1 file', count)
      : DomUtils.t('edActionsFileCountMany', '$1 files', count);
  }
}

if (!customElements.get('gas-actions-panel')) {
  customElements.define('gas-actions-panel', GasActionsPanel);
}
