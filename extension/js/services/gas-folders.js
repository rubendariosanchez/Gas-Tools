"use strict";
/**
 * @fileoverview gas-folders.js
 *
 * Implementa una estructura de carpetas nativa (Material Design) con visualización de árbol punteada.
 * Gestiona actualizaciones dinámicas por creación, eliminación o renombrado de archivos.
 * Íconos de archivo diferenciados por extensión: .gs, .html, .json y genérico.
 */
class GasFolders {
  static FOLDER_CLASS          = 'qc__folder-item';
  static FOLDER_HEADER_CLASS   = 'qc__folder-header';
  static FOLDER_CHILDREN_CLASS = 'qc__folder-children';
  static FOLDER_ICON_WRAPPER   = 'qc__folder-icon-wrapper';
  static FOLDER_CHEVRON_CLASS  = 'qc__folder-chevron';
  static COLLAPSED_CLASS       = 'qc__folder-collapsed';
  static FILE_ICON_CLASS       = 'qc__file-icon';

  // ── Íconos de carpeta (Material Design) ──────────────────────────────────
  static SVG_CHEVRON     = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 17l5-5-5-5v10z"/></svg>`;
  static SVG_FOLDER      = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  static SVG_FOLDER_OPEN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;

  /** .gs → llaves {} en naranja Apps Script */
  static SVG_FILE_GS = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9H3z" stroke="#f4a225" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#f4a225" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><text x="8" y="11.5" text-anchor="middle" font-family="monospace" font-size="6" font-weight="700" fill="#f4a225">{}</text></svg>`;

  /** .html → chevrones &lt;&gt; en azul Google */
  static SVG_FILE_HTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9H3z" stroke="#4285f4" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#4285f4" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 9 4 10.5 5.5 12M10.5 9 12 10.5 10.5 12" stroke="#4285f4" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  /** .json → llaves partidas con punto central en verde Google */
  static SVG_FILE_JSON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9H3z" stroke="#34a853" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#34a853" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 8.2c-.4 0-.7-.2-.7-.5V7c0-.5-.3-.8-.8-.8M9.5 8.2c.4 0 .7-.2.7-.5V7c0-.5.3-.8.8-.8" stroke="#34a853" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="10.5" r=".7" fill="#34a853"/></svg>`;

  /** Genérico → líneas de texto en gris neutro */
  static SVG_FILE_GENERIC = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9H3z" stroke="#9aa0a6" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#9aa0a6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="5.5" y1="8" x2="10.5" y2="8" stroke="#9aa0a6" stroke-width="1.1" stroke-linecap="round"/><line x1="5.5" y1="10" x2="10.5" y2="10" stroke="#9aa0a6" stroke-width="1.1" stroke-linecap="round"/><line x1="5.5" y1="12" x2="8.5" y2="12" stroke="#9aa0a6" stroke-width="1.1" stroke-linecap="round"/></svg>`;

  /**
   * Mapa extensión → SVG de ícono de archivo.
   * Se consulta en {@link _getFileIcon}.
   * @type {Object.<string, string>}
   */
  static FILE_ICONS = {
    gs:   GasFolders.SVG_FILE_GS,
    html: GasFolders.SVG_FILE_HTML,
    json: GasFolders.SVG_FILE_JSON,
  };

  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Inicializa el estado interno de la instancia.
   * Todos los valores parten desactivados hasta llamar a {@link enable}.
   */
  constructor() {
    this._enabled        = false;    // Indica si el componente está activo
    this._observer       = null;     // MutationObserver que vigila el DOM
    this._rootList       = null;     // Referencia al <ul role="listbox"> raíz
    this._isRebuilding   = false;    // Bandera para evitar ciclos de reconstrucción
    this._rebuildTimeout = null;     // ID del temporizador de debounce
    this._folderColor    = '#5f6368';// Color por defecto de los íconos de carpeta
  }

  /**
   * Cambia el color de los íconos de carpeta y actualiza los estilos si está activo.
   * @param {string} color - Valor CSS válido (hex, rgb, nombre, etc.).
   */
  setColor(color) {
    if (!color) return;
    this._folderColor = color;
    if (this._enabled) this._updateStyles_();
  }

