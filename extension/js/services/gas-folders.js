"use strict";

/**
 * @fileoverview gas-folders.js
 * Convierte la lista plana del editor de Apps Script en un árbol de
 * carpetas (interpretando `/` en `title`) con iconos por extensión.
 * Sincronización vía MutationObserver y rebuild idempotente.
 */
class GasFolders {
  static FOLDER_CLASS          = 'qc__folder-item';
  static FOLDER_HEADER_CLASS   = 'qc__folder-header';
  static FOLDER_CHILDREN_CLASS = 'qc__folder-children';
  static FOLDER_ICON_WRAPPER   = 'qc__folder-icon-wrapper';
  static FOLDER_CHEVRON_CLASS  = 'qc__folder-chevron';
  static COLLAPSED_CLASS       = 'qc__folder-collapsed';
  static FILE_ICON_CLASS       = 'qc__file-icon';

  static SVG_CHEVRON     = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
  static SVG_FOLDER      = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  static SVG_FOLDER_OPEN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/><path d="M3 9h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/></svg>`;

  /**
   * Plantilla SVG común con la silueta de página doblada. El interior
   * recibe el símbolo específico por tipo de archivo.
   * @param {string} color
   * @param {string} content
   * @returns {string}
   * @private
   */
  static _filePageSvg(color, content) {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">` +
      `<path d="M3 2h6.5L13 5.5V14H3z" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="M9.5 2v3.5H13" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `${content}</svg>`;
  }

  static MAX_RETRY_ATTEMPTS = 30;
  static RETRY_INTERVAL_MS  = 500;

  constructor() {
    this._enabled        = false;
    this._observer       = null;
    this._docObserver    = null;
    /** @type {HTMLUListElement[]} */
    this._rootLists      = [];
    this._isRebuilding   = false;
    this._rebuildTimeout = null;
    this._folderColor    = '#5f6368';
    this._fileColors     = { gs: '#4086f4', html: '#fc490b', json: '#1bb24b', generic: '#9aa0a6' };
    this._retryCount     = 0;
    this._retryTimer     = null;
    this._pendingApply   = null;
    this._dirtyDuringRebuild = false;
  }

  /**
   * Cambia el color de los iconos de carpeta y refresca los estilos.
   * @param {string} color
   */
  setColor(color) {
    if (!color) return;
    this._folderColor = color;
    if (this._enabled) this._updateStyles_();
  }

  /**
   * Actualiza uno o varios colores de iconos por extensión y dispara
   * un rebuild para regenerar los SVG ya inyectados.
   * @param {{gs?:string, html?:string, json?:string, generic?:string}} colors
   */
  setFileColors(colors) {
    if (!colors || typeof colors !== 'object') return;
    let changed = false;
    for (const key of ['gs', 'html', 'json', 'generic']) {
      if (typeof colors[key] === 'string' && colors[key]) {
        this._fileColors[key] = colors[key];
        changed = true;
      }
    }
    if (!changed) return;
    if (this._enabled) {
      if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
      this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 50);
    }
  }

  /** Activa el componente: estilos, observers y primer rebuild. */
  enable() {
    if (!this._enabled) {
      this._enabled = true;
      this._injectStyles();
    }
    this._startObserving();
    this._rebuildFullTree();
  }

  /** Desactiva el componente y restaura el árbol original de GAS. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._stopRetry();
    if (this._observer)    { this._observer.disconnect();    this._observer    = null; }
    if (this._docObserver) { this._docObserver.disconnect(); this._docObserver = null; }
    if (this._rebuildTimeout) { clearTimeout(this._rebuildTimeout); this._rebuildTimeout = null; }
    this._restoreOriginalList();
    this._rootLists = [];
  }

  /**
   * El componente respeta el modo dark del IDE leído desde dos clases
   * del body: la nuestra (`gc__is-dark-mode`) y la oficial de GAS
   * (`ide-dark-mode`).
   * @returns {boolean}
   * @private
   */
  _isEditorDark_() {
    const cl = document.body.classList;
    return cl.contains('gc__is-dark-mode') || cl.contains('ide-dark-mode');
  }

  /** @private */
  _injectStyles() { this._updateStyles_(); }

  /**
   * Crea o actualiza el `<style>` global. Las variables de color y el
   * color de las líneas del árbol se recalculan cada vez para reflejar
   * cambios de tema o de configuración sin recargar la página.
   * @private
   */
  _updateStyles_() {
    let style = document.getElementById('gas-folders-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'gas-folders-styles';
      document.head.appendChild(style);
    }
    const lineOpacity = 0.3;
    const dark        = this._isEditorDark_();
    const lineColor   = dark
      ? `rgba(255,255,255,${lineOpacity})`
      : `rgba(0,0,0,${lineOpacity})`;
    style.textContent = `
      :root {
        --qc-folder-color : ${this._folderColor};
        --qc-tree-line    : ${lineColor};
      }
      li[role="option"] > img,
      li[role="option"] > svg,
      li[role="option"] > span:first-child:not(.${GasFolders.FILE_ICON_CLASS}) > svg,
      li[role="option"] > span:first-child:not(.${GasFolders.FILE_ICON_CLASS}) > img {
        visibility : hidden !important;
        width      : 0      !important;
        height     : 0      !important;
        margin     : 0      !important;
        padding    : 0      !important;
        overflow   : hidden !important;
      }
      .${GasFolders.FOLDER_CLASS} {
        list-style : none       !important;
        margin     : 0          !important;
        padding    : 0          !important;
        z-index    : 0          !important;
        width      : 100%       !important;
        position   : relative   !important;
        background : transparent !important;
      }
      .${GasFolders.FOLDER_HEADER_CLASS} {
        display         : flex;
        align-items     : center;
        padding         : 0px 12px 0px 0;
        cursor          : pointer;
        font-size       : 13px;
        font-weight     : 500;
        color           : var(--gm3-sys-color-on-surface, inherit);
        border-radius   : 0 20px 20px 0;
        margin-right    : 8px;
        transition      : background-color 0.1s;
        user-select     : none;
        position        : relative;
        z-index         : 5;
        min-height      : 36px;
      }
      .${GasFolders.FOLDER_HEADER_CLASS}:hover {
        background-color: var(--gm3-sys-color-surface-container-high, rgba(60,64,67,.08));
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} {
        margin-left  : 8px  !important;
        padding-left : 14px !important;
        display      : block !important;
        position     : relative !important;
        border-left  : none !important;
      }
      .${GasFolders.COLLAPSED_CLASS} .${GasFolders.FOLDER_CHILDREN_CLASS} {
        display: none !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li {
        position   : relative    !important;
        list-style : none        !important;
        min-height : 36px        !important;
        display    : block       !important;
        background : transparent !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li::before {
        content        : "";
        position       : absolute;
        left           : -14px;
        top            : 0;
        bottom         : 0;
        width          : 1px;
        border-left    : 1px dotted var(--qc-tree-line);
        pointer-events : none;
        z-index        : 1;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li:last-child::before {
        height : 18px;
        bottom : auto;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li::after {
        content        : "";
        position       : absolute;
        left           : -14px;
        top            : 18px;
        width          : 14px;
        height         : 1px;
        border-top     : 1px dotted var(--qc-tree-line);
        pointer-events : none;
        z-index        : 1;
      }
      .${GasFolders.FOLDER_CHEVRON_CLASS} {
        width           : 20px;
        height          : 20px;
        display         : flex;
        align-items     : center;
        justify-content : center;
        transition      : transform 0.2s;
        color           : var(--gm3-sys-color-on-surface-variant, #5f6368);
      }
      .${GasFolders.COLLAPSED_CLASS} .${GasFolders.FOLDER_CHEVRON_CLASS} {
        transform: rotate(-90deg);
      }
      .${GasFolders.FOLDER_ICON_WRAPPER} {
        margin-right    : 8px;
        display         : flex;
        align-items     : center;
        justify-content : center;
        color           : var(--qc-folder-color);
      }
      .${GasFolders.FILE_ICON_CLASS} {
        margin-right    : 6px;
        display         : flex;
        align-items     : center;
        justify-content : center;
        flex-shrink     : 0;
        visibility      : visible !important;
      }
      .${GasFolders.FILE_ICON_CLASS} svg,
      .${GasFolders.FILE_ICON_CLASS} img {
        visibility : visible !important;
        width      : 16px    !important;
        height     : 16px    !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] {
        padding-left : 4px          !important;
        margin       : 0            !important;
        background   : transparent ;
        border       : none         !important;
        display      : flex         !important;
        align-items  : center       !important;
        z-index      : 2;
        min-height   : 36px         !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"]:hover {
        background: var(--gm3-sys-color-surface-container-high, rgba(60,64,67,.08));
      }
      /* Ocultamos el textContent original de GAS sin tocarlo (escribirlo
         dispararía un loop de mutaciones). El nombre visible se renderiza
         vía pseudo-elemento ::before alimentado por data-name. */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title][data-name]:not([data-name=""]) {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        text-decoration: none !important;
        text-decoration-color: transparent !important;
        text-shadow: none !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title][data-name]:not([data-name=""]) > *:not(input):not(.${GasFolders.FILE_ICON_CLASS}) {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        text-decoration: none !important;
        text-decoration-color: transparent !important;
        text-shadow: none !important;
        border-bottom-color: transparent !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title] {
        position: relative;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title][data-name]:not([data-name=""])::before {
        content: attr(data-name);
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        color: var(--gm3-sys-color-on-surface, #202124);
        -webkit-text-fill-color: var(--gm3-sys-color-on-surface, #202124);
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      body.gc__is-dark-mode .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title][data-name]:not([data-name=""])::before,
      body.ide-dark-mode .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title][data-name]:not([data-name=""])::before {
        color: var(--gm3-sys-color-on-surface, #e8eaed);
        -webkit-text-fill-color: var(--gm3-sys-color-on-surface, #e8eaed);
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li.qc-renaming div[title]::before {
        display: none !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title] input {
        color: var(--gm3-sys-color-on-surface, inherit) !important;
      }
    `;
  }

  /**
   * Cancela el timer de retry y resetea el contador.
   * @private
   */
  _stopRetry() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryCount = 0;
  }

  /**
   * Localiza los `<ul role="listbox">` y conecta los observers.
   * Reintenta hasta `MAX_RETRY_ATTEMPTS` mientras los UL no tengan ítems.
   * @private
   */
  _startObserving() {
    if (!this._enabled) return;
    const uls = Array.from(document.querySelectorAll('ul[role="listbox"]'));
    const validUls = uls.filter(ul => ul.querySelector('li[role="option"]'));
    if (validUls.length === 0) {
      this._retryCount++;
      if (this._retryCount > GasFolders.MAX_RETRY_ATTEMPTS) {
        console.warn('[GasFolders] Ningún <ul role="listbox"> válido encontrado tras',
          GasFolders.MAX_RETRY_ATTEMPTS, 'intentos. Se detiene el retry.');
        return;
      }
      requestAnimationFrame(() => this._startObserving());
      return;
    }
    this._stopRetry();

    const ulsChanged = validUls.length !== this._rootLists.length ||
                       validUls.some((ul, i) => ul !== this._rootLists[i]);
    if (!ulsChanged && this._observer) return;
    this._rootLists = validUls;

    if (this._observer)    this._observer.disconnect();
    if (this._docObserver) this._docObserver.disconnect();

    this._observer = new MutationObserver((mutations) => {
      if (!this._enabled) return;

      this._syncRenamingState_(mutations);

      const themeChanged = mutations.some(
        m => m.target === document.body && m.attributeName === 'class'
      );
      if (themeChanged) this._updateStyles_();

      // Si el usuario está renombrando, ignoramos cualquier rebuild: el
      // rebuild reescribe el subárbol del li y rompería la edición.
      if (this._isAnyItemRenaming_()) return;

      const ownStructuralClasses = [
        GasFolders.FOLDER_HEADER_CLASS,
        GasFolders.FOLDER_CHEVRON_CLASS,
        GasFolders.FOLDER_ICON_WRAPPER,
        GasFolders.FOLDER_CHILDREN_CLASS,
        GasFolders.FILE_ICON_CLASS,
      ];
      const containsGasItem = (list) => {
        for (const node of list || []) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.('li[role="option"]')) return true;
          if (node.querySelector?.('li[role="option"]')) return true;
        }
        return false;
      };

      const needsUpdate = mutations.some(m => {
        const el = /** @type {Element} */ (m.target);
        const isOwnStructural = ownStructuralClasses.some(
          cls => el.closest?.(`.${cls}`),
        );
        const isGasItem = el.closest?.('li[role="option"]');
        const hasItemChange = m.type === 'childList' && (
          containsGasItem(m.addedNodes) || containsGasItem(m.removedNodes)
        );
        if (isOwnStructural && !isGasItem && !hasItemChange) return false;

        if (m.type === 'childList' && m.addedNodes.length > 0) {
          const onlyInputAdded = [...m.addedNodes].every(
            n => n instanceof Element && n.matches?.('input'),
          );
          if (onlyInputAdded) return false;
        }

        if (isGasItem && isGasItem.querySelector?.('input')) {
          const inputBeingRemoved = m.type === 'childList' &&
            [...(m.removedNodes || [])].some(
              n => n instanceof Element && n.matches?.('input'),
            );
          if (!inputBeingRemoved) return false;
        }

        return m.type === 'childList' ||
               (m.type === 'attributes' && m.attributeName === 'title');
      });

      if (needsUpdate) {
        if (this._isRebuilding) {
          this._dirtyDuringRebuild = true;
          return;
        }
        if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
        this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 100);
      }
    });

    this._rootLists.forEach(ul => {
      this._observer.observe(ul, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['title']
      });
    });
    this._observer.observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });

    // Observador secundario para detectar reemplazos del UL en navegaciones SPA.
    this._docObserver = new MutationObserver((mutations) => {
      if (!this._enabled) return;
      const externalMutation = mutations.some(m => {
        const el = /** @type {Element} */ (m.target);
        return !el.closest?.(`.${GasFolders.FOLDER_CLASS}`) &&
               !el.closest?.(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
      });
      if (!externalMutation) return;
      const currentUls = Array.from(document.querySelectorAll('ul[role="listbox"]'))
        .filter(ul => ul.querySelector('li[role="option"]'));
      const hasChanges = currentUls.length !== this._rootLists.length ||
                         currentUls.some((ul, i) => ul !== this._rootLists[i]);
      if (hasChanges) {
        this._startObserving();
        this._rebuildFullTree();
      }
    });
    this._docObserver.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Reordena los items en una jerarquía de carpetas según el `title`
   * con segmentos `carpeta/archivo`. Reentrante-safe vía `_isRebuilding`.
   * @private
   */
  _rebuildFullTree() {
    if (!this._enabled || !this._rootLists?.length || this._isRebuilding) return;

    // Aborta si hay un rename abierto: lo reintenta en 200 ms.
    if (this._isAnyItemRenaming_()) {
      if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
      this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 200);
      return;
    }

    this._isRebuilding       = true;
    this._dirtyDuringRebuild = false;
    if (this._observer)    this._observer.disconnect();
    if (this._docObserver) this._docObserver.disconnect();
    try {
      this._rootLists.forEach((ul, index) => {
        this._restoreList(ul);
        const items = Array.from(ul.children)
          .filter(li => li.getAttribute('role') === 'option');
        items.forEach(item => {
          const titleDiv = item.querySelector('div[title]');
          if (!titleDiv) return;
          const fullPath = titleDiv.getAttribute('title');
          if (!fullPath || !fullPath.includes('/')) {
            this._updateItemLabel(item, fullPath);
            this._injectFileIcon(item, fullPath);
            return;
          }
          const parts      = fullPath.split('/');
          const fileName   = parts.pop();
          const folderPath = parts.join('/');
          const folderItem        = this._getOrCreateFolder(ul, folderPath, index);
          const childrenContainer = folderItem.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
          childrenContainer.appendChild(item);
          this._updateItemLabel(item, fileName);
          this._injectFileIcon(item, fileName);
        });
      });
      this._removeEmptyFolders();
    } finally {
      this._isRebuilding = false;
      this._reconnectObserver();
      this._reconnectDocObserver();
      if (this._dirtyDuringRebuild) {
        this._dirtyDuringRebuild = false;
        this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 100);
      }
    }
  }

  /** @private */
  _reconnectObserver() {
    if (!this._enabled || !this._observer) return;
    this._rootLists.forEach(ul => {
      this._observer.observe(ul, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['title']
      });
    });
    this._observer.observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });
  }

  /** @private */
  _reconnectDocObserver() {
    if (!this._enabled || !this._docObserver) return;
    this._docObserver.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * Devuelve el `<li>` de la carpeta indicada, creando los nodos
   * intermedios que falten.
   * @param {HTMLUListElement} ul
   * @param {string} path  Ruta separada por `/`.
   * @param {number} ulIndex
   * @returns {HTMLLIElement}
   * @private
   */
  _getOrCreateFolder(ul, path, ulIndex) {
    const parts = path.split('/');
    let currentParent = ul;
    let currentPath   = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folderId = `qc-fld-${ulIndex}-${currentPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
      let folderItem = ul.querySelector(`#${folderId}`);
      if (!folderItem) {
        folderItem = this._createFolderItem(part, folderId);
        currentParent.appendChild(folderItem);
      }
      currentParent = folderItem.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
    }
    return ul.querySelector(`#qc-fld-${ulIndex}-${path.replace(/[^a-zA-Z0-9]/g, '-')}`);
  }

  /**
   * Construye un `<li>` de carpeta con header (chevron + icono + label)
   * y contenedor de hijos. El header alterna `COLLAPSED_CLASS` al click.
   * @param {string} name
   * @param {string} id
   * @returns {HTMLLIElement}
   * @private
   */
  _createFolderItem(name, id) {
    const li = document.createElement('li');
    li.id        = id;
    li.className = `${GasFolders.FOLDER_CLASS} ${DomUtils.REF_CLASS}`;

    const header = document.createElement('div');
    header.className = GasFolders.FOLDER_HEADER_CLASS;

    const chevron = document.createElement('span');
    chevron.className = GasFolders.FOLDER_CHEVRON_CLASS;
    DomUtils.setHTML(chevron, GasFolders.SVG_CHEVRON);

    const iconWrapper = document.createElement('span');
    iconWrapper.className = GasFolders.FOLDER_ICON_WRAPPER;
    DomUtils.setHTML(iconWrapper, GasFolders.SVG_FOLDER_OPEN);

    const label = document.createElement('span');
    DomUtils.setHTML(label, name);
    label.style.flex = '1';

    header.appendChild(chevron);
    header.appendChild(iconWrapper);
    header.appendChild(label);

    const children = document.createElement('div');
    children.className = GasFolders.FOLDER_CHILDREN_CLASS;

    header.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const collapsed = li.classList.toggle(GasFolders.COLLAPSED_CLASS);
      DomUtils.setHTML(iconWrapper, collapsed ? GasFolders.SVG_FOLDER : GasFolders.SVG_FOLDER_OPEN);
    };

    li.appendChild(header);
    li.appendChild(children);
    return li;
  }

  /**
   * Actualiza `data-name` y `aria-label` del item para que el pseudo
   * elemento `::before` muestre el nombre corto. No toca textContent
   * para no provocar mutaciones que GAS reconciliaría en bucle.
   * @param {HTMLLIElement} item
   * @param {string} shortName
   * @private
   */
  _updateItemLabel(item, shortName) {
    const titleDiv = item.querySelector('div[title]');
    if (titleDiv) {
      const isRenaming = !!item.querySelector('input');
      const previous = titleDiv.getAttribute('data-name') || '';
      let nextName = shortName;
      if (!nextName) {
        nextName = previous || (titleDiv.textContent || '').trim();
      }
      if (nextName && previous !== nextName) {
        titleDiv.setAttribute('data-name', nextName);
      }
      item.classList.toggle('qc-renaming', isRenaming);
    }
    const ariaLabel = item.getAttribute('aria-label');
    if (ariaLabel && shortName && ariaLabel !== shortName) {
      item.setAttribute('aria-label', shortName);
    }
  }

  /**
   * Mantiene actualizada la clase `qc-renaming` y reposiciona
   * `data-name` por si GAS reemplazó el subárbol durante el rename.
   * @param {MutationRecord[]} mutations
   * @private
   */
  _syncRenamingState_(mutations) {
    const seen = new Set();
    for (const m of mutations) {
      const target = /** @type {Element} */ (m.target);
      const li = target?.closest?.('li[role="option"]');
      if (!li || seen.has(li)) continue;
      seen.add(li);

      const renaming = !!li.querySelector('input');
      if (li.classList.contains('qc-renaming') !== renaming) {
        li.classList.toggle('qc-renaming', renaming);
      }

      const titleDiv = li.querySelector('div[title]');
      if (titleDiv) {
        const current = titleDiv.getAttribute('data-name') || '';
        if (!current) {
          const fullPath = titleDiv.getAttribute('title') || '';
          const fallback = fullPath
            ? (fullPath.includes('/') ? fullPath.split('/').pop() : fullPath)
            : (titleDiv.textContent || '').trim();
          if (fallback) titleDiv.setAttribute('data-name', fallback);
        }
      }
    }
  }

  /**
   * `true` si algún item del árbol tiene un `<input>` de rename activo.
   * @returns {boolean}
   * @private
   */
  _isAnyItemRenaming_() {
    if (!this._rootLists?.length) return false;
    return this._rootLists.some((ul) =>
      ul.querySelector('li[role="option"] input'),
    );
  }

  /**
   * Devuelve el SVG del icono según extensión.
   * @param {string} fileName
   * @returns {string}
   * @private
   */
  _getFileIcon(fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    if (ext === 'gs')   return this._renderFileSvg_('gs');
    if (ext === 'html') return this._renderFileSvg_('html');
    if (ext === 'json') return this._renderFileSvg_('json');
    return this._renderFileSvg_('generic');
  }

  /**
   * Construye el SVG del icono para un tipo concreto leyendo el color
   * actual de `_fileColors` en cada llamada.
   * @param {'gs'|'html'|'json'|'generic'} type
   * @returns {string}
   * @private
   */
  _renderFileSvg_(type) {
    const color = this._fileColors[type] || this._fileColors.generic;
    let inner;
    if (type === 'gs') {
      inner =
        `<path d="M6.4 8.5c-.55 0-.85.3-.85.85v.55c0 .35-.2.55-.55.55.35 0 .55.2.55.55v.55c0 .55.3.85.85.85" stroke="${color}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="M9.6 8.5c.55 0 .85.3.85.85v.55c0 .35.2.55.55.55-.35 0-.55.2-.55.55v.55c0 .55-.3.85-.85.85" stroke="${color}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (type === 'html') {
      inner =
        `<polyline points="6.6 8.6 4.9 10.7 6.6 12.8" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<polyline points="9.4 8.6 11.1 10.7 9.4 12.8" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (type === 'json') {
      inner =
        `<path d="M6 8.3c-.5 0-.8.3-.8.8v.6c0 .4-.2.6-.5.6.3 0 .5.2.5.6v.6c0 .5.3.8.8.8" stroke="${color}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="M10 8.3c.5 0 .8.3.8.8v.6c0 .4.2.6.5.6-.3 0-.5.2-.5.6v.6c0 .5-.3.8-.8.8" stroke="${color}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="8" cy="10.7" r=".55" fill="${color}"/>`;
    } else {
      inner =
        `<line x1="5.5" y1="8.5"  x2="10.5" y2="8.5"  stroke="${color}" stroke-width="1.1" stroke-linecap="round"/>` +
        `<line x1="5.5" y1="10.5" x2="10.5" y2="10.5" stroke="${color}" stroke-width="1.1" stroke-linecap="round"/>` +
        `<line x1="5.5" y1="12.5" x2="8.5"  y2="12.5" stroke="${color}" stroke-width="1.1" stroke-linecap="round"/>`;
    }
    return GasFolders._filePageSvg(color, inner);
  }

  /**
   * Inyecta el `<span>` con el SVG del archivo justo antes del
   * `div[title]`. Idempotente.
   * @param {HTMLLIElement} item
   * @param {string} fileName
   * @private
   */
  _injectFileIcon(item, fileName) {
    if (item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)) return;
    const wrapper = document.createElement('span');
    wrapper.className = GasFolders.FILE_ICON_CLASS;
    DomUtils.setHTML(wrapper, this._getFileIcon(fileName));
    const labelDiv = item.querySelector('div[title]');
    if (labelDiv) {
      item.insertBefore(wrapper, labelDiv);
    } else {
      item.insertBefore(wrapper, item.firstChild);
    }
  }

  /**
   * Quita carpetas vacías. Procesa de hojas a raíces invirtiendo el
   * array para que un padre quede vacío tras eliminar a sus hijos.
   * @private
   */
  _removeEmptyFolders() {
    this._rootLists.forEach(ul => {
      const folders = Array.from(ul.querySelectorAll(`.${GasFolders.FOLDER_CLASS}`));
      folders.reverse().forEach(folder => {
        const ch = folder.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
        if (ch && ch.children.length === 0) folder.remove();
      });
    });
  }

  /**
   * Restaura cada UL al estado plano original de GAS y elimina el
   * `<style>` inyectado.
   * @private
   */
  _restoreOriginalList() {
    if (!this._rootLists || this._rootLists.length === 0) return;
    this._isRebuilding = true;
    try {
      this._rootLists.forEach(ul => this._restoreList(ul));
    } finally {
      this._isRebuilding = false;
    }
    document.getElementById('gas-folders-styles')?.remove();
  }

  /**
   * Devuelve un UL concreto al estado plano: mueve los items anidados
   * de vuelta al raíz y elimina los nodos creados por el componente.
   * @param {HTMLUListElement} ul
   * @private
   */
  _restoreList(ul) {
    Array.from(
      ul.querySelectorAll(`.${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"]`)
    ).forEach(item => ul.appendChild(item));
    Array.from(ul.querySelectorAll(`.${GasFolders.FOLDER_CLASS}`))
      .forEach(f => f.remove());
    Array.from(ul.querySelectorAll('li[role="option"]')).forEach(item => {
      item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)?.remove();
    });
  }
}

;(function () {
  const folders = new GasFolders();
  if (typeof window !== 'undefined') window.gasFolders = folders;

  let initialConfigApplied = false;

  // Configuración inicial. El guard evita que navegaciones SPA pisen
  // los cambios que el usuario ya hizo en runtime.
  document.addEventListener('GAS_TransferData', (e) => {
    if (initialConfigApplied) return;
    initialConfigApplied = true;
    try {
      const data     = JSON.parse(e.detail);
      const settings = data.settings || {};
      if (settings['gas-folders']) {
        if (settings['gas-folders-color']) {
          folders.setColor(settings['gas-folders-color']);
        }
        folders.setFileColors({
          gs:   settings['gas-file-gs-color'],
          html: settings['gas-file-html-color'],
          json: settings['gas-file-json-color'],
        });
        folders.enable();
      }
    } catch (err) {
      console.warn('[GasFolders] Error en GAS_TransferData:', err);
    }
  });

  // Cambios live desde el popup.
  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('gas-folders' in options) {
        options['gas-folders'] ? folders.enable() : folders.disable();
      }
      if ('gas-folders-color' in options) {
        folders.setColor(options['gas-folders-color']);
        if (folders._enabled && folders._rootLists?.length) {
          if (folders._rebuildTimeout) clearTimeout(folders._rebuildTimeout);
          folders._rebuildTimeout = setTimeout(() => folders._rebuildFullTree(), 50);
        }
      }
      if (
        'gas-file-gs-color'   in options ||
        'gas-file-html-color' in options ||
        'gas-file-json-color' in options
      ) {
        folders.setFileColors({
          gs:   options['gas-file-gs-color'],
          html: options['gas-file-html-color'],
          json: options['gas-file-json-color'],
        });
      }
      if ('global-enable' in options && !options['global-enable']) {
        folders.disable();
      }
    } catch (err) {
      console.warn('[GasFolders] Error en GAS_SettingsUpdated:', err);
    }
  });

  document.addEventListener('GAS_GlobalDisable', () => {
    folders.disable();
  });
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasFolders };
} else {
  window.GasFolders = GasFolders;
}
