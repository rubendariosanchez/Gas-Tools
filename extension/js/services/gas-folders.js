"use strict";
/**
 * @fileoverview gas-folders.js
 *
 * Implementa una estructura de carpetas nativa (Material Design) con visualización de árbol punteada.
 * Gestiona actualizaciones dinámicas por creación, eliminación o renombrado de archivos.
 * Íconos de archivo diferenciados por extensión: .gs, .html, .json y genérico.
 */
/**
 * @class GasFolders
 * @classdesc Componente principal que transforma la lista plana de archivos del IDE de
 * Google Apps Script en un árbol visual de carpetas con estética Material Design.
 * Observa el DOM mediante {@link MutationObserver} para mantener la estructura
 * sincronizada con los cambios que realiza GAS sobre el `<ul role="listbox">`.
 *
 * @example
 * const folders = new GasFolders();
 * folders.setColor('#1a73e8');
 * folders.enable();
 */
class GasFolders {
  /** @type {string} Clase aplicada al `<li>` que representa una carpeta. */
  static FOLDER_CLASS          = 'qc__folder-item';
  /** @type {string} Clase del encabezado clickeable de la carpeta (chevron + ícono + label). */
  static FOLDER_HEADER_CLASS   = 'qc__folder-header';
  /** @type {string} Clase del contenedor de hijos de una carpeta. */
  static FOLDER_CHILDREN_CLASS = 'qc__folder-children';
  /** @type {string} Clase del `<span>` que envuelve el SVG de ícono de carpeta. */
  static FOLDER_ICON_WRAPPER   = 'qc__folder-icon-wrapper';
  /** @type {string} Clase del `<span>` que contiene el chevron de colapso. */
  static FOLDER_CHEVRON_CLASS  = 'qc__folder-chevron';
  /** @type {string} Clase aplicada al `<li>` de carpeta cuando está colapsada. */
  static COLLAPSED_CLASS       = 'qc__folder-collapsed';
  /** @type {string} Clase del `<span>` que envuelve el ícono SVG de un archivo. */
  static FILE_ICON_CLASS       = 'qc__file-icon';
  /** SVG del chevron de colapso/expansión (estilo outline). */
  static SVG_CHEVRON     = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;

  /** SVG de carpeta cerrada en formato sólido. */
  static SVG_FOLDER      = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;