  /**
   * Activa la vista de árbol: inyecta estilos, inicia la observación del DOM
   * y construye el árbol por primera vez.
   */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._injectStyles();
    this._startObserving();
    this._rebuildFullTree();
  }

  /**
   * Desactiva la vista de árbol, detiene el observer y restaura la lista original.
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    if (this._observer) this._observer.disconnect();
    if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
    this._restoreOriginalList();
  }

  // ── Detección del tema del IDE ────────────────────────────────────────────
  /**
   * Determina si el editor de Google Apps Script está en modo oscuro.
   *
   * GAS NO usa `prefers-color-scheme`; tiene su propio sistema de temas.
   * Se inspecciona la luminancia del fondo del <body> para decidirlo.
   *
   * @returns {boolean} `true` si el IDE usa un tema oscuro.
   * @private
   */
  _isEditorDark_() {
    // Atajo rápido: clase que GAS puede aplicar al <body> en modo oscuro
    if (document.body.classList.contains('ide-dark-mode')) return true;
    // Fallback: luminancia percibida del fondo (WCAG 2.0)
    const bg  = window.getComputedStyle(document.body).backgroundColor;
    const rgb = bg.match(/\d+/g);
    if (!rgb || rgb.length < 3) return false;
    const [r, g, b] = rgb.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
  }

  // ── Estilos ───────────────────────────────────────────────────────────────
  /** Punto de entrada para la inyección inicial de estilos. @private */
  _injectStyles() { this._updateStyles_(); }

  /**
   * Crea o actualiza `<style id="gas-folders-styles">` con todos los estilos
   * del componente.
   *
   * Puntos clave:
   * • El ícono nativo de GAS se oculta con `visibility:hidden + width:0` para
   *   que el nuestro sea el único visible sin romper el layout interno de GAS.
   * • `--qc-tree-line` se fija según el tema detectado en _isEditorDark_(),
   *   sin depender de media queries (que no reflejan el tema propio de GAS).
   * • Las líneas del árbol usan top/height de 18px (mitad de las filas de 36px).
   *
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

      /* ── Ocultar ícono nativo de GAS ─────────────────────────────────────────
         GAS renderiza su propio ícono (SVG o IMG) dentro de cada <li role="option">.
         Se oculta con visibility:hidden y width:0 para que el ícono tipado que
         inyectamos sea el único visible, sin eliminar el nodo y sin romper el
         layout interno de GAS.
         Nota: el selector :not(.qc__file-icon *) evita ocultar el SVG que
         nosotros mismos inyectamos dentro del wrapper .qc__file-icon.           */
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

      /* ── Ítem de carpeta ─────────────────────────────────────────────────── */
      .${GasFolders.FOLDER_CLASS} {
        list-style : none       !important;
        margin     : 0          !important;
        padding    : 0          !important;
        z-index    : 0          !important;
        width      : 100%       !important;
        position   : relative   !important;
        background : transparent !important;
      }

      /* ── Cabecera de carpeta ─────────────────────────────────────────────── */
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
        min-height      : 36px;   /* igual a la altura real de los <li> de GAS */
      }
      .${GasFolders.FOLDER_HEADER_CLASS}:hover {
        background-color: var(--gm3-sys-color-surface-container-high, rgba(60,64,67,.08));
      }

      /* ── Contenedor de hijos ─────────────────────────────────────────────── */
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

      /* ── Hijos del contenedor ────────────────────────────────────────────── */
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li {
        position   : relative    !important;
        list-style : none        !important;
        min-height : 36px        !important;   /* alineado con filas reales de GAS */
        display    : block       !important;
        background : transparent !important;
      }

      /* Línea vertical punteada que conecta todos los hijos */
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
      /* El último hijo termina la vertical en el centro de su fila (18 = 36/2) */
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li:last-child::before {
        height : 18px;
        bottom : auto;
      }

      /* Línea horizontal punteada: top = 18px = centro de una fila de 36px */
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

      /* ── Chevron ─────────────────────────────────────────────────────────── */
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

      /* ── Ícono de carpeta ────────────────────────────────────────────────── */
      .${GasFolders.FOLDER_ICON_WRAPPER} {
        margin-right    : 8px;
        display         : flex;
        align-items     : center;
        justify-content : center;
        color           : var(--qc-folder-color);
      }

      /* ── Ícono de archivo tipado ─────────────────────────────────────────── */
      .${GasFolders.FILE_ICON_CLASS} {
        margin-right    : 6px;
        display         : flex;
        align-items     : center;
        justify-content : center;
        flex-shrink     : 0;
        visibility      : visible !important;   /* anula cualquier herencia de ocultación */
      }
      /* Garantiza que el SVG interno del ícono tipado sea siempre visible */
      .${GasFolders.FILE_ICON_CLASS} svg,
      .${GasFolders.FILE_ICON_CLASS} img {
        visibility : visible !important;
        width      : 16px    !important;
        height     : 16px    !important;
      }

      /* ── Ítems de archivo nativos dentro de carpetas ─────────────────────── */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] {
        padding-left : 4px          !important;
        margin       : 0            !important;
        background   : transparent  !important;
        border       : none         !important;
        display      : flex         !important;
        align-items  : center       !important;
        z-index      : 2;
        min-height   : 36px         !important;
      }
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"]:hover {
        background: var(--gm3-sys-color-surface-container-high, rgba(60,64,67,.08)) !important;
      }
    `;
  }

  // ── Observación del DOM ───────────────────────────────────────────────────
  /**
   * Localiza el `<ul role="listbox">` raíz y arranca el {@link MutationObserver}.
   * Si aún no existe en el DOM, reintenta cada 1 segundo.
   * @private
   */
  _startObserving() {
    this._rootList = document.querySelector('ul[role="listbox"]');
    if (!this._rootList) {
      setTimeout(() => this._startObserving(), 1000);
      return;
    }

    this._observer = new MutationObserver((mutations) => {
      if (this._isRebuilding) return;

      // Cambio de tema del IDE → regenera los estilos al instante
      const themeChanged = mutations.some(
        m => m.target === document.body && m.attributeName === 'class'
      );
      if (themeChanged) this._updateStyles_();

      // Cambios estructurales → reconstruye el árbol con debounce de 100ms
      const needsUpdate = mutations.some(m =>
        m.type === 'childList' ||
        (m.type === 'attributes' && m.attributeName === 'title')
      );
      if (needsUpdate) {
        if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
        this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 100);
      }
    });

    this._observer.observe(this._rootList, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['title']
    });
    // Vigila cambios de clase en <body> para detectar cambio de tema del IDE
    this._observer.observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });
  }

  // ── Construcción del árbol ────────────────────────────────────────────────
  /**
   * Recorre todos los `<li role="option">` y los reubica en la carpeta correcta
   * según la ruta contenida en su atributo `title` (separador `/`).
   * Inyecta el ícono de archivo según la extensión al colocar cada ítem.
   * Los archivos sin `/` permanecen en la raíz.
   * @private
   */
  _rebuildFullTree() {
    if (!this._rootList || this._isRebuilding) return;
    this._isRebuilding = true;
    try {
      const items = Array.from(this._rootList.querySelectorAll('li[role="option"]'))
        .filter(li => !li.classList.contains(GasFolders.FOLDER_CLASS));

      items.forEach(item => {
        const titleDiv = item.querySelector('div[title]');
        if (!titleDiv) return;
        const fullPath = titleDiv.getAttribute('title');

        if (!fullPath || !fullPath.includes('/')) {
          // Archivo en raíz: permanece ahí, solo inyectar ícono si falta
          if (item.parentElement !== this._rootList) {
            this._rootList.appendChild(item);
            this._updateItemLabel(item, fullPath);
          }
          this._injectFileIcon(item, fullPath);
          return;
        }

        // Archivo con ruta de carpeta: mover a la carpeta correspondiente
        const parts      = fullPath.split('/');
        const fileName   = parts.pop();
        const folderPath = parts.join('/');
        const folderItem        = this._getOrCreateFolder(folderPath);
        const childrenContainer = folderItem.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
        if (item.parentElement !== childrenContainer) {
          childrenContainer.appendChild(item);
          this._updateItemLabel(item, fileName);
        }
        this._injectFileIcon(item, fileName);
      });

      this._removeEmptyFolders();
    } finally {
      this._isRebuilding = false;
    }
  }

  /**
   * Devuelve el `<li>` de carpeta para `path`, creándolo junto con sus
   * ancestros si aún no existe.
   * @param {string} path - Ruta relativa separada por `/`, ej. `"TT1/rr2r"`.
   * @returns {HTMLLIElement}
   * @private
   */
  _getOrCreateFolder(path) {
    const parts = path.split('/');
    let currentParent = this._rootList;
    let currentPath   = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folderId = `qc-fld-${currentPath.replace(/[^a-zA-Z0-9]/g, '-')}`;
      let folderItem = document.getElementById(folderId);
      if (!folderItem) {
        folderItem = this._createFolderItem(part, folderId);
        currentParent.appendChild(folderItem);
      }
      currentParent = folderItem.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
    }
    return document.getElementById(`qc-fld-${path.replace(/[^a-zA-Z0-9]/g, '-')}`);
  }

  /**
   * Crea el marcado HTML completo de un ítem de carpeta:
   * chevron + ícono + etiqueta + contenedor de hijos.
   * @param {string} name - Nombre visible de la carpeta.
   * @param {string} id   - ID único del `<li>`.
   * @returns {HTMLLIElement}
   * @private
   */
  _createFolderItem(name, id) {
    const li = document.createElement('li');
    li.id        = id;
    li.className = GasFolders.FOLDER_CLASS;

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

    // Toggle colapso: alterna clase y cambia ícono carpeta abierta/cerrada
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

  // ── Utilidades de ítems de archivo ────────────────────────────────────────
  /**
   * Reemplaza el texto visible de un ítem por el nombre corto del archivo,
   * eliminando la ruta completa que originalmente muestra GAS.
   * @param {HTMLLIElement} item
   * @param {string}        shortName
   * @private
   */
  _updateItemLabel(item, shortName) {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent.includes('/') || node.textContent === shortName) {
        node.textContent = shortName;
        break;
      }
    }
  }

  /**
   * Devuelve el SVG de ícono para la extensión del archivo.
   * @param {string} fileName
   * @returns {string} Markup SVG.
   * @private
   */
  _getFileIcon(fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    return GasFolders.FILE_ICONS[ext] || GasFolders.SVG_FILE_GENERIC;
  }

  /**
   * Inyecta el ícono tipado en el `<li>` del archivo.
   *
   * CORRECCIÓN v3: GAS tiene su propio ícono en el <li> (primer hijo o dentro
   * del primer <span>). Ese ícono se oculta con CSS (ver _updateStyles_).
   * El ícono tipado se inserta JUSTO ANTES del div[title] que contiene el nombre
   * del archivo, para quedar en la posición visual correcta sin colisionar con el
   * ícono nativo.
   *
   * @param {HTMLLIElement} item
   * @param {string}        fileName
   * @private
   */
  _injectFileIcon(item, fileName) {
    // Evitar duplicados en reconstrucciones sucesivas
    if (item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)) return;

    const wrapper = document.createElement('span');
    wrapper.className = GasFolders.FILE_ICON_CLASS;
    DomUtils.setHTML(wrapper, this._getFileIcon(fileName));

    // Insertar justo antes del div[title] que contiene el texto del nombre
    const labelDiv = item.querySelector('div[title]');
    if (labelDiv) {
      item.insertBefore(wrapper, labelDiv);
    } else {
      // Fallback: al inicio del ítem si no se encuentra el div[title]
      item.insertBefore(wrapper, item.firstChild);
    }
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────
  /**
   * Elimina carpetas vacías del DOM, procesando de adentro hacia afuera.
   * @private
   */
  _removeEmptyFolders() {
    const folders = Array.from(document.querySelectorAll(`.${GasFolders.FOLDER_CLASS}`));
    folders.reverse().forEach(folder => {
      const ch = folder.querySelector(`.${GasFolders.FOLDER_CHILDREN_CLASS}`);
      if (ch && ch.children.length === 0) folder.remove();
    });
  }

  /**
   * Deshace completamente la vista de árbol y devuelve el DOM a su estado original.
   *
   * Orden de operaciones:
   * 1. Mueve los archivos de carpetas a la raíz y restaura sus labels.
   * 2. Elimina los nodos de carpeta artificiales.
   * 3. Elimina todos los íconos inyectados (también los de ítems en raíz).
   * 4. Borra la hoja de estilos → el ícono nativo de GAS vuelve a ser visible.
   *
   * @private
   */
  _restoreOriginalList() {
    if (!this._rootList) return;
    this._isRebuilding = true;
    try {
      // Paso 1: sacar archivos de carpetas y restaurar labels con ruta completa
      Array.from(
        document.querySelectorAll(`.${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"]`)
      ).forEach(item => {
        const titleDiv = item.querySelector('div[title]');
        if (titleDiv) this._updateItemLabel(item, titleDiv.getAttribute('title'));
        this._rootList.appendChild(item);
      });

      // Paso 2: eliminar nodos de carpeta artificiales
      Array.from(this._rootList.querySelectorAll(`.${GasFolders.FOLDER_CLASS}`))
        .forEach(f => f.remove());

      // Paso 3: eliminar íconos tipados de todos los ítems (incluyendo los de raíz)
      Array.from(this._rootList.querySelectorAll('li[role="option"]')).forEach(item => {
        item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)?.remove();
      });
    } finally {
      this._isRebuilding = false;
    }

    // Paso 4: eliminar estilos → el ícono nativo de GAS vuelve a ser visible
    document.getElementById('gas-folders-styles')?.remove();
  }
}

// ── Exportación compatible con CommonJS y entornos de navegador ──────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasFolders };
} else {
  window.GasFolders = GasFolders;
}