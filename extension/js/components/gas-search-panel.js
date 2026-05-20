class GasSearchPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** @type {object|null} Instancia activa del editor Monaco inyectada desde gasTools.js. */
    this._editor = null;
    /**
     * Lista plana de resultados del archivo actualmente seleccionado.
     * Se usa para navegar con ArrowUp / ArrowDown / Enter.
     * @type {Array<{fileName:string, text:string, range:object, model:object, element:HTMLElement}>}
     */
    this._flatResults = [];
    /** @type {number} Índice del resultado activo en _flatResults; -1 = ninguno. */
    this._activeIndex = -1;
    /**
     * Resultados agrupados por clave de archivo.
     * Estructura: { [fileKey: string]: Array<match> }
     * La clave incluye un sufijo numérico interno para evitar colisiones entre
     * modelos con el mismo nombre de archivo.
     * @type {Object.<string, Array>}
     */
    this._groupedResults = {};
    /**
     * Clave del archivo actualmente seleccionado en el panel izquierdo.
     * Coincide con una clave de _groupedResults.
     * @type {string}
     */
    this._currentFileKey = '';
    /**
     * Elemento DOM que actúa como ancla para posicionar el panel.
     * Generalmente es el botón que lo abre.
     * @type {HTMLElement|null}
     */
    this._anchorEl = null;
    /**
     * Indica si el panel ya fue posicionado al menos una vez.
     * Evita sobrescribir una posición ajustada manualmente por el usuario.
     * @type {boolean}
     */
    this._positionInitialized = false;
    /**
     * Estado activo del drag manual del panel.
     * null = no hay drag en curso.
     * @type {{offsetX:number, offsetY:number}|null}
     */
    this._dragState = null;
    /**
     * Estado activo del resize manual del panel.
     * null = no hay resize en curso.
     * @type {{startX:number, startY:number, startW:number, startH:number}|null}
     */
    this._resizeState = null;
    /**
     * Cache de nombres de archivo indexado por la URI del modelo Monaco.
     * Evita recalcular el nombre en cada búsqueda.
     * @type {Map<string, string>}
     */
    this._fileNameObjectMap = new Map();
    /**
     * Timer de debounce para la búsqueda.
     * Se cancela en cada pulsación de tecla para evitar búsquedas excesivas.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this._debounceTimer = null;
    this._splitterState = null;
    // Binds explícitos necesarios para poder remover los mismos listeners
    // que se registraron (addEventListener y removeEventListener deben
    // recibir la misma referencia de función).
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onDragMove          = this._onDragMove.bind(this);
    this._onDragEnd           = this._onDragEnd.bind(this);
    this._onResizeMove        = this._onResizeMove.bind(this);
    this._onResizeEnd         = this._onResizeEnd.bind(this);
    this._onSplitterMove      = this._onSplitterMove.bind(this);
    this._onSplitterEnd       = this._onSplitterEnd.bind(this);
  }
  connectedCallback() {
    this.render();
    this.setupListeners();
  }
  disconnectedCallback() {
    // Limpiamos todos los listeners globales para evitar memory leaks.
    window.removeEventListener('keydown', this._onWindowKeyDown);
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
    window.removeEventListener('mousemove', this._onSplitterMove);
    window.removeEventListener('mouseup', this._onSplitterEnd);
    clearTimeout(this._debounceTimer);
  }
  /**
   * Inyecta la instancia activa de Monaco Editor.
   * Debe llamarse desde gasTools.js cada vez que el editor cambia.
   * @param {object|null} editor - Instancia de monaco.editor.IStandaloneCodeEditor.
   */
  setEditor(editor) {
    this._editor = editor || null;
  }
  /**
   * Registra el elemento ancla que sirve de referencia para posicionar el panel.
   * @param {HTMLElement|null} anchorEl
   */
  setAnchor(anchorEl) {
    this._anchorEl = anchorEl || null;
  }
  /**
   * Abre el panel, refresca el cache de nombres de archivo y enfoca el input.
   * Si hay texto seleccionado en el editor, lo usa como valor inicial de búsqueda.
   * @param {HTMLElement|null} [anchorEl] - Ancla opcional; si se pasa, reemplaza la anterior.
   */
  open(anchorEl = null) {
    if (anchorEl) this.setAnchor(anchorEl);
    // Cerrar el panel de chat si está abierto: solo uno visible a la vez.
    document.querySelector('gas-chat-panel')?.close?.();
    this.style.display       = 'block';
    this.style.pointerEvents = 'auto';
    this._repositionPanel(true);
    this._resetState();
    const input = this.shadowRoot.getElementById('gc__searchInput');
    // ── Texto seleccionado en el editor: úsalo como query inicial ──
    let initialQuery = '';
    if (this._editor) {
      try {
        const selection = this._editor.getSelection();
        if (selection && !selection.isEmpty()) {
          const model = this._editor.getModel();
          if (model) {
            initialQuery = model.getValueInRange(selection).trim();
          }
        }
      } catch (_) { /* El editor puede no estar listo; ignoramos el error */ }
    }
    if (input) {
      setTimeout(() => {
        input.focus();
        if (initialQuery) {
          input.value = initialQuery;
          input.select();
          this._search(initialQuery);   // lanza la búsqueda de inmediato
        } else {
          input.select();
        }
      }, 30);
    }
  }

  /**
   * Establece el mapa de archivos.
   * @param {Map<string, string>} fileNameObjectMap
   */
  setFileNameObjectMap(fileNameObjectMap) {
    this._fileNameObjectMap = fileNameObjectMap;
  }
  /**
   * Cierra el panel y resetea el índice de selección activa.
   */
  close() {
    this.style.display       = 'none';
    this.style.pointerEvents = 'none';
    this._activeIndex = -1;
  }
  /**
   * Alterna entre abierto y cerrado.
   * @param {HTMLElement|null} [anchorEl]
   */
  toggle(anchorEl = null) {
    if (this.style.display === 'block') {
      this.close();
      return;
    }
    this.open(anchorEl);
  }
  /**
   * Genera el HTML del panel usando DomUtils para compatibilidad con Trusted Types.
   *
   * Estructura visual:
   *   ┌─────────────────────────────────────┐
   *   │ Header (icono + input + botón cerrar)│
   *   │ Meta   (resumen + hint de teclado)  │
   *   │ Content                             │
   *   │  ├─ gc__models  (lista de archivos) │
   *   │  └─ gc__results (coincidencias)     │
   *   │ ResizeHandle                        │
   *   └─────────────────────────────────────┘
   */
  render() {
    DomUtils.setHTML(this.shadowRoot, `
      <style>
        :host {
          display: none;
          pointer-events: none;
          position: fixed;
          top: 102px;
          right: 14px;
          left: auto;
          transform: none;
          z-index: 2147483640;
          width: min(400px, calc(100vw - 28px));
          height: min(440px, calc(100vh - 120px));
          min-width: 360px;
          min-height: 280px;
          max-width: 700px;
          max-height: calc(100vh - 84px);
          background: #ffffff;
          color: #202124;
          border: 1px solid #dadce0;
          border-radius: 10px;
          box-shadow: 0 10px 38px rgba(60,64,67,.24), 0 2px 8px rgba(60,64,67,.18);
          font-family: "Google Sans", Roboto, Arial, sans-serif;
          overflow: hidden;
          animation: gc__panelIn .16s ease-out;
        }
        @keyframes gc__panelIn {
          from { transform: translateX(8px); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
        :host([theme="dark"]) {
          background: #202124;
          color: #e8eaed;
          border-color: #3c4043;
        }
        .gc__shell {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        /* ── Header ── */
        .gc__header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 8px;
          cursor: move;
          user-select: none;
          border-bottom: 1px solid #eceff1;
          background: linear-gradient(to bottom, rgba(248,249,250,.9), rgba(248,249,250,.6));
        }
        :host([theme="dark"]) .gc__header {
          border-bottom-color: #3c4043;
          background: linear-gradient(to bottom, rgba(32,33,36,.95), rgba(32,33,36,.75));
        }
        .gc__icon {
          width: 20px;
          height: 20px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          font-size: 11px;
          background: rgba(26,115,232,.12);
          color: #1a73e8;
          flex: 0 0 auto;
        }
        .gc__input {
          flex: 1;
          height: 32px;
          border: 1px solid #d6dbe1;
          border-radius: 8px;
          outline: none;
          font-size: 12px;
          background: #ffffff;
          color: inherit;
          user-select: text;
          padding: 0 9px;
          min-width: 0; /* Permite que flex lo comprima si es necesario */
        }
        .gc__input:focus {
          border-color: #a8c7fa;
          box-shadow: 0 0 0 2px rgba(26,115,232,.12);
        }
        :host([theme="dark"]) .gc__input {
          background: #202124;
          border-color: #3c4043;
          color: #e8eaed;
        }
        .gc__close {
          border: none;
          background: transparent;
          color: #5f6368;
          width: 30px;
          height: 30px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 18px;
          line-height: 30px;
          flex: 0 0 auto;
        }
        .gc__close:hover { background: rgba(95,99,104,.14); }
        :host([theme="dark"]) .gc__close { color: #bdc1c6; }
        /* ── Barra de metadata (totales + hint de teclado) ── */
        .gc__meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 4px 8px;
          font-size: 10px;
          color: #5f6368;
          border-bottom: 1px solid #eceff1;
          background: #fff;
          white-space: nowrap;
          overflow: hidden;
        }
        :host([theme="dark"]) .gc__meta {
          color: #9aa0a6;
          border-bottom-color: #3c4043;
          background: #202124;
        }
        #gc__summary {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        #gc__hint {
          flex: 0 0 auto;
          color: #80868b;
        }
        /* ── Layout de dos columnas: archivos | resultados ── */
        .gc__content {
          display: flex;
          min-height: 0;
          height: 100%;
        }
        /* ── Divisor arrastrable entre los dos paneles ── */
        .gc__splitter {
          width: 4px;
          flex: 0 0 4px;
          background: #eceff1;
          cursor: col-resize;
          transition: background .15s;
        }
        .gc__splitter:hover,
        .gc__splitter.gc__splitterActive { background: #a8c7fa; }
        :host([theme="dark"]) .gc__splitter { background: #3c4043; }
        :host([theme="dark"]) .gc__splitter:hover,
        :host([theme="dark"]) .gc__splitter.gc__splitterActive { background: #4b6286; }
        /* ── Panel izquierdo: lista de archivos con contador ── */
        .gc__models {
          flex: 0 0 140px;
          min-width: 80px;
          max-width: 60%;
          border-right: none; /* el splitter hace de separador */
          overflow: auto;
          background: #fff;
          padding: 5px;
        }
        :host([theme="dark"]) .gc__models {
          border-right-color: #3c4043;
          background: #202124;
        }
        .gc__modelItem {
          width: 100%;
          border: 1px solid transparent;
          background: transparent;
          color: inherit;
          border-radius: 6px;
          padding: 5px 6px;
          text-align: left;
          cursor: pointer;
          font-size: 10.5px;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .gc__modelItem:hover { background: #f1f3f4; }
        .gc__modelItem.gc__active {
          background: #e8f0fe;
          border-color: #d2e3fc;
          color: #174ea6;
          font-weight: 600;
        }
        :host([theme="dark"]) .gc__modelItem:hover { background: #303134; }
        :host([theme="dark"]) .gc__modelItem.gc__active {
          background: #344864;
          border-color: #4b6286;
          color: #d2e3fc;
        }
        /* Contador de coincidencias que precede al nombre del archivo */
        .gc__modelCount {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 14px;
          padding: 0 4px;
          border-radius: 8px;
          font-size: 9px;
          font-weight: 700;
          background: rgba(26,115,232,.13);
          color: #1a73e8;
          flex: 0 0 auto;
          line-height: 14px;
        }
        .gc__modelItem.gc__active .gc__modelCount {
          background: rgba(23,78,166,.18);
          color: #174ea6;
        }
        :host([theme="dark"]) .gc__modelCount {
          background: rgba(138,180,248,.15);
          color: #8ab4f8;
        }
        :host([theme="dark"]) .gc__modelItem.gc__active .gc__modelCount {
          background: rgba(210,227,252,.15);
          color: #d2e3fc;
        }
        .gc__modelLabel {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }
        /* ── Panel derecho: resultados del archivo seleccionado ── */
        .gc__results {
          flex: 1;
          min-width: 0;
          overflow: auto;
          background: #f8f9fa;
          padding: 6px;
        }
        :host([theme="dark"]) .gc__results { background: #202124; }
        .gc__empty {
          padding: 12px;
          color: #70757a;
          font-size: 11px;
        }
        .gc__group {
          border: 1px solid #e6e9ec;
          border-radius: 8px;
          background: #fff;
          overflow: hidden;
        }
        :host([theme="dark"]) .gc__group {
          border-color: #3c4043;
          background: #2a2b2f;
        }
        .gc__groupTitle {
          font-size: 10px;
          font-weight: 600;
          color: #3c4043;
          padding: 6px 8px;
          background: #f1f3f4;
          border-bottom: 1px solid #eceff1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        :host([theme="dark"]) .gc__groupTitle {
          color: #e8eaed;
          background: #303134;
          border-bottom-color: #3c4043;
        }
        .gc__item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 8px;
          border-bottom: 1px solid #f1f3f4;
          cursor: pointer;
        }
        .gc__item:last-child { border-bottom: none; }
        .gc__item:hover { background: #eef3fd; }
        .gc__item.gc__active { background: #d2e3fc; }
        :host([theme="dark"]) .gc__item { border-bottom-color: #3c4043; }
        :host([theme="dark"]) .gc__item:hover { background: #2d3a52; }
        :host([theme="dark"]) .gc__item.gc__active { background: #344864; }
        .gc__lineBadge {
          flex: 0 0 auto;
          min-width: 48px;
          height: 16px;
          border-radius: 10px;
          font-size: 9px;
          font-weight: 600;
          display: grid;
          place-items: center;
          color: #1a73e8;
          background: rgba(26,115,232,.12);
        }
        .gc__code {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 10.5px;
        }
        /* ── Handle de redimensionamiento en la esquina inferior izquierda ── */
        .gc__resizeHandle {
          position: absolute;
          left: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nesw-resize;
          background:
            linear-gradient(225deg, transparent 0 45%, rgba(95,99,104,.45) 45% 55%, transparent 55% 100%);
        }
      </style>
      <div class="gc__shell">
        <div class="gc__header">
          <div class="gc__icon">🔎</div>
          <input id="gc__searchInput" class="gc__input" type="text" autocomplete="off"
                 placeholder="Search all files (min 1 chars)">
          <button id="gc__closeBtn" class="gc__close" title="Close (Esc)">×</button>
        </div>
        <div class="gc__meta">
          <div id="gc__summary">Type to start searching</div>
          <div id="gc__hint">Enter: open · ↑↓: nav</div>
        </div>
        <div class="gc__content">
          <div id="gc__modelsContainer" class="gc__models">
            <div class="gc__empty">No files</div>
          </div>
          <div id="gc__splitter" class="gc__splitter"></div>
          <div id="gc__resultsContainer" class="gc__results">
            <div class="gc__empty">No results yet.</div>
          </div>
        </div>
        <div id="gc__resizeHandle" class="gc__resizeHandle" title="Resize"></div>
      </div>
    `);
  }
  /**
   * Registra todos los listeners del componente.
   */
  setupListeners() {
    const input        = this.shadowRoot.getElementById('gc__searchInput');
    const closeBtn     = this.shadowRoot.getElementById('gc__closeBtn');
    const header       = this.shadowRoot.querySelector('.gc__header');
    const resizeHandle = this.shadowRoot.getElementById('gc__resizeHandle');
    const splitter     = this.shadowRoot.getElementById('gc__splitter');
    closeBtn?.addEventListener('click', () => this.close());
    input?.addEventListener('input', (e) => {
      const value = e.target.value || '';
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._search(value), 170);
    });
    input?.addEventListener('keydown', (e) => {
      if      (e.key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1);  }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this._moveSelection(-1); }
      else if (e.key === 'Enter')     { e.preventDefault(); this._goToActiveResult(); }
    });
    header?.addEventListener('mousedown', (evt) => {
      const isInteractive = evt.target.closest('#gc__searchInput, #gc__closeBtn');
      if (isInteractive) return;
      evt.preventDefault();
      this._startDrag(evt);
    });
    resizeHandle?.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this._startResize(evt);
    });
    // ── Splitter interno: ajusta el ancho relativo de las dos columnas ──
    splitter?.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this._startSplitterDrag(evt);
    });
    window.addEventListener('keydown', this._onWindowKeyDown);
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
  }
  /** Cierra el panel al presionar Escape. */
  _onWindowKeyDown(e) {
    if (e.key === 'Escape' && this.style.display === 'block') {
      this.close();
    }
  }
  _onDocumentMouseDown(e) {}
  /**
   * Coloca el panel en su posición inicial.
   * @param {boolean} [forceCenter=false]
   */
  _repositionPanel(forceCenter = false) {
    if (this._positionInitialized && !forceCenter) return;
    // Posición
    this.style.right     = '14px';
    this.style.left      = 'auto';
    this.style.top       = '102px';
    this.style.transform = 'none';
    // Tamaño: volvemos siempre al default al abrir
    this.style.width     = '';
    this.style.height    = '';
    this.style.maxWidth  = '';
    this._positionInitialized = true;
    // Resetear también el ancho de la columna izquierda al default
    const models = this.shadowRoot?.querySelector('.gc__models');
    if (models) models.style.flex = '0 0 140px';
  }
  /**
   * Inicia el drag manual.
   * @param {MouseEvent} evt
   */
  _startDrag(evt) {
    const rect = this.getBoundingClientRect();
    this.style.left      = `${rect.left}px`;
    this.style.top       = `${rect.top}px`;
    this.style.right     = 'auto';
    this.style.transform = 'none';
    this._dragState = {
      offsetX: evt.clientX - rect.left,
      offsetY: evt.clientY - rect.top,
    };
    window.addEventListener('mousemove', this._onDragMove);
    window.addEventListener('mouseup', this._onDragEnd);
  }
  /**
   * Mueve el panel durante el drag.
   * @param {MouseEvent} evt
   */
  _onDragMove(evt) {
    if (!this._dragState) return;
    const width    = this.offsetWidth  || 0;
    const height   = this.offsetHeight || 0;
    const nextLeft = evt.clientX - this._dragState.offsetX;
    const nextTop  = evt.clientY - this._dragState.offsetY;
    this.style.left = `${Math.max(0, Math.min(nextLeft, window.innerWidth  - width))}px`;
    this.style.top  = `${Math.max(54, Math.min(nextTop,  window.innerHeight - height))}px`;
  }
  /** Finaliza el drag. */
  _onDragEnd() {
    this._dragState = null;
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
  }
  /**
   * Inicia el resize.
   * @param {MouseEvent} evt
   */
  _startResize(evt) {
    const rect = this.getBoundingClientRect();
    // Fijamos right en píxeles para que el lado derecho quede anclado mientras
    // el usuario arrastra desde la esquina inferior izquierda.
    this.style.right = `${window.innerWidth - rect.right}px`;
    this.style.left  = 'auto';
    this._resizeState = {
      startX: evt.clientX,
      startY: evt.clientY,
      startW: this.offsetWidth,
      startH: this.offsetHeight,
    };
    window.addEventListener('mousemove', this._onResizeMove);
    window.addEventListener('mouseup', this._onResizeEnd);
  }
  /**
   * Actualiza el tamaño durante el resize.
   * Como el handle está abajo-izquierda, el ancho crece hacia la izquierda
   * (deltaX negativo = panel más ancho) y la altura crece hacia abajo.
   * @param {MouseEvent} evt
   */
  _onResizeMove(evt) {
    if (!this._resizeState) return;
    const minW = 360, minH = 280;
    const maxW = window.innerWidth  - 18;
    const maxH = window.innerHeight - 84;
    // Ancho: arrastrar a la izquierda (deltaX < 0) lo agranda
    const nextW = this._resizeState.startW - (evt.clientX - this._resizeState.startX);
    const nextH = this._resizeState.startH + (evt.clientY - this._resizeState.startY);
    this.style.width  = `${Math.max(minW, Math.min(nextW, maxW))}px`;
    this.style.height = `${Math.max(minH, Math.min(nextH, maxH))}px`;
  }
  /** Finaliza el resize. */
  _onResizeEnd() {
    this._resizeState = null;
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
  }
  /**
   * Resetea el estado interno y la UI al estado vacío inicial.
   */
  _resetState() {
    const input            = this.shadowRoot.getElementById('gc__searchInput');
    const summary          = this.shadowRoot.getElementById('gc__summary');
    const modelsContainer  = this.shadowRoot.getElementById('gc__modelsContainer');
    const resultsContainer = this.shadowRoot.getElementById('gc__resultsContainer');
    if (input) input.value = '';
    this._flatResults    = [];
    this._activeIndex    = -1;
    this._groupedResults = {};
    this._currentFileKey = '';
    if (summary)          summary.textContent = 'Type to start searching';
    if (modelsContainer)  DomUtils.setHTML(modelsContainer,  `<div class="gc__empty">No files</div>`);
    if (resultsContainer) DomUtils.setHTML(resultsContainer, `<div class="gc__empty">No results yet.</div>`);
  }
  /**
   * Punto de entrada de la búsqueda.
   * @param {string} term
   */
  _search(term) {
    const query            = String(term || '').trim();
    const summary          = this.shadowRoot.getElementById('gc__summary');
    const modelsContainer  = this.shadowRoot.getElementById('gc__modelsContainer');
    const resultsContainer = this.shadowRoot.getElementById('gc__resultsContainer');
    if (!query) {
      this._flatResults    = [];
      this._activeIndex    = -1;
      this._groupedResults = {};
      this._currentFileKey = '';
      summary.textContent = 'Type to start searching';
      DomUtils.setHTML(modelsContainer,  `<div class="gc__empty">No files</div>`);
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">No results yet.</div>`);
      return;
    }
    if (query.length < 1) {
      this._flatResults    = [];
      this._activeIndex    = -1;
      this._groupedResults = {};
      this._currentFileKey = '';
      summary.textContent = 'Query too short';
      DomUtils.setHTML(modelsContainer,  `<div class="gc__empty">No files</div>`);
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">Enter at least 1 characters.</div>`);
      return;
    }
    const grouped  = this._findAllMatches(query);
    this._groupedResults = grouped;
    const fileNames = Object.keys(grouped);
    if (!fileNames.length) {
      this._currentFileKey = '';
      this._renderModelList();
      this._renderResults(query);
      return;
    }
    if (!this._currentFileKey || !grouped[this._currentFileKey]) {
      this._currentFileKey = fileNames[0];
    }
    this._renderModelList();
    this._renderResults(query);
  }
  /**
   * Busca la query en los modelos Monaco que pertenecen al proyecto y
   * agrupa los resultados por archivo.
   *
   * Solo incluye modelos cuya URI exista en `_fileNameObjectMap` (es
   * decir, archivos reales del proyecto inyectados por `gas-tools.js`).
   * De este modo evitamos buscar en modelos internos de Monaco (workers,
   * peek views, output panels, diff editors, etc.) que producen
   * resultados ruidosos.
   *
   * @param {string} searchText
   * @returns {Object.<string, Array>}
   */
  _findAllMatches(searchText) {
    const grouped = {};
    const allModels = window.monaco?.editor?.getModels?.() || [];

    // Filtramos a SOLO los modelos del proyecto. Si el mapa aún no se ha
    // inyectado (caso edge: panel abierto antes de la primera sincro),
    // caemos al comportamiento anterior para no romper la búsqueda.
    const map    = this._fileNameObjectMap;
    const hasMap = map instanceof Map && map.size > 0;
    const models = hasMap
      ? allModels.filter((m) => map.has(String(m.uri)))
      : allModels;

    // Si gas-tools.js no inyectó un formateador, usamos un fallback basado
    // en la URI para evitar que la búsqueda falle.
    const formatName = typeof this._formatModelName === 'function'
      ? this._formatModelName
      : (model, idx) => {
          const path = String(model?.uri?.path || '').replace(/^\//, '');
          return path || `File ${idx + 1}`;
        };
    models.forEach((model, index) => {
      const matches = model.findMatches(searchText, false, false, false, null, true);
      if (!matches?.length) return;
      const displayName = formatName(model, index);
      const key = `${displayName}__gc__${index + 1}`;
      grouped[key] = matches.map((match) => ({
        fileName : displayName,
        text     : model.getLineContent(match.range.startLineNumber).trim(),
        range    : match.range,
        model,
      }));
    });
    return grouped;
  }
  /**
   * Renderiza el panel izquierdo con la lista de archivos.
   * Al hacer clic en un archivo, además de renderizar sus resultados,
   * navega automáticamente al primer resultado en el editor.
   */
  _renderModelList() {
    const modelsContainer = this.shadowRoot.getElementById('gc__modelsContainer');
    const fileKeys        = Object.keys(this._groupedResults);
    if (!fileKeys.length) {
      DomUtils.setHTML(modelsContainer, `<div class="gc__empty">No files</div>`);
      return;
    }
    const html = fileKeys.map((key) => {
      const count       = this._groupedResults[key]?.length || 0;
      const isActive    = key === this._currentFileKey ? 'gc__active' : '';
      const displayName = this._groupedResults[key]?.[0]?.fileName || 'Model';
      return `
        <button
          class="gc__modelItem ${isActive}"
          data-model="${this._escapeAttr(key)}"
          title="${this._escapeAttr(displayName)} (${count} match${count !== 1 ? 'es' : ''})"
        >
          <span class="gc__modelCount">${count}</span>
          <span class="gc__modelLabel">${this._escapeHtml(displayName)}</span>
        </button>
      `;
    }).join('');
    DomUtils.setHTML(modelsContainer, html);
    modelsContainer.querySelectorAll('.gc__modelItem').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._currentFileKey = btn.getAttribute('data-model') || '';
        // Resetamos al primer resultado del archivo recién seleccionado.
        this._activeIndex = 0;
        this._renderModelList();
        this._renderResults();
        // ── NUEVO: navega al primer resultado del archivo en el editor ──
        const firstResult = this._flatResults[0];
        if (firstResult) {
          this._goTo(firstResult);
        }
      });
    });
  }
  /**
   * Renderiza la lista de coincidencias del archivo activo y deja el primer
   * resultado seleccionado tanto visualmente como en el editor.
   * @param {string} [query='']
   * @param {boolean} [autoGoTo=false] Si es true, navega al resultado activo
   *   tras renderizar. Solo lo activamos en el flujo de búsqueda nueva, no
   *   cuando el usuario navega manualmente con flechas.
   */
  _renderResults(query = '', autoGoTo = false) {
    const summary          = this.shadowRoot.getElementById('gc__summary');
    const resultsContainer = this.shadowRoot.getElementById('gc__resultsContainer');
    const fileNames        = Object.keys(this._groupedResults);
    if (!fileNames.length) {
      this._flatResults = [];
      this._activeIndex = -1;
      summary.textContent = `No matches for "${query}"`;
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">No matches found.</div>`);
      return;
    }
    const total = fileNames.reduce((acc, key) => acc + this._groupedResults[key].length, 0);
    summary.textContent = `${total} match(es) in ${fileNames.length} file(s)`;
    const currentResults = this._groupedResults[this._currentFileKey] || [];
    const groupTitle     = currentResults[0]?.fileName || 'File';
    if (!currentResults.length) {
      this._flatResults = [];
      this._activeIndex = -1;
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">No matches for this file.</div>`);
      return;
    }
    const html = `
      <section class="gc__group">
        <div class="gc__groupTitle" title="${this._escapeAttr(groupTitle)}">
          ${this._escapeHtml(groupTitle)} (${currentResults.length})
        </div>
        ${currentResults.map((item) => `
          <div class="gc__item" title="${this._escapeAttr(item.text)}">
            <div class="gc__lineBadge">L ${item.range.startLineNumber}</div>
            <div class="gc__code">${this._escapeHtml(item.text || '(empty line)')}</div>
          </div>
        `).join('')}
      </section>
    `;
    DomUtils.setHTML(resultsContainer, html);
    this._flatResults = [];
    const domItems = Array.from(resultsContainer.querySelectorAll('.gc__item'));
    currentResults.forEach((item, idx) => {
      this._flatResults.push({ ...item, element: domItems[idx] });
    });
    this._flatResults.forEach((result, idx) => {
      result.element.addEventListener('click', () => {
        this._activeIndex = idx;
        this._syncActiveStyles();
        this._goTo(result);
      });
    });
    if (this._flatResults.length > 0) {
      if (this._activeIndex < 0 || this._activeIndex >= this._flatResults.length) {
        this._activeIndex = 0;
      }
      this._syncActiveStyles();
      // Tras una búsqueda nueva, además de marcar el resultado activo,
      // navegamos a él en el editor para que la selección sea coherente.
      if (autoGoTo) this._goTo(this._flatResults[this._activeIndex]);
    }
  }
  /**
   * Mueve el índice activo en la lista plana de resultados.
   * @param {number} step
   */
  _moveSelection(step) {
    if (!this._flatResults.length) return;
    const next = this._activeIndex + step;
    if (next < 0 || next >= this._flatResults.length) return;
    this._activeIndex = next;
    this._syncActiveStyles();
  }
  /**
   * Aplica la clase gc__active al resultado activo y hace scroll para mantenerlo visible.
   */
  _syncActiveStyles() {
    this._flatResults.forEach((entry, index) => {
      if (!entry.element) return;
      entry.element.classList.toggle('gc__active', index === this._activeIndex);
      if (index === this._activeIndex) {
        entry.element.scrollIntoView({ block: 'nearest' });
      }
    });
  }
  /**
   * Navega al resultado activo al presionar Enter.
   */
  _goToActiveResult() {
    if (this._activeIndex < 0 || !this._flatResults[this._activeIndex]) return;
    this._goTo(this._flatResults[this._activeIndex]);
  }
  /**
   * Abre el modelo Monaco correspondiente y hace foco en el rango encontrado.
   * @param {{model:object, range:object}} result
   */
  _goTo(result) {
    if (!this._editor || !result?.model || !result?.range) return;
    this._editor.setModel(result.model);
    this._editor.setSelection(result.range);
    this._editor.revealRangeInCenter(result.range);
    this._editor.focus();
    // Actualizar el nombre del archivo activo en la toolbar. Apuntamos al
    // span interno del botón nuevo (`#qcCfnName`) en lugar del wrapper
    // `#ctnCurrentFileName` para no romper la estructura del botón.
    if (typeof this._formatModelName === 'function') {
      const name = this._formatModelName(result.model, 0);
      const nameEl = document.querySelector('#ctnCurrentFileName #qcCfnName');
      if (nameEl) {
        nameEl.textContent = name;
        nameEl.title = name;
      }
    }
  }
  /**
   * Escapa caracteres especiales HTML.
   * @param {string} value
   * @returns {string}
   */
  _escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  /**
   * Escapa HTML más comillas dobles para uso en atributos.
   * @param {string} value
   * @returns {string}
   */
  _escapeAttr(value) {
    return this._escapeHtml(value).replace(/"/g, '&quot;');
  }
  /**
   * Inicia el drag del splitter interno entre las dos columnas.
   * Captura el ancho actual del panel de modelos como punto de partida.
   * @param {MouseEvent} evt
   */
  _startSplitterDrag(evt) {
    const models = this.shadowRoot.querySelector('.gc__models');
    const splitter = this.shadowRoot.getElementById('gc__splitter');
    if (!models) return;
    this._splitterState = {
      startX   : evt.clientX,
      startW   : models.offsetWidth,
      totalW   : this.offsetWidth,
    };
    splitter?.classList.add('gc__splitterActive');
    window.addEventListener('mousemove', this._onSplitterMove);
    window.addEventListener('mouseup', this._onSplitterEnd);
  }
  /**
   * Ajusta el ancho de la columna izquierda durante el drag del splitter.
   * @param {MouseEvent} evt
   */
  _onSplitterMove(evt) {
    if (!this._splitterState) return;
    const models  = this.shadowRoot.querySelector('.gc__models');
    if (!models) return;
    const delta   = evt.clientX - this._splitterState.startX;
    const nextW   = this._splitterState.startW + delta;
    const minLeft = 80;
    const maxLeft = this._splitterState.totalW * 0.6;
    models.style.flex = `0 0 ${Math.max(minLeft, Math.min(nextW, maxLeft))}px`;
  }
  /** Finaliza el drag del splitter. */
  _onSplitterEnd() {
    this._splitterState = null;
    const splitter = this.shadowRoot.getElementById('gc__splitter');
    splitter?.classList.remove('gc__splitterActive');
    window.removeEventListener('mousemove', this._onSplitterMove);
    window.removeEventListener('mouseup', this._onSplitterEnd);
  }
}
if (!customElements.get('gas-search-panel')) {
  customElements.define('gas-search-panel', GasSearchPanel);
}