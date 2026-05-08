/**
 * GasFileTreePanel — Web Component
 * ─────────────────────────────────────────────────────────────────────────────
 * Panel flotante con árbol de carpetas/subcarpetas construido a partir de los
 * modelos Monaco abiertos en el IDE de Google Apps Script.
 *
 * CONVENCIÓN DE NOMBRES (compatible con appsScriptColor y clasp):
 *   Un archivo llamado  "utils/helpers/dateUtils"  se interpreta como:
 *     carpeta "utils" → subcarpeta "helpers" → archivo "dateUtils"
 *
 * INTEGRACIÓN EN gasTools.js:
 *   const treePanel = document.createElement('gas-file-tree-panel');
 *   document.body.appendChild(treePanel);
 *   treePanel.setEditor(monacoEditorInstance);
 *
 *   // Abrir/cerrar:
 *   treePanel.open();
 *   treePanel.close();
 *   treePanel.toggle();
 *
 *   // Cuando el editor cambie de modelo activo, notificar:
 *   treePanel.setActiveModel(model);
 *
 *   // Para soporte dark mode:
 *   treePanel.setAttribute('theme', 'dark');
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Tabla de iconos SVG inline por extensión ─────────────────────────────────
// Cada icono es un SVG de 14×14 px embebido como data-URI para evitar
// cualquier dependencia de red o librería externa.
const GFT_ICONS = {
  // ── Lenguajes ──
  gs: {
    color: '#f4b400',
    label: 'Apps Script',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#f4b400" opacity=".18"/>
      <path d="M7 3.5C5.067 3.5 3.5 5.067 3.5 7s1.567 3.5 3.5 3.5c.966 0 1.5-.336 1.5-.336V8.5H7V7h3v3.5S9.2 11 7 11c-2.21 0-4-1.79-4-4s1.79-4 4-4c1.105 0 2.1.448 2.828 1.172L8.414 5.586A2.485 2.485 0 007 5c-1.105 0-2 .895-2 2s.895 2 2 2" fill="#f4b400"/>
    </svg>`,
  },
  js: {
    color: '#f7df1e',
    label: 'JavaScript',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#f7df1e" opacity=".2"/>
      <text x="2.5" y="10.5" font-family="monospace" font-size="7" font-weight="700" fill="#b8a800">JS</text>
    </svg>`,
  },
  ts: {
    color: '#3178c6',
    label: 'TypeScript',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#3178c6" opacity=".2"/>
      <text x="2" y="10.5" font-family="monospace" font-size="7" font-weight="700" fill="#3178c6">TS</text>
    </svg>`,
  },
  html: {
    color: '#e8501e',
    label: 'HTML',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#e8501e" opacity=".15"/>
      <path d="M3 4l1 6 3 1 3-1 1-6H3zm7.5 2H5l.1 1.5h5.2l-.3 2.5L7 11l-2.5-.7-.2-1.8h1.4l.1 1 1.2.3 1.2-.3.15-1.7H4.9L4.5 6H9.6l-.1-1.5H4.4L4.3 3h6.4l-.5 3.5-.7-.5z" fill="#e8501e"/>
    </svg>`,
  },
  css: {
    color: '#264de4',
    label: 'CSS',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#264de4" opacity=".15"/>
      <text x="2" y="10.5" font-family="monospace" font-size="6" font-weight="700" fill="#264de4">CSS</text>
    </svg>`,
  },
  json: {
    color: '#6aaf6a',
    label: 'JSON',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#6aaf6a" opacity=".15"/>
      <path d="M4.5 5C4.5 4.17 4 3.5 3 3.5v1c.5 0 .5.3.5.5v1c0 .55.22.85.5 1-.28.15-.5.45-.5 1v1c0 .2 0 .5-.5.5v1c1 0 1.5-.67 1.5-1.5v-1c0-.35.15-.5.5-.5V8c-.35 0-.5-.15-.5-.5V6c0-.35.15-.5.5-.5V5zM10.5 5v.5c-.35 0-.5.15-.5.5v1c0 .35-.15.5-.5.5v1c.35 0 .5.15.5.5v1c0 .83.5 1.5 1.5 1.5v-1c-.5 0-.5-.3-.5-.5v-1c0-.55-.22-.85-.5-1 .28-.15.5-.45.5-1V6c0-.2 0-.5.5-.5V5C10.5 5 10.5 5 10.5 5z" fill="#6aaf6a"/>
    </svg>`,
  },
  md: {
    color: '#7b8a97',
    label: 'Markdown',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="12" height="12" rx="2" fill="#7b8a97" opacity=".15"/>
      <path d="M2 4.5h1.5L5 7.5l1.5-3H8v5H6.5V6.5L5 9H4L2.5 6.5V9.5H1V4.5H2zM9 8l1.5-1.5V9.5h1.5V4.5l-3 3.5H9z" fill="#7b8a97"/>
    </svg>`,
  },
  // ── Default ──
  _default: {
    color: '#9aa0a6',
    label: 'File',
    svg: `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2h5.5L11 4.5V12H3V2z" stroke="#9aa0a6" stroke-width="1" fill="none"/>
      <path d="M8.5 2v2.5H11" stroke="#9aa0a6" stroke-width="1" fill="none"/>
    </svg>`,
  },
};

// Icono de carpeta (abierta / cerrada)
const GFT_FOLDER_SVG = (open) => `<svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  ${open
    ? `<path d="M1 4.5h12l-1.5 6H2L1 4.5z" fill="#e8a830" opacity=".25"/>
       <path d="M1 4.5h12l-1.5 6H2L1 4.5z" stroke="#e8a830" stroke-width=".8"/>
       <path d="M1 4.5V3h3.5l1 1.5H1z" fill="#e8a830" stroke="#e8a830" stroke-width=".8"/>`
    : `<path d="M1 3h3.5l1 1.5H13v6H1V3z" fill="#e8a830" opacity=".2"/>
       <path d="M1 3h3.5l1 1.5H13v6H1V3z" stroke="#e8a830" stroke-width=".8"/>`
  }
</svg>`;

/**
 * Convierte un SVG string en un data-URI usable como src de imagen o en CSS.
 * @param {string} svgStr
 * @returns {string}
 */
