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
    this._fileNameCacheByModelUri = new Map();

    /**
     * Pool de nombres de archivo extraídos del árbol del DOM del IDE.
     * Se usa como fallback cuando la URI del modelo no tiene un basename legible.
     * @type {string[]}
     */
    this._fileNamePoolFromDom = [];

    /**
     * Timer de debounce para la búsqueda.
     * Se cancela en cada pulsación de tecla para evitar búsquedas excesivas.
     * @type {ReturnType<typeof setTimeout>|null}
     */
    this._debounceTimer = null;

    // Binds explícitos necesarios para poder remover los mismos listeners
    // que se registraron (addEventListener y removeEventListener deben
    // recibir la misma referencia de función).
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onDragMove          = this._onDragMove.bind(this);
    this._onDragEnd           = this._onDragEnd.bind(this);
    this._onResizeMove        = this._onResizeMove.bind(this);
    this._onResizeEnd         = this._onResizeEnd.bind(this);
  }

  connectedCallback() {
    this.render();
    this.setupListeners();
    this._setupFileTreeObserver();
  }

  disconnectedCallback() {
    // Limpiamos todos los listeners globales para evitar memory leaks.
    window.removeEventListener('keydown', this._onWindowKeyDown);
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
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
    this.style.display       = 'block';
    this.style.pointerEvents = 'auto';
    this._repositionPanel(true);
    this._refreshFileNameCacheFromDom();
    this._buildFullModelMapFromClicks();
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

  debugUris() {
    const models = window.monaco?.editor?.getModels?.() || [];
    console.group('=== GasSearchPanel URI debug ===');
    console.log('DOM names pool:', this._fileNamePoolFromDom);
    console.log('URI → name cache:', Object.fromEntries(this._fileNameCacheByModelUri));
    models.forEach((m, i) => {
      console.log(`Model[${i}]`, {
        uri_toString : m?.uri?.toString?.(),
        uri_path     : m?.uri?.path,
        uri_formatted: m?.uri?._formatted,
        uri_full     : JSON.stringify(m?.uri),
        first80chars : m?.getValue?.()?.slice(0, 80),
      });
    });
    console.groupEnd();
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
          width: min(780px, calc(100vw - 28px));
          height: min(620px, calc(100vh - 120px));
          min-width: 560px;
          min-height: 320px;
          max-width: calc(100vw - 18px);
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
          gap: 10px;
          padding: 8px 10px;
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
          width: 22px;
          height: 22px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          font-size: 12px;
          background: rgba(26,115,232,.12);
          color: #1a73e8;
          flex: 0 0 auto;
        }
        .gc__input {
          flex: 1;
          height: 34px;
          border: 1px solid #d6dbe1;
          border-radius: 8px;
          outline: none;
          font-size: 13px;
          background: #ffffff;
          color: inherit;
          user-select: text;
          padding: 0 10px;
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
          width: 34px;
          height: 34px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 20px;
          line-height: 34px;
        }
        .gc__close:hover { background: rgba(95,99,104,.14); }
        :host([theme="dark"]) .gc__close { color: #bdc1c6; }

        /* ── Barra de metadata (totales + hint de teclado) ── */
        .gc__meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 6px 10px;
          font-size: 11px;
          color: #5f6368;
          border-bottom: 1px solid #eceff1;
          background: #fff;
        }
        :host([theme="dark"]) .gc__meta {
          color: #9aa0a6;
          border-bottom-color: #3c4043;
          background: #202124;
        }

        /* ── Layout de dos columnas: archivos | resultados ── */
        .gc__content {
          display: grid;
          /* Panel izquierdo más ancho para mostrar el contador + nombre sin truncar */
          /*grid-template-columns: 220px 1fr;*/
          grid-template-columns: 180px 1fr;
          min-height: 0;
          height: 100%;
        }

        /* ── Panel izquierdo: lista de archivos con contador ── */
        .gc__models {
          border-right: 1px solid #eceff1;
          overflow: auto;
          background: #fff;
          padding: 7px;
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
          border-radius: 8px;
          padding: 7px 8px;
          text-align: left;
          cursor: pointer;
          font-size: 11px;
          margin-bottom: 6px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
          min-width: 22px;
          height: 16px;
          padding: 0 5px;
          border-radius: 10px;
          font-size: 10px;
          font-weight: 700;
          background: rgba(26,115,232,.13);
          color: #1a73e8;
          margin-right: 5px;
          flex: 0 0 auto;
          vertical-align: middle;
          line-height: 16px;
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

        /* ── Panel derecho: resultados del archivo seleccionado ── */
        .gc__results {
          overflow: auto;
          background: #f8f9fa;
          padding: 8px;
        }
        :host([theme="dark"]) .gc__results { background: #202124; }
        .gc__empty {
          padding: 14px;
          color: #70757a;
          font-size: 12px;
        }
        .gc__group {
          border: 1px solid #e6e9ec;
          border-radius: 10px;
          background: #fff;
          overflow: hidden;
        }
        :host([theme="dark"]) .gc__group {
          border-color: #3c4043;
          background: #2a2b2f;
        }
        .gc__groupTitle {
          font-size: 11px;
          font-weight: 600;
          color: #3c4043;
          padding: 8px 10px;
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
          gap: 7px;
          padding: 8px 10px;
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
          min-width: 58px;
          height: 18px;
          border-radius: 12px;
          font-size: 10px;
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
          font-size: 11px;
        }

        /* ── Handle de redimensionamiento en la esquina inferior derecha ── */
        .gc__resizeHandle {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nwse-resize;
          background:
            linear-gradient(135deg, transparent 0 45%, rgba(95,99,104,.45) 45% 55%, transparent 55% 100%);
        }
      </style>
      <div class="gc__shell">
        <div class="gc__header">
          <div class="gc__icon">🔎</div>
          <input id="gc__searchInput" class="gc__input" type="text" autocomplete="off"
                 placeholder="Search in all files (min 3 chars)">
          <button id="gc__closeBtn" class="gc__close" title="Close (Esc)">×</button>
        </div>
        <div class="gc__meta">
          <div id="gc__summary">Type to start searching</div>
          <div id="gc__hint">Enter: open • ↑↓: navigate</div>
        </div>
        <div class="gc__content">
          <div id="gc__modelsContainer" class="gc__models">
            <div class="gc__empty">No files</div>
          </div>
          <div id="gc__resultsContainer" class="gc__results">
            <div class="gc__empty">No results yet.</div>
          </div>
        </div>
        <div id="gc__resizeHandle" class="gc__resizeHandle" title="Resize"></div>
      </div>
    `);
  }

  /**
   * Registra todos los listeners del componente:
   * - Input con debounce para búsqueda fluida mientras se escribe.
   * - Teclado (ArrowUp / ArrowDown / Enter) para navegar resultados sin ratón.
   * - Drag desde el header para reposicionar el panel.
   * - Resize desde la esquina inferior derecha.
   * - Escape y clic externo para cerrar.
   */
  setupListeners() {
    const input        = this.shadowRoot.getElementById('gc__searchInput');
    const closeBtn     = this.shadowRoot.getElementById('gc__closeBtn');
    const header       = this.shadowRoot.querySelector('.gc__header');
    const resizeHandle = this.shadowRoot.getElementById('gc__resizeHandle');

    closeBtn?.addEventListener('click', () => this.close());

    input?.addEventListener('input', (e) => {
      const value = e.target.value || '';
      // Cancelamos el timer anterior para que solo se dispare una búsqueda
      // después de que el usuario deje de escribir por 170 ms.
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._search(value), 170);
    });

    input?.addEventListener('keydown', (e) => {
      if      (e.key === 'ArrowDown') { e.preventDefault(); this._moveSelection(1);  }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); this._moveSelection(-1); }
      else if (e.key === 'Enter')     { e.preventDefault(); this._goToActiveResult(); }
    });

    // Drag: solo desde zonas no interactivas del header.
    header?.addEventListener('mousedown', (evt) => {
      const isInteractive = evt.target.closest('#gc__searchInput, #gc__closeBtn');
      if (isInteractive) return;
      evt.preventDefault();
      this._startDrag(evt);
    });

    // Resize desde la esquina inferior derecha.
    resizeHandle?.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this._startResize(evt);
    });

    window.addEventListener('keydown', this._onWindowKeyDown);
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
  }

  /** Cierra el panel al presionar Escape, sea cual sea el foco activo. */
  _onWindowKeyDown(e) {
    if (e.key === 'Escape' && this.style.display === 'block') {
      this.close();
    }
  }

  /**
   * Cierra el panel si el clic ocurrió completamente fuera del componente.
   * Usa composedPath para detectar clics dentro del shadow DOM.
   */
  _onDocumentMouseDown(e) {
    if (this.style.display !== 'block') return;
    if (!e.composedPath().includes(this)) {
      this.close();
    }
  }

  /**
   * Coloca el panel en su posición inicial centrada.
   * Si el usuario ya movió el panel manualmente, no lo reubicamos
   * a menos que se pase forceCenter = true (por ejemplo, al abrir de nuevo).
   * @param {boolean} [forceCenter=false]
   */
  _repositionPanel(forceCenter = false) {
    if (this._positionInitialized && !forceCenter) return;
    this.style.right     = '14px';
    this.style.left      = 'auto';
    this.style.top       = '102px';
    this.style.transform = 'none';
    this._positionInitialized = true;
    this.style.maxWidth      = '600px';
  }

  /**
   * Inicia el drag manual: captura la posición del ratón relativa al panel.
   * @param {MouseEvent} evt
   */
  _startDrag(evt) {
    const rect = this.getBoundingClientRect();
    // Fijamos left/top en píxeles absolutos para desactivar el centrado CSS.
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
   * Mueve el panel durante el drag, manteniéndolo dentro del viewport.
   * @param {MouseEvent} evt
   */
  _onDragMove(evt) {
    if (!this._dragState) return;
    const width    = this.offsetWidth  || 0;
    const height   = this.offsetHeight || 0;
    const nextLeft = evt.clientX - this._dragState.offsetX;
    const nextTop  = evt.clientY - this._dragState.offsetY;
    // Clamp: el panel nunca debe salir del viewport.
    this.style.left = `${Math.max(0, Math.min(nextLeft, window.innerWidth  - width))}px`;
    this.style.top  = `${Math.max(54, Math.min(nextTop,  window.innerHeight - height))}px`;
  }

  /** Finaliza el drag y desregistra los listeners temporales. */
  _onDragEnd() {
    this._dragState = null;
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
  }

  /**
   * Inicia el resize: guarda dimensiones y posición del ratón de partida.
   * @param {MouseEvent} evt
   */
  _startResize(evt) {
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
   * Actualiza el tamaño del panel durante el resize, respetando mínimos y máximos.
   * @param {MouseEvent} evt
   */
  _onResizeMove(evt) {
    if (!this._resizeState) return;
    const minW = 560, minH = 320;
    const maxW = window.innerWidth  - 18;
    const maxH = window.innerHeight - 84;
    const nextW = this._resizeState.startW + (evt.clientX - this._resizeState.startX);
    const nextH = this._resizeState.startH + (evt.clientY - this._resizeState.startY);
    this.style.width  = `${Math.max(minW, Math.min(nextW, maxW))}px`;
    this.style.height = `${Math.max(minH, Math.min(nextH, maxH))}px`;
  }

  /** Finaliza el resize y desregistra los listeners temporales. */
  _onResizeEnd() {
    this._resizeState = null;
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
  }

  /**
   * Resetea el estado interno y la UI al estado vacío inicial.
   * Se llama cada vez que el panel se abre.
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
   * Punto de entrada de la búsqueda, llamado por el debounce del input.
   * Valida la query, ejecuta la búsqueda y coordina el render de ambos paneles.
   * @param {string} term - Texto introducido por el usuario.
   */
  _search(term) {
    const query            = String(term || '').trim();
    const summary          = this.shadowRoot.getElementById('gc__summary');
    const modelsContainer  = this.shadowRoot.getElementById('gc__modelsContainer');
    const resultsContainer = this.shadowRoot.getElementById('gc__resultsContainer');

    // ── Query vacía: volvemos al estado inicial ──
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

    // ── Query demasiado corta: pedimos al menos 3 caracteres ──
    if (query.length < 3) {
      this._flatResults    = [];
      this._activeIndex    = -1;
      this._groupedResults = {};
      this._currentFileKey = '';
      summary.textContent = 'Query too short';
      DomUtils.setHTML(modelsContainer,  `<div class="gc__empty">No files</div>`);
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">Enter at least 3 characters.</div>`);
      return;
    }

    // ── Búsqueda real ──
    const grouped  = this._findAllMatches(query);
    this._groupedResults = grouped;
    const fileNames = Object.keys(grouped);

    if (!fileNames.length) {
      this._currentFileKey = '';
      this._renderModelList();
      this._renderResults(query);
      return;
    }

    // Si el archivo previamente seleccionado ya no existe en los nuevos resultados,
    // seleccionamos automáticamente el primero de la lista.
    if (!this._currentFileKey || !grouped[this._currentFileKey]) {
      this._currentFileKey = fileNames[0];
    }

    this._renderModelList();
    this._renderResults(query);
  }

  /**
   * Busca la query en todos los modelos Monaco abiertos y agrupa las coincidencias por archivo.
   *
   * La clave de cada grupo tiene el formato `"displayName__gc__N"` donde N es el índice
   * del modelo. El sufijo es solo para uso interno y no se muestra en la UI.
   *
   * @param {string} searchText - Texto a buscar (mínimo 3 caracteres).
   * @returns {Object.<string, Array>} Mapa { clave: coincidencias[] }.
   */
  _findAllMatches(searchText) {
    const grouped = {};
    const models  = window.monaco?.editor?.getModels?.() || [];

    models.forEach((model, index) => {
      const matches = model.findMatches(searchText, false, false, false, null, true);
      if (!matches?.length) return;

      const displayName = this._formatModelName(model, index);
      // Sufijo numérico interno para evitar colisiones si dos archivos tienen el mismo nombre.
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
   *
   * Cada ítem muestra:
   *   [contador] nombre-del-archivo
   *
   * El contador aparece primero para que sea siempre visible aunque el nombre
   * quede truncado por el ancho del panel.
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
          title="${this._escapeAttr(displayName)} (${count} coincidencia${count !== 1 ? 's' : ''})"
        >
          <span class="gc__modelCount">${count}</span>${this._escapeHtml(displayName)}
        </button>
      `;
    }).join('');

    DomUtils.setHTML(modelsContainer, html);

    // Al hacer clic en un archivo, actualizamos la columna derecha con sus resultados.
    modelsContainer.querySelectorAll('.gc__modelItem').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._currentFileKey = btn.getAttribute('data-model') || '';
        this._activeIndex = 0;
        this._renderModelList();
        this._renderResults();
      });
    });
  }

  /**
   * Renderiza la lista de coincidencias del archivo actualmente seleccionado.
   * También actualiza el resumen de totales en la barra de metadata.
   * @param {string} [query=''] - Query original (se usa solo para el mensaje de "sin resultados").
   */
  _renderResults(query = '') {
    const summary          = this.shadowRoot.getElementById('gc__summary');
    const resultsContainer = this.shadowRoot.getElementById('gc__resultsContainer');
    const fileNames        = Object.keys(this._groupedResults);

    // ── Sin resultados en ningún archivo ──
    if (!fileNames.length) {
      this._flatResults = [];
      this._activeIndex = -1;
      summary.textContent = `No matches for "${query}"`;
      DomUtils.setHTML(resultsContainer, `<div class="gc__empty">No matches found.</div>`);
      return;
    }

    // Totales globales para la barra de metadata.
    const total = fileNames.reduce((acc, key) => acc + this._groupedResults[key].length, 0);
    summary.textContent = `${total} match(es) in ${fileNames.length} file(s)`;

    // Resultados del archivo seleccionado en el panel izquierdo.
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
            <div class="gc__lineBadge">Line ${item.range.startLineNumber}</div>
            <div class="gc__code">${this._escapeHtml(item.text || '(empty line)')}</div>
          </div>
        `).join('')}
      </section>
    `;
    DomUtils.setHTML(resultsContainer, html);

    // Reconstruimos la lista plana vinculando cada resultado con su nodo DOM,
    // necesario para la navegación por teclado y el scroll automático.
    this._flatResults = [];
    const domItems = Array.from(resultsContainer.querySelectorAll('.gc__item'));
    currentResults.forEach((item, idx) => {
      this._flatResults.push({ ...item, element: domItems[idx] });
    });

    // Clic en una fila: navega directamente al editor.
    this._flatResults.forEach((result, idx) => {
      result.element.addEventListener('click', () => {
        this._activeIndex = idx;
        this._syncActiveStyles();
        this._goTo(result);
      });
    });

    // Aseguramos que el índice activo esté dentro de rango antes de sincronizar estilos.
    if (this._flatResults.length > 0) {
      if (this._activeIndex < 0 || this._activeIndex >= this._flatResults.length) {
        this._activeIndex = 0;
      }
      this._syncActiveStyles();
    }
  }

  /**
   * Mueve el índice activo en la lista plana de resultados.
   * El movimiento se detiene en los extremos (no hace wraparound).
   * @param {number} step - 1 para bajar, -1 para subir.
   */
  _moveSelection(step) {
    if (!this._flatResults.length) return;
    const next = this._activeIndex + step;
    if (next < 0 || next >= this._flatResults.length) return;
    this._activeIndex = next;
    this._syncActiveStyles();
  }

  /**
   * Aplica la clase visual gc__active al resultado activo y hace scroll
   * para mantenerlo visible dentro del contenedor de resultados.
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
   * Es un alias de _goTo sobre el elemento seleccionado.
   */
  _goToActiveResult() {
    if (this._activeIndex < 0 || !this._flatResults[this._activeIndex]) return;
    this._goTo(this._flatResults[this._activeIndex]);
  }

  /**
   * Abre el modelo Monaco correspondiente y hace foco en el rango encontrado.
   *
   * Pasos:
   *   1. Cambia el modelo del editor al archivo que contiene la coincidencia.
   *   2. Selecciona visualmente el rango encontrado.
   *   3. Centra el viewport del editor en ese rango.
   *   4. (Opcional) Actualiza la etiqueta de archivo activo del IDE.
   *
   * @param {{model:object, range:object}} result
   */
  _goTo(result) {
    if (!this._editor || !result?.model || !result?.range) return;

    this._editor.setModel(result.model);
    this._editor.setSelection(result.range);
    this._editor.revealRangeInCenter(result.range);
    this._editor.focus();

    // Actualiza la etiqueta del archivo activo si el IDE la expone en el DOM.
    const fileLabel = document.querySelector('#ctnCurrentFileName');
    if (fileLabel) {
      fileLabel.textContent = this._formatModelName(result.model, 0);
    }
  }

  /**
   * Construye el mapa URI → nombre usando la única información confiable disponible:
   * el orden de los modelos en Monaco vs el orden del árbol DOM del IDE.
   *
   * Dado que las URIs son opacas (inmemory://model/N), el único anclaje
   * confiable es el modelo ACTIVO: el editor nos dice qué modelo está
   * abierto ahora mismo, y el IDE nos dice qué archivo está activo en la UI.
   * Con ese par (URI ↔ nombre) fijado, asignamos el resto por posición
   * excluyendo ese slot de ambas listas.
   */
  _buildUriToNameMap() {
    this._fileNameCacheByModelUri.clear();

    const models   = window.monaco?.editor?.getModels?.() || [];
    const domNames = [...this._fileNamePoolFromDom]; // copia para no mutar

    if (!models.length || !domNames.length) return;

    // ── Ancla: modelo activo en el editor ──
    // Obtenemos la URI del modelo que está abierto en este momento.
    // El IDE muestra su nombre en #ctnCurrentFileName o en el árbol activo.
    let activeUri  = '';
    let activeName = '';

    try {
      const activeModel = this._editor?.getModel?.();
      if (activeModel) {
        activeUri = String(activeModel.uri?.toString?.() || '');
      }
    } catch (_) {}

    // Nombre del archivo activo: buscamos el elemento seleccionado en el árbol del IDE.
    const activeNodeCandidates = [
      // Ítem activo/seleccionado en el árbol de GAS
      document.querySelector(
        'ul.StrnGf-VfPpkd-rymPhb li.StrnGf-VfPpkd-rymPhb-ibnC6b-OWXEXe-XpnDCe,' +
        'ul.StrnGf-VfPpkd-rymPhb li[aria-selected="true"],' +
        '[role="treeitem"][aria-selected="true"],' +
        '[role="treeitem"].selected'
      ),
      // Fallback: etiqueta de nombre de archivo visible en el header del editor
      document.querySelector('#ctnCurrentFileName'),
    ];

    for (const node of activeNodeCandidates) {
      if (!node) continue;
      const raw = (node.textContent || node.getAttribute('aria-label') || '').trim();
      const cleaned = this._normalizeFileLabel(raw);
      if (this._looksLikeRealFileName(cleaned)) {
        activeName = cleaned;
        break;
      }
    }

    // Si tenemos el par (URI activa ↔ nombre activo), lo fijamos en el cache.
    if (activeUri && activeName) {
      this._fileNameCacheByModelUri.set(activeUri, activeName);
    }

    // ── Asignación posicional para el resto ──
    // Construimos listas paralelas excluyendo los slots ya resueltos.
    const remainingModels = models.filter(m => {
      const u = String(m?.uri?.toString?.() || '');
      return !this._fileNameCacheByModelUri.has(u);
    });

    const remainingNames = domNames.filter(n => n !== activeName);

    // Solo asignamos posicionalmente si los conteos coinciden exactamente.
    // Si no coinciden, preferimos "File N" antes que un nombre equivocado.
    if (remainingModels.length === remainingNames.length) {
      remainingModels.forEach((model, i) => {
        const u = String(model?.uri?.toString?.() || '');
        this._fileNameCacheByModelUri.set(u, remainingNames[i]);
      });
    } else {
      remainingModels.forEach((model, i) => {
        const u = String(model?.uri?.toString?.() || '');
        this._fileNameCacheByModelUri.set(u, `File ${i + 1}`);
      });
    }
  }

  /**
   * Devuelve un nombre legible para un modelo Monaco.
   *
   * Estrategia de resolución (en orden de preferencia):
   *   1. Cache por URI (hit rápido, evita recalcular).
   *   2. Basename de la URI si parece un nombre de archivo real (.gs, .json, etc.).
   *   3. Mapa DOM: busca en _fileNameMapFromDom el nombre que coincida con algún
   *      fragmento de la URI (p.ej. "appsscript" en la URI → "appsscript.json").
   *   4. Cualquier nombre del DOM aún no asignado a otro modelo (fallback ordenado).
   *   5. Último recurso: "Model".
   *
   * @param {object} model
   * @param {number} [index=0]
   * @returns {string}
   */
  _formatModelName(model, index = 0) {
    const uriKey = String(
      model?.uri?.toString?.() || model?.uri?._formatted || model?.uri?.path || ''
    );
    if (uriKey && this._fileNameCacheByModelUri.has(uriKey)) {
      return this._fileNameCacheByModelUri.get(uriKey);
    }
    // Si por alguna razón no está en cache (modelo añadido después de abrir),
    // intentamos el basename directo de la URI.
    const rawPath = String(model?.uri?.path || model?.uri?._formatted || '');
    if (rawPath) {
      const parts    = rawPath.split('/').filter(Boolean);
      const baseName = parts[parts.length - 1] || '';
      if (this._looksLikeRealFileName(baseName)) return baseName;
    }
    return `File ${index + 1}`;
  }

  /**
   * Construye el mapa URI → nombre haciendo click UNA SOLA VEZ por sesión.
   * El resultado se persiste en sessionStorage para que reabrir el panel
   * no vuelva a simular clicks.
   */
  async _buildFullModelMapFromClicks() {
    const models = window.monaco?.editor?.getModels?.() || [];
    const items  = Array.from(document.querySelectorAll('li[role="option"][data-res-id]'));
    console.log(items);
    console.log(models);
    const fileNames = items
      .map(li => (li.getAttribute('aria-label') || '').trim())
      .filter(name => this._looksLikeRealFileName(name));
    console.log(fileNames);
    const map = new Map();
  
    for (const model of models) {
      const uri = model.uri.toString();
      const content = model.getValue();
      console.log(uri);
      console.log(content);
  
      // Heurística básica para detectar nombre
      const match = fileNames.find(name => {
        if (name.endsWith('.gs')) {
          // Buscar funciones típicas
          return content.includes('function') || content.includes('const');
        }
        if (name.endsWith('.html')) {
          return content.includes('<html') || content.includes('<div');
        }
        if (name === 'appsscript.json') {
          return content.includes('"timeZone"') || content.includes('"dependencies"');
        }
        return false;
      });
  
      if (match && ![...map.values()].includes(match)) {
        map.set(uri, match);
      }
    }
  
    this._fileNameCacheByModelUri = map;
    console.log("RUBENCHO");
    console.log(map);
  }

  /**
   * Observa cambios en el árbol de archivos del IDE (agregar, eliminar, renombrar).
   * Cuando detecta cambios, reconstruye el cache de nombres.
   */
  _setupFileTreeObserver() {
    // Contenedor del árbol de archivos
    const tree = document.querySelector('ul.StrnGf-VfPpkd-rymPhb');
    if (!tree) return; // Si no existe, no hacemos nada

    // Creamos un observer para detectar cambios en el DOM
    const observer = new MutationObserver(() => {
      console.log('🔄 Cambios en archivos detectados');

      // Evita ejecutar múltiples veces seguidas (debounce)
      clearTimeout(this._treeDebounce);
      this._treeDebounce = setTimeout(() => {

        // Invalida el cache para forzar reconstrucción en la próxima apertura
        try { sessionStorage.removeItem('gas_search_uri_map'); } catch (_) {}

        // Refresca lista de nombres desde el DOM
        this._refreshFileNameCacheFromDom();

        // Reconstruye el mapa completo URI → nombre
        this._buildFullModelMapFromClicks();

      }, 500); // espera 500ms después del último cambio
    });

    // Observa cambios en hijos y subárbol completo
    observer.observe(tree, {
      childList: true,
      subtree: true
    });

    // Guardamos referencia para poder desconectarlo después
    this._treeObserver = observer;
  }

  /**
   * Lee el árbol del DOM, llena _fileNamePoolFromDom y dispara _buildUriToNameMap.
   */
  _refreshFileNameCacheFromDom() {
    const selectors = [
      'ul.StrnGf-VfPpkd-rymPhb.StrnGf-VfPpkd-rymPhb-OWXEXe-EzIYc.Fcw6db.GFlqGb li',
      '[role="tree"] [role="treeitem"]',
      '[role="treeitem"]',
      '[aria-label*=".gs"], [aria-label*=".js"], [aria-label*=".json"], [aria-label*=".html"]',
    ];

    const names = [];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((node) => {
        const rawText = (node.textContent || node.getAttribute('aria-label') || '').trim();
        if (!rawText) return;
        const cleanName = this._normalizeFileLabel(rawText);
        if (!this._looksLikeRealFileName(cleanName)) return;
        names.push(cleanName);
      });
    });

    this._fileNamePoolFromDom = Array.from(new Set(names));
    this._buildUriToNameMap();
  }

  /**
   * Determina si una cadena tiene aspecto de nombre real de archivo.
   * Acepta .gs, .js, .ts, .json, .html, .css, .md, .txt
   * Incluye explícitamente "appsscript.json" como nombre válido.
   */
  _looksLikeRealFileName(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/^model\s*\d+$/i.test(text)) return false;
    // Acepta cualquier nombre con extensión reconocida, incluido appsscript.json.
    return /\.(gs|js|ts|json|html|css|md|txt)$/i.test(text);
  }

  /**
   * Limpia un texto tomado del árbol del DOM para obtener solo el nombre de archivo.
   *
   * - Elimina espacios múltiples.
   * - Elimina textos de estado como "cargando…" o "loading…".
   * - Extrae el primer token con extensión válida si lo hay.
   * - Elimina caracteres no alfanuméricos del resultado final.
   *
   * @param {string} label - Texto crudo del nodo del árbol.
   * @returns {string} Nombre limpio.
   */
  _normalizeFileLabel(label) {
    const normalized = String(label || '')
      .replace(/\s+/g, ' ')
      .replace(/cargando…?/gi, '')
      .replace(/loading…?/gi, '')
      .trim();

    // Preferimos el primer token que tenga extensión de archivo reconocida.
    const match = normalized.match(/([A-Za-z0-9 _.-]+\.(gs|js|ts|json|html|css|md|txt))/i);
    if (match?.[1]) return match[1].trim();

    return normalized.replace(/[^\w.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Determina si una cadena tiene aspecto de nombre real de archivo.
   *
   * Descarta:
   * - Cadenas vacías.
   * - Texto genérico como "Model 1", "Model 2".
   * Acepta cualquier nombre con extensión de Apps Script o web.
   *
   * @param {string} value
   * @returns {boolean}
   */
  _looksLikeRealFileNameOLD(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/^model\s*\d+$/i.test(text)) return false;
    return /\.(gs|js|ts|json|html|css|md|txt)$/i.test(text);
  }

  /**
   * Escapa caracteres especiales HTML para inserción segura en innerHTML.
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
   * Escapa caracteres HTML más comillas dobles, para uso en atributos HTML.
   * @param {string} value
   * @returns {string}
   */
  _escapeAttr(value) {
    return this._escapeHtml(value).replace(/"/g, '&quot;');
  }
}

if (!customElements.get('gas-search-panel')) {
  customElements.define('gas-search-panel', GasSearchPanel);
}