  /** SVG de carpeta abierta en estilo outline. */
  static SVG_FOLDER_OPEN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"/><path d="M3 9h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/></svg>`;

  /**
   * Plantilla común: página de contorno con esquina doblada. El interior se
   * inyecta como argumento, en coordenadas del viewBox 0 0 16 16.
   * @param {string} color   Color del contorno y del símbolo interior.
   * @param {string} content Markup SVG del símbolo (paths, lines, circles, etc.).
   * @returns {string}
   * @private
   */
  static _filePageSvg(color, content) {
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">` +
      `<path d="M3 2h6.5L13 5.5V14H3z" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>` +
      `<path d="M9.5 2v3.5H13" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `${content}</svg>`;
  }

  /**
   * Número máximo de intentos para localizar el `<ul role="listbox">` raíz
   * antes de abandonar la escucha. Evita un loop infinito si GAS nunca monta
   * la lista (p. ej. en una URL que no corresponde al editor de scripts).
   * @type {number}
   */
  static MAX_RETRY_ATTEMPTS = 30;   // 30 × rAF ≈ ~500 ms máximo de espera
  /**
   * Milisegundos entre cada reintento de localización del `<ul>` raíz.
   * @type {number}
   */
  static RETRY_INTERVAL_MS  = 500;
  /**
   * Inicializa el estado interno del componente.
   * No realiza ninguna operación sobre el DOM; las mutaciones comienzan
   * con {@link GasFolders#enable}.
   */
  constructor() {
    /** @type {boolean} Indica si el componente está activo y procesando el DOM. */
    this._enabled        = false;
    /**
     * Observer principal que escucha cambios en el `<ul>` raíz y en `document.body`.
     * Se desconecta durante cada rebuild para que los movimientos de nodos propios
     * no disparen nuevas rondas de reconstrucción.
     * @type {MutationObserver|null}
     */
    this._observer       = null;
    /**
     * Observer auxiliar sobre `document.body` con `subtree: true` para detectar
     * cuándo GAS reemplaza por completo el `<ul>` raíz durante una navegación SPA.
     * Las mutaciones originadas en nodos propios del componente (clases `qc__`)
     * se filtran dentro del callback para evitar loops de rebuild.
     * @type {MutationObserver|null}
     */
    this._docObserver    = null;
    /**
     * Referencias a los `<ul role="listbox">` que contienen los ítems de archivo de GAS.
     * @type {HTMLUListElement[]}
     */
    this._rootLists      = [];
    /**
     * Bandera de guardia que previene reentradas en {@link GasFolders#_rebuildFullTree}.
     * @type {boolean}
     */
    this._isRebuilding   = false;
    /**
     * ID del `setTimeout` pendiente para el próximo rebuild debounceado.
     * @type {ReturnType<setTimeout>|null}
     */
    this._rebuildTimeout = null;
    /**
     * Color CSS usado para los íconos de carpeta. Se puede sobreescribir con
     * {@link GasFolders#setColor} antes o después de habilitar el componente.
     * @type {string}
     */
    this._folderColor    = '#5f6368';
    /**
     * Mapa de colores por extensión de archivo. Se puede actualizar con
     * {@link GasFolders#setFileColors} para personalizar cada tipo desde
     * el popup. Las extensiones no listadas usan el color del icono genérico.
     * @type {{gs:string, html:string, json:string, generic:string}}
     */
    this._fileColors     = {
      gs:      '#4086f4',
      html:    '#fc490b',
      json:    '#1bb24b',
      generic: '#9aa0a6',
    };
    /**
     * Contador de intentos acumulados para localizar el `<ul>` raíz.
     * Se resetea a 0 cada vez que se encuentra exitosamente.
     * @type {number}
     */
    this._retryCount     = 0;
    /**
     * ID del `setTimeout` activo del ciclo de retry, o `null` si no hay ninguno.
     * @type {ReturnType<setTimeout>|null}
     */
    this._retryTimer     = null;
    /**
     * Cola de configuraciones pendientes que llegaron vía `GAS_TransferData`
     * antes de que el DOM estuviera listo (race condition entre el evento
     * de datos y el montaje de la UI de GAS).
     * @type {Array<{color?:string, enable:boolean}>}
     */
    this._pendingApply   = null;
    /**
     * Bandera que indica que al menos una mutación del DOM llegó mientras
     * `_isRebuilding` estaba activo y fue descartada. Al finalizar el rebuild
     * se programa un nuevo ciclo para no perder esos cambios.
     * @type {boolean}
     */
    this._dirtyDuringRebuild = false;
  }
  /**
   * Actualiza el color de los íconos de carpeta y regenera los estilos CSS
   * si el componente ya está activo.
   *
   * @param {string} color - Valor CSS válido (hex, rgb, variable, etc.).
   *   Si es falsy la llamada no tiene efecto.
   * @returns {void}
   */
  setColor(color) {
    if (!color) return;
    this._folderColor = color;
    if (this._enabled) this._updateStyles_();
  }

  /**
   * Actualiza uno o varios colores de iconos de archivo. Acepta un objeto
   * parcial: `{ gs?: string, html?: string, json?: string, generic?: string }`.
   * Tras actualizar fuerza un rebuild para que los SVG ya inyectados se
   * vuelvan a generar con los nuevos colores.
   *
   * @param {{gs?:string, html?:string, json?:string, generic?:string}} colors
   * @returns {void}
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
      // Forzamos un rebuild para que los SVG ya inyectados se regeneren.
      if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
      this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 50);
    }
  }
  /**
   * Habilita el componente: inyecta los estilos CSS, arranca la observación
   * del DOM y construye el árbol de carpetas inicial.
   * Es idempotente: llamarlo múltiples veces sólo inyecta los estilos una vez.
   *
   * @returns {void}
   */
  enable() {
    if (!this._enabled) {
      this._enabled = true;
      this._injectStyles();
    }
    this._startObserving();
    this._rebuildFullTree();
  }
  /**
   * Deshabilita el componente: desconecta todos los observers, cancela timers
   * pendientes y restaura el `<ul>` a su estado original (lista plana sin carpetas).
   * Seguro de llamar aunque el componente ya esté deshabilitado.
   *
   * @returns {void}
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._stopRetry();
    // Desconectar y liberar ambos observers para evitar memory leaks
    if (this._observer)    { this._observer.disconnect();    this._observer    = null; }
    if (this._docObserver) { this._docObserver.disconnect(); this._docObserver = null; }
    if (this._rebuildTimeout) { clearTimeout(this._rebuildTimeout); this._rebuildTimeout = null; }
    this._restoreOriginalList();
    // Vaciar después de restaurar para que el bucle tenga datos
    this._rootLists = [];
  }
  /**
   * Detecta si el editor de GAS está usando un tema oscuro.
   * Primero comprueba la clase CSS oficial del IDE; si no existe, analiza
   * el color de fondo del `<body>` calculando su luminancia percibida
   * (fórmula estándar ITU-R BT.601).
   *
   * @private
   * @returns {boolean} `true` si el tema es oscuro, `false` si es claro.
   */
  _isEditorDark_() {
    if (document.body.classList.contains('ide-dark-mode')) return true;
    const bg  = window.getComputedStyle(document.body).backgroundColor;
    const rgb = bg.match(/\d+/g);
    if (!rgb || rgb.length < 3) return false;
    const [r, g, b] = rgb.map(Number);
    // Luminancia percibida: < 0.5 → color oscuro
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
  }
  /**
   * Punto de entrada para la primera inyección de estilos.
   * Delega directamente en {@link GasFolders#_updateStyles_} para reutilizar
   * la lógica de creación/actualización del `<style>` existente.
   *
   * @private
   * @returns {void}
   */
  _injectStyles() { this._updateStyles_(); }
  /**
   * Crea (o actualiza) el elemento `<style id="gas-folders-styles">` en el `<head>`.
   * Calcula las variables CSS según el tema activo (claro/oscuro) y el color
   * de carpeta configurado, y vuelca la hoja de estilos completa del componente.
   *
   * Llamar este método en cualquier momento actualiza los estilos al vuelo
   * sin necesidad de recargar la página (útil al cambiar tema o color).
   *
   * @private
   * @returns {void}
   */
  _updateStyles_() {
    // Reutilizar el <style> existente si ya fue inyectado, para no duplicarlo
    let style = document.getElementById('gas-folders-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'gas-folders-styles';
      document.head.appendChild(style);
    }
    const lineOpacity = 0.3;
    const dark        = this._isEditorDark_();
    // Color de las líneas punteadas del árbol, semi-transparente sobre cualquier fondo
    const lineColor   = dark
      ? `rgba(255,255,255,${lineOpacity})`
      : `rgba(0,0,0,${lineOpacity})`;
    style.textContent = `
      :root {
        --qc-folder-color : ${this._folderColor};
        --qc-tree-line    : ${lineColor};
      }
      /* Ocultar el ícono original de GAS para cada ítem de archivo;
         se reemplaza por nuestros SVGs inyectados. Las múltiples reglas
         cubren distintas estructuras HTML que GAS puede emitir. */
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
      /* Ocultar los hijos de una carpeta colapsada */
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
      /* Línea vertical punteada del árbol (pseudo-elemento ::before de cada ítem hijo) */
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
      /* El último hijo acorta la línea vertical para que no sobrepase el conector horizontal */
      .${GasFolders.FOLDER_CHILDREN_CLASS} > li:last-child::before {
        height : 18px;
        bottom : auto;
      }
      /* Conector horizontal punteado que une la línea vertical con el ítem */
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
      /* Rotar el chevron −90° cuando la carpeta está colapsada */
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
        /* Contrarrestar el display:hidden global aplicado a íconos de GAS */
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
      /* Ocultamos el texto de GAS para no pelear con el DOM Virtual y evitar el loop.
         El nombre visible se muestra exclusivamente a través del pseudo-elemento ::before
         alimentado por data-name, sin tocar el textContent que GAS gestiona. */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title] {
        color: transparent !important;
        position: relative;
      }
      /* Mostramos el nombre corto mediante un pseudo-elemento */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title]::before {
        content: attr(data-name);
        position: absolute;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        color: var(--gm3-sys-color-on-surface, ${dark ? '#e8eaed' : '#202124'});
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* Cuando se renombra un archivo, ocultamos el pseudo-elemento */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li.qc-renaming div[title]::before {
        display: none !important;
      }
      /* Aseguramos que el input inyectado por GAS sea visible */
      .${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"] div[title] input {
        color: var(--gm3-sys-color-on-surface, inherit) !important;
      }
    `;
  }
  /**
   * Cancela el timer de retry activo y resetea el contador de intentos.
   * Debe llamarse siempre que el `<ul>` sea encontrado exitosamente o cuando
   * el componente se deshabilite, para no dejar timers huérfanos.
   *
   * @private
   * @returns {void}
   */
  _stopRetry() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryCount = 0;
  }
  /**
   * Localiza los `<ul role="listbox">` de GAS y conecta los MutationObservers.
   *
   * @private
   */
  _startObserving() {
    if (!this._enabled) return;
    const uls = Array.from(document.querySelectorAll('ul[role="listbox"]'));
    // Garantizar que los UL estén cargados: deben tener al menos un li[role="option"]
    const validUls = uls.filter(ul => ul.querySelector('li[role="option"]'));
    if (validUls.length === 0) {
      this._retryCount++;
      if (this._retryCount > GasFolders.MAX_RETRY_ATTEMPTS) {
        console.warn('[GasFolders] Ningún <ul role="listbox"> válido encontrado tras',
          GasFolders.MAX_RETRY_ATTEMPTS, 'intentos. Se detiene el retry.');
        return;
      }
      // Usar requestAnimationFrame para alinear el reintento con el ciclo de render
      requestAnimationFrame(() => this._startObserving());
      return;
    }
    this._stopRetry();
    // Comprobar si hay cambios en la lista de ULs para evitar reconexiones innecesarias
    const ulsChanged = validUls.length !== this._rootLists.length ||
                       validUls.some((ul, i) => ul !== this._rootLists[i]);
    if (!ulsChanged && this._observer) return;
    this._rootLists = validUls;
    // Desconectar ambos observers antes de reconectar con la nueva lista de ULs
    if (this._observer)    this._observer.disconnect();
    if (this._docObserver) this._docObserver.disconnect();
    // ── Observer principal ────────────────────────────────────────────────
    this._observer = new MutationObserver((mutations) => {
      // Guard: no actuar si el componente fue deshabilitado
      if (!this._enabled) return;
      // Cambio de clase en body → posible cambio de tema claro/oscuro
      const themeChanged = mutations.some(
        m => m.target === document.body && m.attributeName === 'class'
      );
      if (themeChanged) this._updateStyles_();
      // Cambio estructural o de atributo title que requiere rebuild.
      // Se ignoran mutaciones cuyos targets son nodos estructurales del componente
      // (header, chevron, icon wrapper, children container) para no disparar rebuilds
      // por acciones del propio usuario como colapsar/expandir carpetas.
      // Los li[role="option"] dentro de carpetas NO se ignoran porque sus cambios
      // de title (renombrado por GAS) sí deben desencadenar una reconstrucción.
      const ownStructuralClasses = [
        GasFolders.FOLDER_HEADER_CLASS,
        GasFolders.FOLDER_CHEVRON_CLASS,
        GasFolders.FOLDER_ICON_WRAPPER,
        GasFolders.FOLDER_CHILDREN_CLASS,
        GasFolders.FILE_ICON_CLASS,
      ];
      const needsUpdate = mutations.some(m => {
        const el = /** @type {Element} */ (m.target);
        // Ignorar si el target es un nodo estructural propio o está dentro de uno
        const isOwnStructural = ownStructuralClasses.some(cls => el.closest?.(`.${cls}`));
        // Excepciones: li[role="option"] dentro de carpetas sí interesan
        const isGasItem = el.closest?.('li[role="option"]');
        if (isOwnStructural && !isGasItem) return false;
        return m.type === 'childList' ||
               (m.type === 'attributes' && m.attributeName === 'title');
      });
      if (needsUpdate) {
        if (this._isRebuilding) {
          // Registra mutaciones concurrentes para programar una reconstrucción
          // adicional al finalizar el ciclo actual
          this._dirtyDuringRebuild = true;
          return;
        }
        // Debounce de 100 ms para agrupar ráfagas de mutaciones consecutivas
        if (this._rebuildTimeout) clearTimeout(this._rebuildTimeout);
        this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 100);
      }
    });
    // Observar cada <ul> para cambios estructurales y de atributo title
    this._rootLists.forEach(ul => {
      this._observer.observe(ul, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['title']
      });
    });
    // Observar document.body para detectar cambios de tema (cambio de clase CSS)
    this._observer.observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });
    // Observa body con subtree para capturar reemplazos SPA
    this._docObserver = new MutationObserver((mutations) => {
      // Guard: no actuar si el componente fue deshabilitado
      if (!this._enabled) return;
      // Ignorar mutaciones cuyo target pertenece a nodos creados por este componente
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
   * Recorre todos los archivos y los reorganiza en una jerarquía de carpetas
   * basándose en su atributo `title` ("carpeta/archivo").
   *
   * @private
   */
  _rebuildFullTree() {
    if (!this._enabled || !this._rootLists || this._rootLists.length === 0 || this._isRebuilding) {
      return;
    }
    this._isRebuilding       = true;
    this._dirtyDuringRebuild = false;
    // Desconectar ambos observers para que los movimientos de nodos propios
    // no disparen nuevas rondas de rebuild durante la reconstrucción
    if (this._observer)    this._observer.disconnect();
    if (this._docObserver) this._docObserver.disconnect();
    try {
      this._rootLists.forEach((ul, index) => {
        // Restaurar siempre antes de reconstruir para partir de un estado limpio;
        // esto garantiza que _restoreList trabaje solo con hijos directos del UL
        this._restoreList(ul);
        // Leer solo los hijos directos del UL (no el subárbol) para evitar
        // procesar ítems que ya están dentro de carpetas construidas anteriormente
        const items = Array.from(ul.children)
          .filter(li => li.getAttribute('role') === 'option');
        items.forEach(item => {
          const titleDiv = item.querySelector('div[title]');
          if (!titleDiv) return;
          const fullPath = titleDiv.getAttribute('title');
          if (!fullPath || !fullPath.includes('/')) {
            // Ítem en la raíz: no requiere carpeta, solo actualizar etiqueta e ícono
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
      // Siempre liberar la bandera de guardia y reconectar observers,
      // incluso si se produjo una excepción durante la reconstrucción
      this._isRebuilding = false;
      this._reconnectObserver();
      this._reconnectDocObserver();
      // Si llegaron mutaciones de GAS mientras reconstruíamos, programar otra vuelta
      if (this._dirtyDuringRebuild) {
        this._dirtyDuringRebuild = false;
        this._rebuildTimeout = setTimeout(() => this._rebuildFullTree(), 100);
      }
    }
  }
  /**
   * Reconecta el observer principal (`_observer`) a cada `<ul>` raíz y a `document.body` tras un rebuild.
   *
   * @private
   * @returns {void}
   */
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
  /**
   * Reconecta el observer auxiliar (`_docObserver`) a `document.body` tras un rebuild.
   *
   * @private
   * @returns {void}
   */
  _reconnectDocObserver() {
    if (!this._enabled || !this._docObserver) return;
    this._docObserver.observe(document.body, { childList: true, subtree: true });
  }
  /**
   * Devuelve el `<li>` de carpeta para la ruta indicada, creando los nodos
   * intermedios que no existan (creación recursiva de carpetas anidadas).
   *
   * Cada carpeta recibe un `id` determinista basado en su ruta completa
   * para poder localizarla en el DOM sin necesidad de recorrerlo.
   *
   * @private
   * @param {HTMLUListElement} ul      - Lista raíz donde se insertará la carpeta.
   * @param {string}           path    - Ruta de carpeta con segmentos separados por `/`.
   *   Ejemplo: `"utils/helpers"`.
   * @param {number}           ulIndex - Índice del UL en `_rootLists`, usado para
   *   generar IDs únicos cuando hay múltiples listas.
   * @returns {HTMLLIElement} El elemento `<li>` de la carpeta hoja de la ruta.
   */
  _getOrCreateFolder(ul, path, ulIndex) {
    const parts = path.split('/');
    let currentParent = ul;
    let currentPath   = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      // El ID incluye el índice del UL para evitar colisiones si hay múltiples listas
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
   * Crea y devuelve un nuevo `<li>` de carpeta con su estructura interna completa:
   * encabezado (chevron + ícono + label) y contenedor de hijos.
   * También registra el handler de click para colapsar/expandir.
   *
   * @private
   * @param {string} name - Nombre visible de la carpeta (segmento final de la ruta).
   * @param {string} id   - Valor del atributo `id` HTML que se asignará al `<li>`.
   * @returns {HTMLLIElement} Elemento `<li>` listo para insertar en el DOM.
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
    label.style.flex = '1'; // El label ocupa todo el espacio restante del flexbox
    header.appendChild(chevron);
    header.appendChild(iconWrapper);
    header.appendChild(label);
    const children = document.createElement('div');
    children.className = GasFolders.FOLDER_CHILDREN_CLASS;
    // Toggle colapso/expansión al hacer click en el encabezado
    header.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation(); // Evitar que GAS procese el click como selección de ítem
      const collapsed = li.classList.toggle(GasFolders.COLLAPSED_CLASS);
      // Cambiar el SVG de ícono según el nuevo estado
      DomUtils.setHTML(iconWrapper, collapsed ? GasFolders.SVG_FOLDER : GasFolders.SVG_FOLDER_OPEN);
    };
    li.appendChild(header);
    li.appendChild(children);
    return li;
  }
  /**
   * Actualiza el atributo `data-name` y el `aria-label` de un ítem de archivo
   * para mostrar solo su nombre corto (sin la ruta).
   *
   * Deliberadamente **no modifica `textContent`** del `div[title]`, ya que GAS
   * gestiona ese nodo con su propio reconciliador y cualquier escritura dispararía
   * una mutación que provocaría un loop de rebuild. El nombre visible se delega
   * al pseudo-elemento CSS `::before { content: attr(data-name) }`.
   *
   * @private
   * @param {HTMLLIElement} item      - Elemento `<li role="option">` a actualizar.
   * @param {string}        shortName - Nombre corto del archivo (sin ruta).
   * @returns {void}
   */
  _updateItemLabel(item, shortName) {
    const titleDiv = item.querySelector('div[title]');
    if (titleDiv) {
      // Actualizar solo data-name (alimenta el pseudo-elemento CSS ::before).
      // NO tocar textContent: GAS lo reconcilia y dispararía mutaciones → loop.
      if (titleDiv.getAttribute('data-name') !== shortName) {
        titleDiv.setAttribute('data-name', shortName);
      }
      // Gestionar la clase qc-renaming para ocultar el pseudo-elemento durante
      // una operación de renombrado activa (cuando GAS inyecta un <input>)
      item.classList.toggle('qc-renaming', !!item.querySelector('input'));
    }
    // Actualizar aria-label para consistencia de accesibilidad
    const ariaLabel = item.getAttribute('aria-label');
    if (ariaLabel && ariaLabel !== shortName) {
      item.setAttribute('aria-label', shortName);
    }
  }
  /**
   * Determina el SVG apropiado para un archivo según su extensión, usando
   * los colores configurables guardados en `_fileColors`. Las extensiones
   * sin entrada específica caen al icono genérico.
   *
   * @private
   * @param {string} fileName Nombre del archivo incluyendo extensión.
   * @returns {string} Cadena SVG lista para insertar.
   */
  _getFileIcon(fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    if (ext === 'gs')   return this._renderFileSvg_('gs');
    if (ext === 'html') return this._renderFileSvg_('html');
    if (ext === 'json') return this._renderFileSvg_('json');
    return this._renderFileSvg_('generic');
  }

  /**
   * Construye el SVG del icono para un tipo de archivo concreto, leyendo
   * el color desde `_fileColors[type]` para que los cambios desde el popup
   * se reflejen inmediatamente en el próximo render.
   *
   * @private
   * @param {'gs'|'html'|'json'|'generic'} type
   * @returns {string}
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
   * Inserta el `<span>` con el ícono SVG del archivo directamente antes del
   * `div[title]` dentro del ítem. Si el ícono ya fue inyectado en una ejecución
   * anterior, no hace nada (idempotente).
   *
   * @private
   * @param {HTMLLIElement} item     - Elemento `<li role="option">` donde inyectar.
   * @param {string}        fileName - Nombre del archivo para determinar el ícono.
   * @returns {void}
   */
  _injectFileIcon(item, fileName) {
    // Guard: evitar inyectar duplicados si el ícono ya existe
    if (item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)) return;
    const wrapper = document.createElement('span');
    wrapper.className = GasFolders.FILE_ICON_CLASS;
    DomUtils.setHTML(wrapper, this._getFileIcon(fileName));
    const labelDiv = item.querySelector('div[title]');
    if (labelDiv) {
      // Insertar justo antes del div de texto para mantener el orden visual
      item.insertBefore(wrapper, labelDiv);
    } else {
      item.insertBefore(wrapper, item.firstChild);
    }
  }
  /**
   * Elimina del DOM las carpetas que hayan quedado vacías después de un rebuild.
   * Procesa el array en orden inverso (hojas antes que padres) para garantizar
   * que al eliminar una subcarpeta vacía, la carpeta padre también pueda
   * evaluarse correctamente en la misma pasada.
   *
   * @private
   * @returns {void}
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
   * Revierte el DOM al estado original de GAS: mueve todos los ítems de vuelta
   * al `<ul>` raíz, elimina los nodos de carpeta creados por este componente
   * y elimina los íconos SVG inyectados. También elimina el `<style>` inyectado.
   *
   * @private
   * @returns {void}
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
   * Restaura un `<ul>` específico a su estado plano original:
   * - Mueve los `<li role="option">` anidados en carpetas de vuelta al `<ul>` raíz.
   * - Elimina todos los nodos de carpeta (`FOLDER_CLASS`) creados por este componente.
   * - Elimina los `<span>` de ícono (`FILE_ICON_CLASS`) inyectados en cada ítem.
   *
   * No modifica `textContent` ni el atributo `title` de los ítems; GAS conserva
   * el `title` con la ruta completa en todo momento y ese valor es la fuente de
   * verdad para el siguiente rebuild.
   *
   * @private
   * @param {HTMLUListElement} ul - El elemento `<ul>` a restaurar.
   */
  _restoreList(ul) {
    // Mover ítems anidados de vuelta al UL raíz antes de eliminar las carpetas
    Array.from(
      ul.querySelectorAll(`.${GasFolders.FOLDER_CHILDREN_CLASS} li[role="option"]`)
    ).forEach(item => ul.appendChild(item));
    // Eliminar todos los nodos de carpeta generados por el componente
    Array.from(ul.querySelectorAll(`.${GasFolders.FOLDER_CLASS}`))
      .forEach(f => f.remove());
    // Eliminar los íconos SVG inyectados para que el siguiente rebuild los regenere
    Array.from(ul.querySelectorAll('li[role="option"]')).forEach(item => {
      item.querySelector(`.${GasFolders.FILE_ICON_CLASS}`)?.remove();
    });
  }
}
;(function() {
  const folders = new GasFolders();
  // Exponemos la instancia para que otros componentes (popover de archivo
  // activo, paneles, etc.) puedan reutilizar sus iconos SVG y los colores
  // configurados sin replicar lógica.
  if (typeof window !== 'undefined') window.gasFolders = folders;
  /**
   * Bandera que indica si la configuración inicial ya fue aplicada desde
   * `GAS_TransferData`. Impide que navegaciones SPA posteriores (que vuelven
   * a emitir el evento con los ajustes guardados) sobreescriban el estado
   * que el usuario modificó en runtime mediante `GAS_SettingsUpdated`.
   * @type {boolean}
   */
  let initialConfigApplied = false;
  /**
   * Escucha el evento inicial de configuración emitido por la extensión.
   * Se dispara una vez por carga de página con todos los ajustes guardados.
   * En navegaciones SPA posteriores el evento puede volver a emitirse, pero
   * el guard `initialConfigApplied` garantiza que solo la primera emisión
   * configure el componente; las siguientes se ignoran para no pisar cambios
   * hechos por el usuario en runtime.
   *
   * @listens document#GAS_TransferData
   * @param {CustomEvent} e - Evento con `detail` = JSON string de configuración.
   */
  document.addEventListener('GAS_TransferData', (e) => {
    if (initialConfigApplied) {
      return;
    }
    initialConfigApplied = true;
    try {
      const data     = JSON.parse(e.detail);
      const settings = data.settings || {};
      if (settings['gas-folders']) {
        if (settings['gas-folders-color']) {
          folders.setColor(settings['gas-folders-color']);
        }
        // Aplicar colores de archivo personalizados desde el popup.
        folders.setFileColors({
          gs:   settings['gas-file-gs-color'],
          html: settings['gas-file-html-color'],
          json: settings['gas-file-json-color'],
        });
        folders.enable();
      }
      // Si gas-folders es false, el componente permanece deshabilitado (estado inicial)
    } catch (err) {
      console.warn('[GasFolders] Error en GAS_TransferData:', err);
    }
  });
  /**
   * Escucha cambios de configuración en tiempo real desde el popup.
   * Maneja: toggle del componente, color de carpeta, colores de archivos
   * y el apagado global de la extensión.
   *
   * @listens document#GAS_SettingsUpdated
   * @param {CustomEvent} e - Evento con `detail` = JSON string de opciones modificadas.
   */
  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('gas-folders' in options) {
        options['gas-folders'] ? folders.enable() : folders.disable();
      }
      if ('gas-folders-color' in options) {
        folders.setColor(options['gas-folders-color']);
        // Si el componente ya está activo, refrescar el árbol para aplicar
        // el nuevo color inmediatamente sin esperar a una mutación del DOM
        if (folders._enabled && folders._rootLists && folders._rootLists.length > 0) {
          if (folders._rebuildTimeout) clearTimeout(folders._rebuildTimeout);
          folders._rebuildTimeout = setTimeout(() => folders._rebuildFullTree(), 50);
        }
      }
      // Colores de archivos por extensión: cualquiera de las tres claves
      // dispara un setFileColors parcial (solo se aplica lo presente).
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
      // Apagado global de la extensión: deshabilitar sin importar el estado actual
      if ('global-enable' in options && !options['global-enable']) {
        folders.disable();
      }
    } catch (err) {
      console.warn('[GasFolders] Error en GAS_SettingsUpdated:', err);
    }
  });
  /**
   * Escucha el evento de desactivación global de la extensión.
   * Equivalente a recibir `global-enable: false` en `GAS_SettingsUpdated`,
   * pero emitido como evento independiente para mayor simplicidad en otros módulos.
   *
   * @listens document#GAS_GlobalDisable
   */
  document.addEventListener('GAS_GlobalDisable', () => {
    folders.disable();
  });
})();
// Compatibilidad dual: CommonJS (tests/Node) y navegador (extensión de Chrome)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasFolders };
} else {
  window.GasFolders = GasFolders;
}