function gftSvgToUri(svgStr) {
  return `data:image/svg+xml;base64,${btoa(svgStr)}`;
}

/**
 * Obtiene el descriptor de icono para un nombre de archivo dado.
 * @param {string} filename
 * @returns {{ color:string, label:string, svg:string }}
 */
function gftGetIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return GFT_ICONS[ext] ?? GFT_ICONS._default;
}

// ─────────────────────────────────────────────────────────────────────────────

class GasFileTreePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** @type {object|null} Instancia Monaco activa */
    this._editor = null;
    /** @type {object|null} Modelo Monaco actualmente activo en el editor */
    this._activeModel = null;
    /** @type {Set<string>} Rutas de carpetas colapsadas por el usuario */
    this._collapsedPaths = new Set();
    /** @type {{offsetX:number,offsetY:number}|null} */
    this._dragState = null;
    /** @type {boolean} */
    this._positionInitialized = false;

    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onDragMove          = this._onDragMove.bind(this);
    this._onDragEnd           = this._onDragEnd.bind(this);
  }

  connectedCallback() {
    this._render();
    this._setupListeners();
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this._onWindowKeyDown);
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  /** @param {object|null} editor */
  setEditor(editor) {
    this._editor = editor || null;
  }

  /**
   * Notifica al panel cuál es el modelo activo actualmente.
   * Actualiza el resaltado del archivo seleccionado sin reconstruir el árbol.
   * @param {object|null} model
   */
  setActiveModel(model) {
    this._activeModel = model || null;
    this._highlightActiveFile();
  }

  /** Abre el panel y reconstruye el árbol desde los modelos Monaco. */
  open() {
    this.style.display       = 'block';
    this.style.pointerEvents = 'auto';
    this._repositionPanel(true);
    this._buildAndRender();
  }

  close() {
    this.style.display       = 'none';
    this.style.pointerEvents = 'none';
  }

  toggle() {
    if (this.style.display === 'block') {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Fuerza una reconstrucción completa del árbol.
   * Útil si se añadieron/eliminaron archivos desde que el panel se abrió.
   */
  refresh() {
    if (this.style.display === 'block') {
      this._buildAndRender();
    }
  }

  // ── Render principal ────────────────────────────────────────────────────────

  _render() {
    DomUtils.setHTML(this.shadowRoot, `
      <style>
        /* ── Fuente monoespaciada refinada para el árbol ── */
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');

        :host {
          display: none;
          pointer-events: none;
          position: fixed;
          top: 102px;
          left: 14px;
          right: auto;
          z-index: 2147483639;
          width: 260px;
          min-width: 180px;
          max-width: 420px;
          height: min(560px, calc(100vh - 120px));
          min-height: 200px;
          max-height: calc(100vh - 84px);
          background: #1e1f22;
          color: #cdd6f4;
          border: 1px solid #313244;
          border-radius: 10px;
          box-shadow:
            0 0 0 1px rgba(205,214,244,.04),
            0 12px 40px rgba(0,0,0,.55),
            0 2px 8px rgba(0,0,0,.35);
          font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
          overflow: hidden;
          animation: gft__in .18s cubic-bezier(.16,1,.3,1);
        }

        @keyframes gft__in {
          from { opacity: 0; transform: translateX(-10px) scale(.98); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }

        /* Light theme */
        :host([theme="light"]) {
          background: #f8f9fa;
          color: #202124;
          border-color: #dadce0;
          box-shadow: 0 10px 38px rgba(60,64,67,.22), 0 2px 8px rgba(60,64,67,.14);
        }

        /* ── Shell ── */
        .gft__shell {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        /* ── Header ── */
        .gft__header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 10px 8px;
          cursor: move;
          user-select: none;
          border-bottom: 1px solid #313244;
          background: #181825;
          flex: 0 0 auto;
        }
        :host([theme="light"]) .gft__header {
          background: linear-gradient(to bottom, #f1f3f4, #eef0f1);
          border-bottom-color: #e0e2e5;
        }

        .gft__headerIcon {
          font-size: 13px;
          flex: 0 0 auto;
          line-height: 1;
        }

        .gft__title {
          flex: 1;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: .08em;
          text-transform: uppercase;
          color: #6c7086;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        :host([theme="light"]) .gft__title { color: #80868b; }

        .gft__headerActions {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .gft__iconBtn {
          border: none;
          background: transparent;
          color: #6c7086;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          cursor: pointer;
          display: grid;
          place-items: center;
          font-size: 14px;
          line-height: 1;
          transition: background .12s, color .12s;
          flex: 0 0 auto;
        }
        .gft__iconBtn:hover {
          background: rgba(205,214,244,.1);
          color: #cdd6f4;
        }
        :host([theme="light"]) .gft__iconBtn { color: #80868b; }
        :host([theme="light"]) .gft__iconBtn:hover {
          background: rgba(60,64,67,.1);
          color: #202124;
        }

        /* ── Barra de stats ── */
        .gft__stats {
          padding: 5px 10px;
          font-size: 9.5px;
          color: #45475a;
          border-bottom: 1px solid #1e1f22;
          background: #181825;
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        :host([theme="light"]) .gft__stats {
          background: #f1f3f4;
          border-bottom-color: #e0e2e5;
          color: #9aa0a6;
        }

        .gft__statPill {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 5px;
          border-radius: 6px;
          background: rgba(205,214,244,.06);
          color: #6c7086;
          font-size: 9px;
        }
        .gft__statPill b { color: #89b4fa; font-weight: 600; }
        :host([theme="light"]) .gft__statPill b { color: #1a73e8; }

        /* ── Árbol ── */
        .gft__treeScroll {
          flex: 1;
          overflow: auto;
          padding: 6px 0;
          scrollbar-width: thin;
          scrollbar-color: #313244 transparent;
        }
        .gft__treeScroll::-webkit-scrollbar { width: 4px; }
        .gft__treeScroll::-webkit-scrollbar-thumb {
          background: #313244;
          border-radius: 2px;
        }

        /* ── Nodo genérico ── */
        .gft__node {
          display: flex;
          align-items: center;
          gap: 0;
          height: 24px;
          cursor: pointer;
          position: relative;
          user-select: none;
          border-radius: 4px;
          margin: 0 5px 1px;
          padding-right: 6px;
          transition: background .1s;
        }
        .gft__node:hover { background: rgba(205,214,244,.07); }
        .gft__node:hover .gft__guideLine { opacity: 1; }

        /* Archivo activo */
        .gft__node.gft__nodeActive {
          background: rgba(137,180,250,.15);
        }
        .gft__node.gft__nodeActive .gft__label {
          color: #89b4fa;
          font-weight: 500;
        }
        :host([theme="light"]) .gft__node.gft__nodeActive {
          background: rgba(26,115,232,.1);
        }
        :host([theme="light"]) .gft__node.gft__nodeActive .gft__label {
          color: #1a73e8;
        }

        /* ── Líneas guía del árbol ── */
        .gft__indent {
          display: flex;
          align-items: stretch;
          flex: 0 0 auto;
        }
        .gft__guideLine {
          width: 16px;
          position: relative;
          flex: 0 0 16px;
          opacity: .35;
          transition: opacity .15s;
        }
        /* Línea vertical continua */
        .gft__guideLine::before {
          content: '';
          position: absolute;
          left: 7px;
          top: 0;
          bottom: 0;
          width: 1px;
          background: #45475a;
        }
        :host([theme="light"]) .gft__guideLine::before { background: #dadce0; }

        /* Línea horizontal hacia el nodo (solo en el último nivel) */
        .gft__guideLine.gft__guideLeaf::after {
          content: '';
          position: absolute;
          left: 7px;
          top: 50%;
          width: 9px;
          height: 1px;
          background: #45475a;
        }
        :host([theme="light"]) .gft__guideLine.gft__guideLeaf::after { background: #dadce0; }

        .gft__node:hover .gft__guideLine::before,
        .gft__node:hover .gft__guideLine::after { background: #585b70; }

        /* ── Toggle de carpeta ── */
        .gft__toggle {
          width: 16px;
          height: 16px;
          flex: 0 0 16px;
          display: grid;
          place-items: center;
          font-size: 8px;
          color: #6c7086;
          transition: transform .15s, color .12s;
        }
        .gft__toggle svg {
          width: 7px;
          height: 7px;
          fill: currentColor;
          transition: transform .15s;
        }
        .gft__toggle.gft__open svg { transform: rotate(90deg); }
        :host([theme="light"]) .gft__toggle { color: #9aa0a6; }

        /* Espacio reservado para alinear archivos sin toggle */
        .gft__toggleSpacer { width: 16px; flex: 0 0 16px; }

        /* ── Icono de archivo/carpeta ── */
        .gft__icon {
          width: 16px;
          height: 16px;
          flex: 0 0 16px;
          display: grid;
          place-items: center;
          margin-right: 5px;
        }
        .gft__icon img {
          width: 14px;
          height: 14px;
          display: block;
        }

        /* ── Etiqueta de texto ── */
        .gft__label {
          flex: 1;
          font-size: 11.5px;
          color: #cdd6f4;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          line-height: 24px;
          font-weight: 400;
        }
        :host([theme="light"]) .gft__label { color: #202124; }

        .gft__folderLabel {
          color: #cba6f7;
          font-weight: 500;
        }
        :host([theme="light"]) .gft__folderLabel { color: #7c4dff; }

        /* Badge de número de archivos en carpeta */
        .gft__badge {
          flex: 0 0 auto;
          font-size: 9px;
          color: #45475a;
          background: rgba(205,214,244,.06);
          border-radius: 8px;
          padding: 0 5px;
          height: 14px;
          line-height: 14px;
          margin-left: 4px;
          min-width: 16px;
          text-align: center;
        }
        :host([theme="light"]) .gft__badge { color: #9aa0a6; background: rgba(60,64,67,.07); }

        /* ── Extensión (texto pequeño junto al badge) ── */
        .gft__ext {
          font-size: 9px;
          color: #45475a;
          margin-left: 3px;
          flex: 0 0 auto;
          opacity: .7;
        }

        /* ── Estado vacío ── */
        .gft__empty {
          padding: 20px 14px;
          color: #45475a;
          font-size: 11px;
          text-align: center;
          line-height: 1.6;
        }
        .gft__emptyIcon { font-size: 22px; margin-bottom: 6px; }
        :host([theme="light"]) .gft__empty { color: #9aa0a6; }

        /* ── Tooltip nativo via title (mejorado con CSS) ── */
        .gft__node:hover::after {
          content: attr(data-fullpath);
          position: absolute;
          left: 100%;
          top: 50%;
          transform: translateY(-50%);
          margin-left: 6px;
          background: #11111b;
          border: 1px solid #313244;
          color: #cdd6f4;
          font-size: 10px;
          padding: 3px 7px;
          border-radius: 5px;
          white-space: nowrap;
          pointer-events: none;
          z-index: 10;
          opacity: 0;
          transition: opacity .15s .4s;
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        /* Solo mostrar si data-fullpath no está vacío */
        .gft__node[data-fullpath]:hover::after { opacity: 1; }

        /* ── Sección colapsada: animación de altura ── */
        .gft__children {
          overflow: hidden;
        }
        .gft__children.gft__collapsed {
          display: none;
        }

        /* ── Separador entre sección de carpetas y archivos raíz ── */
        .gft__separator {
          height: 1px;
          background: #313244;
          margin: 5px 10px;
          opacity: .5;
        }
        :host([theme="light"]) .gft__separator { background: #e0e2e5; }

        /* ── Resize handle abajo-izquierda ── */
        .gft__resizeHandle {
          position: absolute;
          left: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nesw-resize;
          background:
            linear-gradient(225deg, transparent 0 45%, rgba(205,214,244,.3) 45% 55%, transparent 55% 100%);
        }
      </style>

      <div class="gft__shell">
        <div class="gft__header">
          <span class="gft__headerIcon">🗂</span>
          <span class="gft__title">Explorer</span>
          <div class="gft__headerActions">
            <button id="gft__refreshBtn" class="gft__iconBtn" title="Refresh tree (R)">↺</button>
            <button id="gft__collapseAllBtn" class="gft__iconBtn" title="Collapse all">⊟</button>
            <button id="gft__closeBtn" class="gft__iconBtn" title="Close (Esc)">✕</button>
          </div>
        </div>
        <div id="gft__stats" class="gft__stats">
          <span class="gft__statPill">Files <b id="gft__fileCount">0</b></span>
          <span class="gft__statPill">Folders <b id="gft__folderCount">0</b></span>
        </div>
        <div id="gft__treeScroll" class="gft__treeScroll">
          <div class="gft__empty">
            <div class="gft__emptyIcon">📂</div>
            Loading files…
          </div>
        </div>
        <div id="gft__resizeHandle" class="gft__resizeHandle"></div>
      </div>
    `);
  }

  // ── Listeners ───────────────────────────────────────────────────────────────

  _setupListeners() {
    const closeBtn      = this.shadowRoot.getElementById('gft__closeBtn');
    const refreshBtn    = this.shadowRoot.getElementById('gft__refreshBtn');
    const collapseBtn   = this.shadowRoot.getElementById('gft__collapseAllBtn');
    const header        = this.shadowRoot.querySelector('.gft__header');
    const resizeHandle  = this.shadowRoot.getElementById('gft__resizeHandle');

    closeBtn?.addEventListener('click', () => this.close());

    refreshBtn?.addEventListener('click', () => this._buildAndRender());

    collapseBtn?.addEventListener('click', () => {
      // Colapsa todas las carpetas
      const allFolderPaths = this._collectAllFolderPaths(
        this._lastTree ?? { children: new Map(), files: [] }
      );
      allFolderPaths.forEach(p => this._collapsedPaths.add(p));
      this._buildAndRender();
    });

    header?.addEventListener('mousedown', (evt) => {
      if (evt.target.closest('button')) return;
      evt.preventDefault();
      this._startDrag(evt);
    });

    // Resize
    let resizeState = null;
    resizeHandle?.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const rect = this.getBoundingClientRect();
      // Anclar el lado derecho
      this.style.right = `${window.innerWidth - rect.right}px`;
      this.style.left  = 'auto';
      resizeState = {
        startX: evt.clientX,
        startY: evt.clientY,
        startW: this.offsetWidth,
        startH: this.offsetHeight,
      };
      const onMove = (e) => {
        if (!resizeState) return;
        const dX = e.clientX - resizeState.startX;
        const dY = e.clientY - resizeState.startY;
        const w  = Math.max(180, Math.min(resizeState.startW - dX, window.innerWidth - 18));
        const h  = Math.max(200, Math.min(resizeState.startH + dY, window.innerHeight - 84));
        this.style.width  = `${w}px`;
        this.style.height = `${h}px`;
      };
      const onUp = () => {
        resizeState = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    window.addEventListener('keydown', this._onWindowKeyDown);
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
  }

  _onWindowKeyDown(e) {
    if (this.style.display !== 'block') return;
    if (e.key === 'Escape') this.close();
    if (e.key === 'r' || e.key === 'R') {
      if (!e.ctrlKey && !e.metaKey) this._buildAndRender();
    }
  }

  _onDocumentMouseDown(e) {
    if (this.style.display !== 'block') return;
    if (!e.composedPath().includes(this)) this.close();
  }

  // ── Posición ────────────────────────────────────────────────────────────────

  _repositionPanel(force = false) {
    if (this._positionInitialized && !force) return;
    this.style.left      = '14px';
    this.style.right     = 'auto';
    this.style.top       = '102px';
    this.style.transform = 'none';
    this.style.width     = '';
    this.style.height    = '';
    this._positionInitialized = true;
  }

  _startDrag(evt) {
    const rect = this.getBoundingClientRect();
    this.style.left      = `${rect.left}px`;
    this.style.right     = 'auto';
    this.style.top       = `${rect.top}px`;
    this.style.transform = 'none';
    this._dragState = { offsetX: evt.clientX - rect.left, offsetY: evt.clientY - rect.top };
    window.addEventListener('mousemove', this._onDragMove);
    window.addEventListener('mouseup',   this._onDragEnd);
  }

  _onDragMove(evt) {
    if (!this._dragState) return;
    const w = this.offsetWidth  || 0;
    const h = this.offsetHeight || 0;
    this.style.left = `${Math.max(0, Math.min(evt.clientX - this._dragState.offsetX, window.innerWidth  - w))}px`;
    this.style.top  = `${Math.max(54, Math.min(evt.clientY - this._dragState.offsetY, window.innerHeight - h))}px`;
  }

  _onDragEnd() {
    this._dragState = null;
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup',   this._onDragEnd);
  }

  // ── Lógica del árbol ────────────────────────────────────────────────────────

  /**
   * Construye el árbol desde los modelos Monaco y lo renderiza.
   */
  _buildAndRender() {
    const models = window.monaco?.editor?.getModels?.() ?? [];
    const tree   = this._buildTree(models);
    this._lastTree = tree;

    const fileCount   = this._countFiles(tree);
    const folderCount = this._countFolders(tree);

    const fc = this.shadowRoot.getElementById('gft__fileCount');
    const dc = this.shadowRoot.getElementById('gft__folderCount');
    if (fc) fc.textContent = fileCount;
    if (dc) dc.textContent = folderCount;

    const container = this.shadowRoot.getElementById('gft__treeScroll');
    if (!container) return;

    if (!fileCount && !folderCount) {
      DomUtils.setHTML(container, `
        <div class="gft__empty">
          <div class="gft__emptyIcon">🗃</div>
          No files found.<br>
          <small>Open a GAS project first.</small>
        </div>
      `);
      return;
    }

    // Separar carpetas de archivos en la raíz para mostrar carpetas primero
    const html = this._renderNode(tree, 0, true);
    DomUtils.setHTML(container, html);

    // Registrar eventos de click en los nodos
    this._attachNodeEvents(container, tree);

    // Resaltar el archivo activo
    this._highlightActiveFile();
  }

  /**
   * Parsea los nombres de los modelos Monaco y construye un árbol de nodos.
   * @param {object[]} models
   * @returns {{ name:string, path:string, children:Map, files:Array }}
   */
  _buildTree(models) {
    const root = { name: '', path: '', children: new Map(), files: [] };

    models.forEach((model, index) => {
      // Intentamos obtener el nombre del archivo desde la URI del modelo.
      // La URI suele tener forma: inmemory://model/N o file:///nombre
      let rawName = '';
      try {
        const uri = model.uri;
        // Preferimos el path de la URI si contiene algo significativo
        const uriPath = uri?.path || '';
        // GAS a veces codifica el nombre real como query param o en el path
        rawName = decodeURIComponent(uriPath.split('/').pop() || `file_${index}`);
      } catch (_) {
        rawName = `file_${index}`;
      }

      // Intentar obtener nombre desde el mapa de nombres registrado externamente
      // (gasTools puede haber registrado un mapa fileName → model)
      if (rawName.startsWith('file_') || rawName === '') {
        rawName = `script_${index + 1}.gs`;
      }

      const parts = rawName.split('/').filter(Boolean);

      if (parts.length === 1) {
        root.files.push({ name: parts[0], fullPath: parts[0], model, index });
        return;
      }

      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.children.has(seg)) {
          const parentPath = node.path ? `${node.path}/${seg}` : seg;
          node.children.set(seg, {
            name    : seg,
            path    : parentPath,
            children: new Map(),
            files   : [],
          });
        }
        node = node.children.get(seg);
      }

      const fileName = parts.at(-1);
      const fullPath = parts.join('/');
      node.files.push({ name: fileName, fullPath, model, index });
    });

    return root;
  }

  /**
   * Renderiza recursivamente un nodo del árbol como HTML string.
   * @param {object}  node       - Nodo del árbol
   * @param {number}  depth      - Profundidad actual (raíz = 0)
   * @param {boolean} isRoot     - Si es la raíz no renderizamos el propio nodo
   * @returns {string}
   */
  _renderNode(node, depth, isRoot = false) {
    let html = '';

    const folders = [...node.children.values()];
    const files   = node.files;

    // Separador visual entre carpetas raíz y archivos raíz
    const needSeparator = isRoot && folders.length > 0 && files.length > 0;

    // ── Carpetas primero ──
    for (const folder of folders) {
      const isCollapsed  = this._collapsedPaths.has(folder.path);
      const childCount   = this._countFiles(folder);
      const indent       = this._renderIndent(depth, false);
      const toggleClass  = isCollapsed ? '' : 'gft__open';
      const folderIconB64 = gftSvgToUri(GFT_FOLDER_SVG(!isCollapsed));

      html += `
        <div class="gft__node gft__folderNode"
             data-path="${this._esc(folder.path)}"
             data-fullpath="${this._esc(folder.path)}">
          ${indent}
          <span class="gft__toggle ${toggleClass}">
            <svg viewBox="0 0 6 10"><path d="M1 1l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span class="gft__icon"><img src="${folderIconB64}" alt="folder"/></span>
          <span class="gft__label gft__folderLabel">${this._esc(folder.name)}</span>
          <span class="gft__badge">${childCount}</span>
        </div>
        <div class="gft__children ${isCollapsed ? 'gft__collapsed' : ''}"
             data-children-of="${this._esc(folder.path)}">
          ${this._renderNode(folder, depth + 1)}
        </div>
      `;
    }

    if (needSeparator) {
      html += `<div class="gft__separator"></div>`;
    }

    // ── Archivos ──
    for (const file of files) {
      const icon    = gftGetIcon(file.name);
      const iconB64 = gftSvgToUri(icon.svg);
      const ext     = file.name.includes('.') ? file.name.split('.').pop() : '';
      const indent  = this._renderIndent(depth, true);

      html += `
        <div class="gft__node gft__fileNode"
             data-model-index="${file.index}"
             data-fullpath="${this._esc(file.fullPath)}"
             title="${this._esc(file.fullPath)}">
          ${indent}
          <span class="gft__toggleSpacer"></span>
          <span class="gft__icon"><img src="${iconB64}" alt="${this._esc(icon.label)}"/></span>
          <span class="gft__label">${this._esc(file.name)}</span>
          ${ext ? `<span class="gft__ext">.${this._esc(ext)}</span>` : ''}
        </div>
      `;
    }

    return html;
  }

  /**
   * Genera el HTML de las líneas guía de indentación.
   * @param {number}  depth
   * @param {boolean} isLeaf - true = archivo (dibuja línea horizontal final)
   * @returns {string}
   */
  _renderIndent(depth, isLeaf) {
    if (depth === 0) return '';
    let html = '<span class="gft__indent">';
    for (let i = 0; i < depth; i++) {
      const isLast = isLeaf && i === depth - 1;
      html += `<span class="gft__guideLine${isLast ? ' gft__guideLeaf' : ''}"></span>`;
    }
    html += '</span>';
    return html;
  }

  /**
   * Registra click handlers en todos los nodos del árbol renderizado.
   * Usar delegación de eventos desde el contenedor para mayor eficiencia.
   */
  _attachNodeEvents(container, tree) {
    const models = window.monaco?.editor?.getModels?.() ?? [];

    container.addEventListener('click', (evt) => {
      const node = evt.target.closest('.gft__node');
      if (!node) return;

      if (node.classList.contains('gft__folderNode')) {
        // Toggle colapso de carpeta
        const path = node.getAttribute('data-path');
        if (!path) return;
        if (this._collapsedPaths.has(path)) {
          this._collapsedPaths.delete(path);
        } else {
          this._collapsedPaths.add(path);
        }

        // Actualizar solo el toggle y children sin reconstruir todo
        const toggle   = node.querySelector('.gft__toggle');
        const children = container.querySelector(`[data-children-of="${CSS.escape(path)}"]`);
        const folderIcon = node.querySelector('.gft__icon img');

        if (this._collapsedPaths.has(path)) {
          toggle?.classList.remove('gft__open');
          children?.classList.add('gft__collapsed');
          if (folderIcon) folderIcon.src = gftSvgToUri(GFT_FOLDER_SVG(false));
        } else {
          toggle?.classList.add('gft__open');
          children?.classList.remove('gft__collapsed');
          if (folderIcon) folderIcon.src = gftSvgToUri(GFT_FOLDER_SVG(true));
        }
        return;
      }

      if (node.classList.contains('gft__fileNode')) {
        const idx = parseInt(node.getAttribute('data-model-index') ?? '-1', 10);
        if (idx < 0 || !models[idx]) return;

        const model = models[idx];
        this._goToModel(model);

        // Actualizar activo visualmente
        this._activeModel = model;
        this._highlightActiveFile();
      }
    });
  }

  /**
   * Navega el editor Monaco al modelo dado.
   * @param {object} model
   */
  _goToModel(model) {
    if (!this._editor || !model) return;
    try {
      this._editor.setModel(model);
      this._editor.focus();
      // Actualiza etiqueta del IDE si existe
      const label = document.querySelector('#ctnCurrentFileName');
      if (label) {
        const name = model.uri?.path?.split('/').pop() || '';
        label.textContent = decodeURIComponent(name);
      }
    } catch (_) {}
  }

  /**
   * Aplica/quita la clase gft__nodeActive en el nodo del archivo activo.
   */
  _highlightActiveFile() {
    const container = this.shadowRoot.getElementById('gft__treeScroll');
    if (!container || !this._activeModel) return;

    // Quitar clase de todos
    container.querySelectorAll('.gft__nodeActive').forEach(n => n.classList.remove('gft__nodeActive'));

    // Encontrar el nodo cuyo model-index coincide
    const models = window.monaco?.editor?.getModels?.() ?? [];
    const activeIdx = models.indexOf(this._activeModel);
    if (activeIdx < 0) return;

    const target = container.querySelector(`[data-model-index="${activeIdx}"]`);
    if (!target) return;
    target.classList.add('gft__nodeActive');
    target.scrollIntoView({ block: 'nearest' });
  }

  // ── Helpers de conteo ───────────────────────────────────────────────────────

  _countFiles(node) {
    let count = node.files.length;
    for (const child of node.children.values()) {
      count += this._countFiles(child);
    }
    return count;
  }

  _countFolders(node) {
    let count = node.children.size;
    for (const child of node.children.values()) {
      count += this._countFolders(child);
    }
    return count;
  }

  _collectAllFolderPaths(node, paths = []) {
    for (const child of node.children.values()) {
      paths.push(child.path);
      this._collectAllFolderPaths(child, paths);
    }
    return paths;
  }

  // ── Escape HTML ─────────────────────────────────────────────────────────────

  _esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// ── Registro ─────────────────────────────────────────────────────────────────

if (!customElements.get('gas-file-tree-panel')) {
  customElements.define('gas-file-tree-panel', GasFileTreePanel);
}