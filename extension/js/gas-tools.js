"use strict";
/**
 * @fileoverview Clase principal del editor personalizado para Google Apps
 * Script. Encapsula toda la lógica de aplicación de settings, snippets,
 * temas, inyección de UI (búsqueda, chat AI), gestión de cambios de archivo
 * y autocompletado AI sobre la instancia de Monaco que GAS expone como
 * `window.jsWireMonacoEditor`.
 *
 * El bootstrap (detección de Monaco, escucha de eventos del bridge,
 * gestión del singleton) vive en `gas-tools-main.js`. Aquí solo está
 * la clase, lista para ser instanciada desde ese archivo.
 */

class GasCustomEditor {

  // Flag estático: indica si los completion providers ya fueron registrados en Monaco.
  // Es estático porque Monaco es global: registrar el mismo provider dos veces
  // duplica las sugerencias en el autocompletado para todos los editores.
  static providersRegistered = false;
  /**
   * Archivos no activos al aplicar cambios del agente. `false` (seguro):
   * `setModel` + `executeEdits` y vuelta al archivo original con su view
   * state. `true` (experimental): `model.pushEditOperations` sin cambiar de
   * archivo; probar en GAS real que marca el archivo como modificado y lo
   * guarda (ver AGENTS.md, "Aplicar").
   */
  static EDIT_INACTIVE_IN_PLACE = false;
  /** Disposables de los completion providers de snippets (para liberarlos en disable). */
  static snippetProviderDisposables = [];
  /** Instancia cuyos `_snippets` consultan los providers globales. */
  static snippetOwner = null;

  // Textos heredados de los toggles (antes guardaban valores de Monaco).
  // Duplicado mínimo de la tabla de `legacyToBool` en src/js/utils/Variables.js
  // (este script corre en MAIN world y no puede importar módulos ES).
  /**
   * Selectores de clases ofuscadas de GAS que usa el modo oscuro del IDE.
   * Único punto a revisar si Google cambia el DOM; con `debug-mode` se avisa
   * (`console.debug`) de los que no coinciden con ningún nodo.
   * @type {Readonly<Object<string,string>>}
   */
  static IDE_SELECTORS = Object.freeze({
    accountName: '.gb_Zc .gb_Vd',                     // nombre en la barra de Google
    productName: 'header a[href$="/home"], header a[href$="/home"] *', // logo "Apps Script" (enlace a /home)
    mutedText: '.UGZzee, .jvZ3Wb, .e0Nwve',           // textos secundarios de la cabecera
    topBar: '.voS0mf, .xifBgf',                       // cabecera y navegación superior
    separators: '.ZHQ5U, .GLLFQe:not(:first-child)',  // separadores horizontales
    toolbarGroup: '.yggLIc',                          // grupo de botones (divisor en ::after)
    sideBorders: '.LDouke, .MJnCFe',                  // bordes verticales de paneles
    labelText: '.AVdUn',                              // etiquetas secundarias
    treeItemName: '.dxw0vf',                          // nombre de archivo en el árbol
    treeItemActive: 'li.UeVsd',                       // archivo activo del árbol
    foregroundText: '.ry3kXd, .cfWmIb, .orScbe, .VfPpkd-fmcmS-yrriRe, .VfPpkd-fmcmS-yrriRe-OWXEXe-mWPk3d',
    inputText: '.MocG8c',                             // texto de inputs nativos
    inverseText: '.ncFHed .MocG8c, .eU809d',          // texto sobre fondos invertidos
    invertedSurfaces: '.vL6DV, .vZzXQ, .awn63d, .ZBGfLd, .N3bjuf, .td5WLe, .hmN6tf, .OaLLmb, .wNGeMc', // paneles y menús
    invertedTree: '.UeVsd, .z2IeMc',                  // sidebar y árbol (invertidos)
    inputs: '.icpHQc',                                // campos de texto
    toolbar: '.g3VIld',                               // toolbar del editor (invertida)
    toolbarItem: '.ncFHed',                           // elementos de la toolbar
    toolbarReinvert: 'div.yggLIc .ncFHed, .CtTFvc .eU809d', // re-inversión dentro de la toolbar
    editorArea: '.LjDxcd, .ry3kXd',                   // contenedor de Monaco
    lightBackdrops: '.z9lUof, .Y7MQLd',               // fondos claros a invertir
  });

  static LEGACY_TRUE_VALUES = ['on', 'line', 'all', 'singleFile', 'always', 'selection', 'boundary', 'gutter', 'true'];

  /**
   * Convierte un toggle (booleano o texto heredado) en booleano.
   * @param {*} val Valor guardado.
   * @returns {boolean}
   */
  static toBool_(val) {
    if (typeof val === 'boolean') return val;
    return GasCustomEditor.LEGACY_TRUE_VALUES.includes(val);
  }

  /** `true` si el modelo es temporal de la vista previa de cambios (`gas-preview:`). */
  static _isPreviewModel_(model) {
    return model?.uri?.scheme === 'gas-preview' || model?.uri?.scheme === 'gas-ghdiff';
  }

  /**
   * @param {Object} options               - Datos iniciales del editor.
   * @param {Object} options.settings      - Toggles de configuración del usuario.
   * @param {Array}  options.snippets      - Snippets del usuario + predeterminados.
   * @param {Object} options.activeTheme   - Entrada del tema activo.
   * @param {string} options.chatButton    - HTML del botón del chat AI.
   * @param {string} options.fileButton    - HTML del indicador de archivo activo.
   * @param {string} options.actionsButton - HTML del botón de acciones del proyecto.
   * @param {string} options.assetsBaseUrl - URL base de los recursos web-accesibles (CSS de vendor).
   * @param {string} options.referenceId   - UUID del editor Monaco al que corresponde esta instancia.
   */
  constructor(options) {

    // ── Estado principal ─────────────────────────────────────────
    // Copia defensiva para no mutar el objeto original recibido del content script
    this._settings = { ...(options.settings || {}) };
    // Modo debug lo antes posible para cubrir los logs de init().
    DomUtils.setDebug(this._settings['debug-mode'] === true);
    // Idioma de la UI inyectada (elegido en el popup). Se fija una vez,
    // antes de crear toolbar y paneles; un cambio posterior se aplica al
    // recargar la pestaña de Apps Script.
    DomUtils.setI18n(options.i18n || null);
    // URL base de recursos (el MAIN world no tiene `chrome.runtime`).
    DomUtils.setAssetsBaseUrl(options.assetsBaseUrl);
    this._snippets = [...(options.snippets || [])];
    this._activeTheme = options.activeTheme || null;

    // Opciones de solo lectura (HTML de botones, URL de temas, referencia del editor)
    this.options = options;
    // ───────────────── Font ─────────────────────────────
    // Contador para generar IDs únicos en las peticiones a Google Fonts
    this._fontRequestId = 0;

    // ── Monaco ───────────────────────────────────────────────────
    this.editor = null;
    // Nombre del tema aplicado por GAS por defecto; se captura en init()
    this._defaultThemeName = 'vs-light';
    /**
     * Modelo principal: el modelo que estaba activo en `init()`, justo al
     * cargar la página. Se captura UNA SOLA VEZ y no se reasigna al
     * navegar entre archivos. Útil para acciones que necesitan referirse
     * al "archivo de entrada" del proyecto (p. ej. la URI inicial al
     * abrir el chat).
     * @type {object|null}
     */
    this._initialModel = null;

    // ── UI inyectada ─────────────────────────────────────────────
    this.DomUtils = DomUtils;
    /**
     * Raíz DOM activa: la `c-wiz` con `aria-busy="false"`. GAS monta una
     * `c-wiz` por panel SPA (Editor, Ejecuciones, Despliegues...); solo
     * la visible tiene `aria-busy="false"`. Todas las consultas DOM que
     * dependen del panel activo (toolbars, árbol de archivos) deben
     * usar esta raíz como scope.
     * @type {HTMLElement|null}
     */
    this._rootParent = null;
    /** @type {HTMLElement[]} Todas las toolbars `.INSTk` activas. */
    this._toolsMenuElements = [];

    // ── Listeners (guardados para poder eliminarlos en disable()) ─
    this._onChatButtonClick = null;
    this._onChatShortcut = null;
    this._onSidePanelResult = null;
    /** Listener del bridge `GAS_EDITOR_REQUEST` (Side Panel ↔ Monaco). */
    this._onEditorRequest = null;

    // ── Indicador de archivo activo ──────────────────────────────
    /** @type {HTMLElement|null} Web Component <gas-current-file>. */
    this._currentFile = null;

    // ── Acciones del proyecto ────────────────────────────────────
    /** @type {HTMLElement|null} Web Component <gas-actions-panel>. */
    this._actionsPanel = null;
    this._onActionsButtonClick = null;

    // ── GitHub sync ──────────────────────────────────────────────
    /** @type {HTMLElement|null} Web Component <gas-github-panel>. */
    this._githubPanel = null;
    this._onGithubButtonClick = null;
    this._onGithubShortcut = null;

    // ── Atajos dentro de Monaco ──────────────────────────────────
    // id → { keyCode, run, editor, disposable }. Se registran con
    // `editor.addAction` (devuelve disposable) y se re-enlazan al editor
    // activo cuando GAS lo reemplaza (ver `_syncServicesEditor_`).
    this._monacoShortcuts = new Map();
    // Editores donde ya se registró un fallback `addCommand` (sin dispose).
    this._monacoCommandFallbacks = new WeakMap();
    // Timers de reintento de `_onFileChange_` (se cancelan en el teardown).
    this._fileChangeRetryTimers = [];

    // ── Tema ─────────────────────────────────────────────────────
    // true cuando monaco.editor.setTheme ha sido monkey-patched
    this._themePatched = false;
    // Nombre del tema activo que el interceptor debe imponer
    this._activeThemeName = null;
    // Referencia a setTheme original para poder restaurarla en disable()
    this.originalSetTheme = null;

    // ── Cambio de archivo ────────────────────────────────────────
    this._modelChangeDisposable = null;
    this._lastModelUri = null;
    this._fileCheckInterval = null;

    // ── Mapa URI → nombre legible de archivo ─────────────────────
    // Apuntamos al singleton global `window.gasFileMap` para que los
    // web components (gas-current-file) lo consuman
    // directamente sin que tengamos que pasarles el mapa.
    this._fileNameObjectMap = window.gasFileMap;
    this._aiAutocomplete = null;
  }

  // ──────────────────────────────────────────
  // ESTADO INTERNO — MÉTODOS DE ACTUALIZACIÓN
  // Estos métodos son llamados por los listeners de eventos del documento
  // y centralizan las mutaciones de estado dentro de la clase.
  // ──────────────────────────────────────────

  /**
   * Fusiona settings parciales en el estado interno y los aplica al editor.
   * Llamado por el listener de GAS_SettingsUpdated para toggles individuales.
   *
   * @param {Object} partial - Objeto con solo las claves que cambiaron.
   */
  updateSettings(partial) {
    // Fusionamos en el estado interno para que _settings siempre esté completo
    this._settings = { ...this._settings, ...partial };
    // Propagamos las opciones al editor Monaco
    this.applySettings(partial);
    // Mantenemos options sincronizado por si se necesita en mergeAndReinit
    this.options.settings = this._settings;
  }

  /**
   * Reemplaza los snippets activos y recarga los completion providers.
   * Llamado por el listener de GAS_DataUpdated (updateType === 'snippets').
   *
   * @param {Array} snippets - Lista completa de snippets actualizada.
   */
  updateSnippets(snippets) {
    this._snippets = snippets;
    this.options.snippets = snippets;
    this.reloadSnippets();
  }

  /**
   * Reemplaza el tema activo y lo aplica a Monaco.
   * Llamado por el listener de GAS_DataUpdated (updateType === 'themes').
   *
   * @param {Object} theme - Entrada del nuevo tema activo.
   */
  updateTheme(theme) {
    // Mismo tema (id y definición): no se redefine ni se reaplica en Monaco.
    if (this._activeTheme && theme && JSON.stringify(this._activeTheme) === JSON.stringify(theme)) return;
    this._activeTheme = theme;
    this.options.activeTheme = theme;
    this.reloadTheme();
  }

  /**
   * Actualiza las opciones con el estado en memoria más reciente y reinicializa.
   * Se usa cuando el usuario cambia de archivo y llega un nuevo GAS_TransferData
   * mientras ya había una instancia activa con cambios del popup aplicados.
   *
   * @param {Object} freshData - Datos nuevos del content script (pueden tener opciones desactualizadas).
   */
  mergeAndReinit(freshData) {
    // Preservamos el estado en memoria sobre los datos nuevos del content script,
    // que pueden venir desactualizados si el popup cambió algo entre tanto
    this.options = {
      ...freshData,
      settings: Object.keys(this._settings).length > 0 ? this._settings : freshData.settings,
      snippets: this._snippets.length > 0 ? this._snippets : freshData.snippets,
      activeTheme: this._activeTheme || freshData.activeTheme,
    };

    // Refrescar la raíz antes de re-inicializar para que _waitForToolsMenu_
    // tenga scope válido aunque no venga cwiz del bootstrap.
    this._refreshRootParent_();

    // Si el editor referenciado quedó stale (p. ej. tras volver de Ejecuciones),
    // forzamos a init() a recapturar la instancia activa de Monaco.
    if (window.jsWireMonacoEditor && this.editor !== window.jsWireMonacoEditor) {
      DomUtils.debug('Editor', 'Editor Monaco reemplazado; recapturando instancia.');
      this.editor = null;
    }
    // `init()` recaptura el editor y propaga el cambio a los servicios
    // (autocompletado AI, búsqueda nativa) vía `_syncServicesEditor_`.
    this.init();
  }

  /**
   * Propaga el editor Monaco activo a los servicios que mantienen
   * listeners atados a él. Idempotente: cada servicio ignora el mismo editor.
   * @private
   */
  _syncServicesEditor_() {
    if (!this.editor) return;
    this._aiAutocomplete?.setEditor?.(this.editor);
    window.gasNativeSearch?.setEditor?.(this.editor);
    window.gasFileTabs?.setEditor?.(this.editor);
    // Los atajos de Monaco viven en la instancia del editor: si cambió,
    // los movemos al nuevo (y liberamos los del viejo).
    this._rebindMonacoShortcuts_();
  }

  // ──────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────

  /**
   * Punto de entrada del editor personalizado.
   * Captura la instancia de Monaco, espera a que la toolbar de GAS exista,
   * aplica settings/snippets/tema e inyecta los elementos de UI.
   *
   * IMPORTANTE: Esperamos la toolbar (.INSTk) antes de continuar porque
   * la inyección de botones y paneles depende de ese contenedor.
   * Así evitamos race conditions entre Monaco y la UI de GAS.
   *
   * @async
   */
  async init(cwizRootParent_) {
    // Monaco debe existir en este punto; si no, no hay nada que hacer
    this.editor = window.jsWireMonacoEditor;
    if (!this.editor) return;
    // Si el editor cambió (re-init por navegación SPA), los servicios deben
    // soltar el editor viejo y engancharse al nuevo.
    this._syncServicesEditor_();
    // Permite establecer el elemento padre de todas las opciones
    if (cwizRootParent_) this._setRootParent_(cwizRootParent_);

    // Elemento Monaco al que está anclada esta instancia (útil para mejoras futuras por editor)
    this.element = document.querySelector(`[data-gasreference='${this.options.referenceId}']`);
    if (!this.element) {
      DomUtils.debug('Editor', 'init(): elemento de referencia no encontrado', this.options.referenceId);
      return;
    }

    // Capturamos el tema por defecto de GAS para poder restaurarlo en disable()
    this._defaultThemeName = this.editor._themeService._theme.themeName;

    // Capturamos el modelo principal UNA SOLA VEZ. Solo lo asignamos si
    // aún no existe, para que las re-inicializaciones por navegación SPA
    // (que pasan por `mergeAndReinit`) no lo sobrescriban con el modelo
    // del archivo en el que estuviera el usuario en ese momento.
    if (!this._initialModel) {
      this._initialModel = this.editor.getModel?.() || null;
    }

    // Esperamos hasta 15 s a que aparezcan toolbars; sin ellas no podemos
    // inyectar la UI, pero el resto del editor sigue operando.
    this._toolsMenuElements = await this._waitForToolsMenu_();
    DomUtils.debug('Editor', 'init(): toolbars encontradas =', this._toolsMenuElements.length);

    // Aplicar opciones de Monaco (minimap, wordWrap, etc.) desde el estado interno
    this.applySettings(this._settings);

    // Registrar snippets como completion providers en Monaco
    await this.reloadSnippets();

    // Aplicar tema activo
    await this.reloadTheme();

    // Construir el mapa URI → nombre legible (consumido por gas-current-file
    // y otros componentes que muestran el nombre del archivo activo).
    this._buildUriToNameMap();

    // Si encontramos al menos una toolbar, inyectamos la UI propia.
    // Reinyectamos solo si:
    //   - El panel ya no existe en el DOM (GAS desmontó la página y se llevó todo).
    //   - O hay toolbars sin botón (GAS añadió una nueva `.INSTk` y no tiene
    //     nuestro botón).
    // En cualquier otro caso conservamos el estado actual para no cerrar el
    // panel cuando el usuario está usándolo.
    if (this._toolsMenuElements.length) {
      this._ensureUiInjected_();
    }

    // Bridge de lectura/edición del editor para el Side Panel (idempotente).
    this._bindEditorBridge_();

    // Escuchar cambios de modelo para mantener snippets y tema activos al cambiar de archivo
    this._setupModelListeners_();

    // Si hay un return-to-editor pendiente porque el evento llegó antes
    // de que la nueva instancia estuviera lista, lo consumimos aquí.
    if (window.__gasReturnPending) {
      window.__gasReturnPending = false;
      this.refreshInitialModel();
    }
  }

  /**
   * Devuelve el modelo Monaco principal (el que estaba activo cuando se
   * inicializó la clase). No cambia al navegar entre archivos.
   * @returns {object|null}
   */
  getInitialModel() {
    return this._initialModel;
  }

  /**
   * Re-captura el modelo principal usando el modelo activo actual del
   * editor. Llamado por el bootstrap cuando detecta una vuelta al editor
   * desde otra subruta (Ejecuciones, Despliegues, etc.); en ese instante
   * GAS suele abrir el archivo principal del proyecto, así que el modelo
   * activo es el que queremos anclar.
   *
   * También dispara un sync del mapa de archivos para que los componentes
   * que dependen del nombre del archivo principal se refresquen.
   */
  refreshInitialModel() {
    const next = this.editor?.getModel?.() || window.jsWireMonacoEditor?.getModel?.() || null;
    if (next) this._initialModel = next;
    // Refrescamos consumidores en cadena (mapa, botón, popover).
    this._buildUriToNameMap?.();
    this._renderCurrentFileButton_?.();
  }

  /**
   * Establece `_rootParent` con el elemento ya localizado por el bootstrap.
   * Evita repetir la búsqueda en el DOM que ya hizo `waitForCwiz_`.
   *
   * @param {HTMLElement} cwiz  El `c-wiz[data-p]` activo.
   */
  _setRootParent_(cwiz) {
    this._rootParent = cwiz;
  }

  // ──────────────────────────────────────────
  // LISTENERS DE CAMBIO DE ARCHIVO
  // ──────────────────────────────────────────

  /**
   * Registra los listeners que detectan cuando el usuario cambia de archivo en GAS.
   * Usa onDidChangeModel (Monaco) como fuente principal y un intervalo como red de seguridad.
   * @private
   */
  _setupModelListeners_() {
    if (!this.editor) return;

    if (this._modelChangeDisposable) {
      this._modelChangeDisposable.dispose();
      this._modelChangeDisposable = null;
    }
    this._stopFileCheckInterval_();
    // init() ya sincronizó el archivo actual: evitamos que el primer tick
    // del intervalo dispare un `_onFileChange_` redundante.
    this._lastModelUri = this.editor.getModel?.()?.uri?.toString?.() || null;

    // Debounce compartido: si llegan varios eventos seguidos (p. ej. el
    // intervalo y onDidChangeModel al mismo tiempo), solo ejecutamos una vez.
    // El timer vive en la instancia para poder cancelarlo en el teardown.
    const scheduleFileChange = () => {
      clearTimeout(this._fileChangeTimer);
      this._fileChangeTimer = setTimeout(() => this._onFileChange_(), 150);
    };

    // Fuente principal: el usuario seleccionó otro archivo en el árbol.
    this._modelChangeDisposable = this.editor.onDidChangeModel(scheduleFileChange);

    // Red de seguridad: detecta cambios que onDidChangeModel no captura
    // (navegación SPA, cambios iniciados desde la UI de GAS).
    this._fileCheckInterval = setInterval(() => {
      const currentUri = this.editor?.getModel()?.uri?.toString();
      if (currentUri && currentUri !== this._lastModelUri) {
        this._lastModelUri = currentUri;
        scheduleFileChange();
      }
    }, 2000);
  }

  /**
   * Acciones a ejecutar cuando se detecta un cambio de archivo (modelo).
   *
   * El árbol de archivos de GAS actualiza `aria-selected` con un pequeño
   * delay tras el cambio de modelo en Monaco. Eso provoca que un único
   * `_buildUriToNameMap` justo al detectar el cambio NO encuentre el
   * archivo activo y el botón caiga a "File N". Para evitarlo,
   * reintentamos el build en ventanas crecientes hasta confirmar que el
   * URI activo ya tiene nombre, o agotar los intentos.
   * @private
   */
  _onFileChange_() {
    // Si la extensión fue deshabilitada mientras el intervalo o un listener
    // estaba en vuelo, no hacemos nada y dejamos que _teardownInjectedUi_ termine
    if (window.__gasGloballyDisabled) return;
    // Registrar el URI procesado: así el intervalo de seguridad no vuelve a
    // disparar el mismo cambio que ya detectó onDidChangeModel.
    this._lastModelUri = this.editor?.getModel?.()?.uri?.toString?.() || this._lastModelUri;
    // Modelo temporal de la vista previa de cambios: no es un archivo real.
    if (GasCustomEditor._isPreviewModel_(this.editor?.getModel?.())) return;
    // Refrescar la raíz por si la navegación SPA cambió la `c-wiz` activa.
    this._refreshRootParent_();
    if (this._snippets.length > 0) this.reloadSnippets();
    this.reloadTheme();

    // Construye el mapa y refresca todos los consumidores en cadena.
    const syncAll = () => {
      this._buildUriToNameMap();
      document.querySelectorAll('gas-current-file').forEach((el) => {
        el.setEditor?.(this.editor);
        el.setFileNameObjectMap?.(this._fileNameObjectMap);
      });
      this._renderCurrentFileButton_();
    };

    // Pase inmediato.
    syncAll();

    // Reintentos diferidos: el árbol DOM puede tardar en marcar el nuevo
    // archivo como `aria-selected="true"`. Si el URI activo ya tiene
    // nombre, abortamos los reintentos restantes.
    const activeUri = this.editor?.getModel?.()?.uri
      ? String(this.editor.getModel().uri)
      : null;
    const isResolved = () =>
      !activeUri || this._fileNameObjectMap.has(activeUri);

    // Cancelamos reintentos de un cambio anterior para no acumular timers
    // cuando el usuario navega rápido entre archivos.
    this._clearFileChangeRetries_();
    this._fileChangeRetryTimers = [120, 350, 800].map((delay) =>
      setTimeout(() => {
        if (window.__gasGloballyDisabled || isResolved()) return;
        syncAll();
      }, delay)
    );
  }

  /**
   * Cancela los reintentos diferidos pendientes de `_onFileChange_`.
   * @private
   */
  _clearFileChangeRetries_() {
    (this._fileChangeRetryTimers || []).forEach((id) => clearTimeout(id));
    this._fileChangeRetryTimers = [];
  }

  /**
   * Detiene el intervalo de verificación periódica de cambio de archivo.
   * @private
   */
  _stopFileCheckInterval_() {
    if (this._fileCheckInterval) {
      clearInterval(this._fileCheckInterval);
      this._fileCheckInterval = null;
    }
    clearTimeout(this._fileChangeTimer);
    this._fileChangeTimer = null;
    this._clearFileChangeRetries_();
  }

  // ──────────────────────────────────────────
  // RAÍZ DOM ACTIVA (c-wiz)
  // ──────────────────────────────────────────

  /**
   * Recalcula `this._rootParent` apuntando a la `c-wiz` con
   * `aria-busy="false"` (el panel SPA visible). Si solo hay una `c-wiz`
   * y no está oculta, la usamos directamente; en caso contrario buscamos
   * la primera no oculta y no marcada como busy.
   *
   * Si no encuentra ninguna válida, deja el valor previo intacto: prefiere
   * una referencia "stale" sobre `null`, dado que el observador resolverá
   * pronto y los consumidores tienen un fallback a `document`.
   *
   * @returns {HTMLElement|null} Raíz activa o `null` si nunca se encontró.
   * @private
   */
  _refreshRootParent_() {
    // Criterio canónico: la `c-wiz` con `aria-busy="false"` explícito.
    let next = this._findActiveCwiz_();

    // Fallback (comportamiento previo) mientras GAS no ha marcado ninguna.
    if (!next) {
      const containers = document.querySelectorAll('c-wiz[data-p]');
      if (containers.length === 1 && containers[0].getAttribute('aria-hidden') !== 'true') {
        next = containers[0];
      } else {
        next = document.querySelector(
          'c-wiz[data-p]:not([aria-hidden="true"]):not([aria-busy="true"])'
        );
      }
    }

    if (next) this._rootParent = next;
    return this._rootParent ?? null;
  }

  /**
   * Devuelve la `c-wiz[data-p][aria-busy="false"]` activa, priorizando la
   * que no está oculta. `null` si GAS aún no marcó ninguna.
   * @returns {HTMLElement|null}
   * @private
   */
  _findActiveCwiz_() {
    return document.querySelector('c-wiz[data-p][aria-busy="false"]:not([aria-hidden="true"])')
      || document.querySelector('c-wiz[data-p][aria-busy="false"]');
  }

  /**
   * Devuelve el scope DOM para querys: la `c-wiz` activa o `document` si
   * aún no se ha resuelto. Útil cuando un método externo necesita
   * consultar elementos sin depender de un getter previo.
   * @returns {ParentNode}
   * @private
   */
  _getDomScope_() {
    return this._rootParent || document;
  }

  // ──────────────────────────────────────────
  // MAPA URI → NOMBRE DE ARCHIVO
  // ──────────────────────────────────────────

  /**
   * Construye el mapa URI → nombre legible usando la posición DOM como ancla.
   *
   * Las URIs de Monaco son opacas (inmemory://model/N), así que el único
   * anclaje confiable es el modelo activo: Monaco nos dice qué URI está
   * abierta, la UI de GAS nos dice qué archivo está activo. Con ese par
   * fijado, asignamos el resto por posición excluyendo ese slot de ambas listas.
   * @private
   */
  _buildUriToNameMap() {
    const map = new Map(window.gasFileMap?.entries?.() || []);

    const items = [...this._getDomScope_().querySelectorAll('li[role="option"][data-res-id]')];
    if (!items.length) {
      window.gasFileMap?.replace(map);
      return;
    }

    // Variable para listar todos los nombres
    let files = [];

    // Recorremos cada uno de los <li> y extraemos el nombre del archivo
    for (const li of items) {
      let fileName_ = li.getAttribute('aria-label')?.trim();
      if (!fileName_) continue;

      // Si el <li> tiene un <div title="...">, usamos ese título como nombre del archivo
      fileName_ = li.querySelector('div[title]')?.getAttribute('title')?.trim() || fileName_;

      // Agremamos el archivo a la lista
      files.push({
        name: fileName_,
        index:  parseInt(li.getAttribute('data-index'), 10),
        active: li.getAttribute('aria-selected') === 'true',
      });
    }

    // Ordenamos los archivos por índice para que coincidan con el orden de Monaco
    files.sort((a, b) => a.index - b.index);
    const normalFiles = files.filter(f => f.name !== 'appsscript.json');
    const appScript = files.find(f  => f.name === 'appsscript.json');

    // Modelos de Monaco ordenados por ID numérico
    const models = (window.monaco?.editor?.getModels?.() || [])
      .filter(m => !GasCustomEditor._isPreviewModel_(m))
      .map(m => ({
        uri: m.uri.toString(),
        id:  parseInt(m.uri.path.replace('/', ''), 10),
      }))
      .sort((a, b) => a.id - b.id);
      
    // Determinar el índice de inicio dentro del array de modelos
    // usando el modelo inicial capturado como ancla
    let startIdx = 0;
    if (this._initialModel) {
      const initialId = parseInt(
        this._initialModel.uri.path.replace('/', ''), 10
      );
      const found = models.findIndex(m => m.id === initialId);
      if (found !== -1) startIdx = found;
    }

    // Mapear cada archivo normal al modelo en (startIdx + i)
    normalFiles.forEach((file, i) => {
      const offset = (appScript && i >= 1) ? 1 : 0;
      const model = models[startIdx + i + offset];
      if (model) map.set(model.uri, file.name);
    });

    // appsscript.json → modelo justo antes del inicial (startIdx - 1)
    if (appScript) {
      const target = models[startIdx + 1];
      if (target) map.set(target.uri, appScript.name);
    }

    window.gasFileMap?.replace(map);
  }

  /**
   * Devuelve el nombre legible de un modelo Monaco.
   *
   * Estrategia (en orden de prioridad):
   *   1. Cache `_fileNameObjectMap` por URI (rápido, evita recalcular).
   *   2. Basename de la URI si parece un nombre de archivo real (.gs, .json, etc.).
   *   3. Fallback: "File N".
   *
   * @param {Object} model   - Instancia del modelo Monaco.
   * @param {number} [index=0] - Índice del modelo en la lista (usado solo en el fallback).
   * @returns {string} Nombre legible del archivo.
   */
  _formatModelName(model, index = 0) {
    const uriKey = String(
      model?.uri?.toString?.() || model?.uri?._formatted || model?.uri?.path || ''
    );

    // Hit en cache: devolvemos el nombre directamente
    if (uriKey && this._fileNameObjectMap.has(uriKey)) {
      return this._fileNameObjectMap.get(uriKey);
    }

    // Miss en cache: intentamos el basename de la URI
    const rawPath = String(model?.uri?.path || model?.uri?._formatted || '');
    if (rawPath) {
      const baseName = rawPath.split('/').filter(Boolean).pop() || '';
      if (this._looksLikeRealFileName(baseName)) return baseName;
    }

    return `File ${index + 1}`;
  }

  /**
   * Comprueba si una cadena parece un nombre de archivo real (gs, html, etc.).
   * @param {string} value - Nombre a validar.
   * @returns {boolean}
   */
  _looksLikeRealFileName(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    // Descartar nombres genéricos tipo "model 1", "model 2", etc.
    if (/^model\s*\d+$/i.test(text)) return false;
    return /\.(gs|js|ts|json|html|css|md|txt)$/i.test(text);
  }

  /**
   * Limpia botones inyectados con un id dado y libera los listeners
   * registrados en `document` por su nombre. Centraliza la lógica de
   * teardown común a búsqueda y chat.
   *
   * @param {string} buttonId  ID del wrapper a remover (p.ej. `'buttonChatGas'`).
   * @param {string} panelTag  Tag del Web Component a remover del body
   *   (p.ej. `'gas-actions-panel'`).
   * @param {{type:string, capture?:boolean}[]} listenerSpecs  Lista de
   *   listeners a quitar; cada uno con la propiedad de instancia que lo
   *   guarda (`prop`) y el tipo de evento (`type`, `capture` opcional).
   * @private
   */
  _teardownToolbarUi_(buttonId, panelTag, listenerSpecs) {
    document.querySelectorAll(`#${buttonId}`).forEach((el) => el.remove());
    // `panelTag` nulo: el caller conserva el panel (p. ej. el chat).
    if (panelTag) document.querySelector(panelTag)?.remove();
    listenerSpecs.forEach(({ prop, type, capture }) => {
      const fn = this[prop];
      if (fn) document.removeEventListener(type, fn, capture);
      this[prop] = null;
    });
  }

  /**
   * Registra un atajo global a nivel de `document` con captura. Devuelve
   * la función registrada para que el caller la guarde y pueda removerla
   * en su teardown.
   *
   * @param {string} key      Letra del atajo (no sensible a mayúsculas).
   * @param {() => void} run  Acción a ejecutar.
   * @returns {(evt: KeyboardEvent) => void} Listener registrado.
   * @private
   */
  _bindGlobalShortcut_(key, run) {
    const listener = (evt) => {
      if (!(evt.key?.toLowerCase() === key && evt.altKey && evt.shiftKey)) return;
      evt.preventDefault();
      evt.stopPropagation();
      run();
    };
    document.addEventListener('keydown', listener, true);
    return listener;
  }

  /**
   * Registra (o actualiza) un atajo Alt+Shift+<tecla> dentro de Monaco.
   * Se guarda en `_monacoShortcuts` para re-enlazarlo cuando GAS cambia
   * la instancia del editor y liberarlo en el teardown. Idempotente: no
   * duplica el binding sobre el mismo editor.
   *
   * @param {string} id         Id único de la acción (ej. 'gas-tools.chat.open').
   * @param {number} keyCode    `monaco.KeyCode.KeyX` correspondiente.
   * @param {() => void} run    Acción a ejecutar.
   * @private
   */
  _bindMonacoShortcut_(id, keyCode, run) {
    if (keyCode == null) return;
    const prev = this._monacoShortcuts.get(id);
    // Mismo editor ya enlazado: solo actualizamos el callback.
    if (prev && prev.editor === this.editor && prev.disposable) {
      prev.run = run;
      return;
    }
    prev?.disposable?.dispose?.();
    const entry = { keyCode, run, editor: null, disposable: null };
    this._monacoShortcuts.set(id, entry);
    this._attachMonacoShortcut_(id, entry);
  }

  /**
   * Enlaza una entrada de `_monacoShortcuts` al editor activo. Usa
   * `addAction` (disposable); si no existe, cae a `addCommand` una sola
   * vez por editor (Monaco no permite deshacerlo).
   * @private
   */
  _attachMonacoShortcut_(id, entry) {
    const editor = this.editor;
    if (!editor || !window.monaco?.KeyMod) return;
    const keybinding = window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | entry.keyCode;
    // El callback lee `entry.run` para que un re-bind no requiera re-registrar.
    const invoke = () => entry.run?.();

    try {
      if (typeof editor.addAction === 'function') {
        entry.disposable = editor.addAction({ id, label: `GAS Tools: ${id}`, keybindings: [keybinding], run: invoke });
        entry.editor = editor;
        return;
      }
      if (typeof editor.addCommand === 'function') {
        let bound = this._monacoCommandFallbacks.get(editor);
        if (!bound) this._monacoCommandFallbacks.set(editor, (bound = new Set()));
        if (!bound.has(id)) {
          bound.add(id);
          // Sin dispose: el callback consulta el registro para quedar inerte tras el teardown.
          editor.addCommand(keybinding, () => this._monacoShortcuts.get(id)?.run?.());
        }
        entry.editor = editor;
        entry.disposable = { dispose: () => {} };
      }
    } catch (err) {
      console.warn('[GASTools] No se pudo registrar el atajo de Monaco', id, err);
    }
  }

  /**
   * Re-enlaza todos los atajos registrados al editor activo. Llamado
   * cuando GAS reemplaza la instancia de Monaco.
   * @private
   */
  _rebindMonacoShortcuts_() {
    this._monacoShortcuts.forEach((entry, id) => {
      if (entry.editor === this.editor && entry.disposable) return;
      entry.disposable?.dispose?.();
      entry.disposable = null;
      entry.editor = null;
      this._attachMonacoShortcut_(id, entry);
      DomUtils.debug('Shortcuts', 'Atajo re-enlazado al nuevo editor:', id);
    });
  }

  /**
   * Libera un atajo de Monaco (o todos si no se indica id).
   * @param {string} [id]
   * @private
   */
  _disposeMonacoShortcut_(id) {
    const ids = id ? [id] : [...this._monacoShortcuts.keys()];
    ids.forEach((key) => {
      const entry = this._monacoShortcuts.get(key);
      try { entry?.disposable?.dispose?.(); } catch (_) { /* ignorar */ }
      this._monacoShortcuts.delete(key);
    });
  }

  // ──────────────────────────────────────────
  // BÚSQUEDA AVANZADA
  // ──────────────────────────────────────────

  /**
   * Inserta un botón nativo (HTML del recurso) ANTES de cada toolbar
   * `.INSTk` activa, alineado a su izquierda. Idempotente: solo añade el
   * botón en toolbars que aún no lo tienen, evitando duplicados al
   * reinyectar después de un cambio de panel SPA.
   *
   * @param {string} buttonId   ID del wrapper a crear (también usado para
   *   evitar duplicados, p.ej. `'buttonChatGas'`).
   * @param {string} html       HTML del botón a inyectar dentro del wrapper.
   * @private
   */
  _injectToolbarButton_(buttonId, html) {
    this._toolsMenuElements.forEach((toolbar) => {
      if (toolbar.parentNode.querySelector(`:scope > #${buttonId}`)) return;
      const option = document.createElement('div');
      option.className = 'yggLIc';
      option.id = buttonId;
      this.DomUtils.setHTML(option, html);
      DomUtils.applyI18n(option);
      toolbar.parentNode.insertBefore(option, toolbar);
    });
  }

  /**
   * Mantiene la UI inyectada al día con un comportamiento idempotente:
   *
   *  - Si el panel de acciones falta en el body (GAS desmontó la página
   *    por completo), reinyecta TODO desde cero.
   *  - Si el panel sigue vivo, solo añade los botones faltantes a las
   *    toolbars `.INSTk` que aún no los tienen. Esto evita cerrar el
   *    panel abierto cuando el usuario está usándolo.
   *
   * @private
   */
  _ensureUiInjected_() {
    // Marca de "paneles vivos": el popover de acciones (el chat ya no se
    // inyecta en la página; vive en el Side Panel nativo de Chrome).
    const panelsAlive = !!document.querySelector('gas-actions-panel');

    if (!panelsAlive) {
      this._injectSidePanelButton_();
      this._injectActionsPanel_();
      this._injectGithubPanel_();
      this._injectCurrentFile_();
      return;
    }

    this._buildUriToNameMap();

    // Los listeners del botón AI pueden faltar si esta instancia aún no los registró.
    if (!this._onChatButtonClick) this._injectSidePanelButton_();

    // Y solo añadir los botones que falten en alguna toolbar.
    this._injectToolbarButton_('buttonChatGas',    this.options.chatButton);
    this._injectToolbarButton_('buttonActionsGas', this.options.actionsButton);
    this._injectToolbarButton_('buttonGithubGas',  this.options.githubButton);

    // El indicador de archivo activo se monta dentro de cada toolbar para
    // que aparezca alineado a la derecha.
    this._injectCurrentFile_();

    // El panel de acciones del proyecto es independiente del flujo de
    // re-inyección de paneles porque conserva estado propio.
    if (!document.querySelector('gas-actions-panel')) {
      this._injectActionsPanel_();
    }
    if (!document.querySelector('gas-github-panel')) {
      this._injectGithubPanel_();
    } else {
      // El panel ya existía: solo refrescamos el indicador para que el
      // dot verde aparezca en los botones recién creados de la toolbar.
      document.querySelector('gas-github-panel')?.refreshBadge?.();
    }
  }

  /**
   * Espera a que existan toolbars `.INSTk` en el DOM y devuelve la lista
   * de las que pertenecen a una `c-wiz` activa.
   *
   * GAS monta una `c-wiz` por panel SPA (Editor, Ejecuciones, Despliegues,
   * etc.) y solo la VISIBLE tiene `aria-busy="false"`. Las demás existen
   * en el DOM pero están en pausa. Si inyectamos en todas, los botones
   * acaban duplicándose en paneles invisibles. Filtramos por `c-wiz`
   * activa para evitarlo.
   *
   * @returns {Promise<HTMLElement[]>} Lista de toolbars activas; vacía tras 15 s.
   * @private
   */
  _waitForToolsMenu_() {
    // Solo toolbars de la `c-wiz` activa. Si GAS aún no marcó ninguna con
    // aria-busy="false", usamos la raíz conocida (o document) y descartamos
    // las que pertenecen a una `c-wiz` en pausa.
    const all = () => {
      const scope = this._findActiveCwiz_() || this._getDomScope_();
      return Array.from(scope.querySelectorAll('.INSTk')).filter((el) => {
        const owner = el.closest('c-wiz[data-p]');
        return !owner || owner.getAttribute('aria-busy') !== 'true';
      });
    };

    // Creamos la promesa para validar que el lemento este creado
    return new Promise((resolve) => {
      const existing = all();
      if (existing.length) {
        this._refreshRootParent_();
        return resolve(existing);
      }

      let resolved = false;
      let checkTimer = 0;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearTimeout(timeoutId);
        clearTimeout(checkTimer);
        // Aprovechamos para anclar la raíz al `c-wiz` activa que acaba de
        // emerger, así los siguientes consumidores la usan sin redoblar
        // queries innecesarias.
        if (value.length) this._refreshRootParent_();
        resolve(value);
      };

      // Coalescemos ráfagas de mutaciones: una sola consulta cada 50 ms
      // en vez de un querySelectorAll por cada lote del observer.
      const observer = new MutationObserver(() => {
        if (checkTimer || resolved) return;
        checkTimer = setTimeout(() => {
          checkTimer = 0;
          const found = all();
          if (found.length) finish(found);
        }, 50);
      });
      observer.observe(document.body, {
        childList:       true,
        subtree:         true,
        attributes:      true,
        attributeFilter: ['aria-busy'],
      });

      const timeoutId = setTimeout(() => finish([]), 15000);
    });
  }

  /**
   * Crea (o recrea) el botón del chat AI. El chat ya no vive en la página:
   * el botón y los atajos solo piden al content script que abra el Side
   * Panel nativo de Chrome (`GAS_OPEN_SIDE_PANEL`).
   * @private
   */
  _injectSidePanelButton_() {
    // 1. Limpiar botones duplicados, listeners y atajos previos.
    this._teardownSidePanelButton_();

    // 2. Insertar un botón en cada toolbar `.INSTk` activa.
    this._injectToolbarButton_('buttonChatGas', this.options.chatButton);

    // 3. Click delegado a nivel de documento. Verificamos que el trigger
    //    esté dentro de una toolbar `.INSTk` o del contenedor inyectado.
    this._onChatButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnChatGas');
      if (!trigger) return;
      if (!trigger.closest('.INSTk') && !trigger.closest('#buttonChatGas')) return;
      e.preventDefault();
      this._requestSidePanel_();
    };
    document.addEventListener('click', this._onChatButtonClick);

    // 4. Atajo global Alt+Shift+C.
    const openSidePanel = () => this._requestSidePanel_();
    this._onChatShortcut = this._bindGlobalShortcut_('c', openSidePanel);

    // 5. Atajo dentro de Monaco (se re-enlaza si cambia el editor).
    this._bindMonacoShortcut_(
      'gas-tools.chat.open',
      window.monaco?.KeyCode?.KeyC,
      openSidePanel
    );

    // 6. Resultado de la apertura: el content script solo lo despacha
    //    cuando falla. Se avisa con un toast de página (y el detalle en consola).
    this._onSidePanelResult = (e) => {
      let detail = null;
      try { detail = JSON.parse(e.detail || '{}'); } catch (_) { /* ignorar */ }
      if (!detail || detail.ok !== false) return;
      const text = DomUtils.t('edSideOpenFailed', "Couldn't open the side panel. Open it from Chrome's side panel menu.");
      console.warn('[GASTools]', text, detail.error || '');
      window.GasUi?.toast(document, { text, kind: 'warning', closeLabel: DomUtils.t('edGhDismiss', 'Dismiss') });
    };
    document.addEventListener('GAS_OPEN_SIDE_PANEL_RESULT', this._onSidePanelResult);
  }

  /**
   * Solicita al content script (→ background) abrir el Side Panel del chat.
   * @private
   */
  _requestSidePanel_() {
    document.dispatchEvent(new CustomEvent('GAS_OPEN_SIDE_PANEL', { detail: JSON.stringify({}) }));
  }

  /**
   * Elimina los botones del chat, el click delegado, los atajos y el
   * listener del resultado de apertura del Side Panel.
   * @private
   */
  _teardownSidePanelButton_() {
    this._teardownToolbarUi_('buttonChatGas', null, [
      { prop: '_onChatButtonClick', type: 'click' },
      { prop: '_onChatShortcut',    type: 'keydown', capture: true },
      { prop: '_onSidePanelResult', type: 'GAS_OPEN_SIDE_PANEL_RESULT' },
    ]);
    this._disposeMonacoShortcut_('gas-tools.chat.open');
  }

  // ──────────────────────────────────────────
  // BRIDGE DEL EDITOR (Side Panel ↔ Monaco)
  // ──────────────────────────────────────────

  /**
   * Registra (una sola vez) el listener `GAS_EDITOR_REQUEST` con el que el
   * Side Panel lee/edita el editor Monaco activo. Responde siempre con
   * `GAS_EDITOR_RESPONSE` y el mismo `requestId`.
   * @private
   */
  _bindEditorBridge_() {
    if (this._onEditorRequest) return;
    this._onEditorRequest = (e) => {
      let request;
      try { request = JSON.parse(e.detail || '{}'); } catch (_) { return; }
      const { requestId, action, payload } = request || {};
      if (!requestId) return;
      const reply = (response) => {
        document.dispatchEvent(new CustomEvent('GAS_EDITOR_RESPONSE', {
          detail: JSON.stringify({ requestId, ...response }),
        }));
      };
      const fail = (err) => reply({ ok: false, error: String(err?.message || err) });
      // Algunas acciones son asíncronas (saveProject): resolvemos siempre como promesa.
      try {
        Promise.resolve(this._handleEditorRequest_(action, payload || {})).then(reply, fail);
      } catch (err) {
        fail(err);
      }
    };
    document.addEventListener('GAS_EDITOR_REQUEST', this._onEditorRequest);
  }

  /** Elimina el listener del bridge del editor. @private */
  _unbindEditorBridge_() {
    if (!this._onEditorRequest) return;
    document.removeEventListener('GAS_EDITOR_REQUEST', this._onEditorRequest);
    this._onEditorRequest = null;
  }

  /**
   * Resuelve una acción del bridge del editor.
   * @param {string} action
   * @param {object} payload
   * @returns {{ok:boolean, data?:object, error?:string}|Promise<{ok:boolean, error?:string}>}
   * @private
   */
  _handleEditorRequest_(action, payload) {
    // Las ediciones directas no pueden caer sobre el modelo de solo lectura de la vista previa.
    if (['insertAtCursor', 'replaceSelection', 'replaceFile'].includes(action) && window.gasDiffPreview?.isActive?.()) {
      window.gasDiffPreview.close();
    }
    const editor = this.editor || null;
    // Con la vista previa abierta, las lecturas se refieren al archivo real del usuario.
    const activeModel = editor?.getModel?.() || null;
    const model = GasCustomEditor._isPreviewModel_(activeModel)
      ? (window.gasDiffPreview?.userModel?.() || null)
      : activeModel;
    const ok_ = (data) => ({ ok: true, data });
    const readActions = ['getInfo', 'getStats', 'getSelection', 'getFile', 'getProject'];

    if (readActions.includes(action) && !model) return ok_({ available: false });

    switch (action) {
      case 'getInfo':
        return ok_({ available: true, fileName: this._modelDisplayName_(model) });

      case 'getStats': {
        const models = this._projectModels_();
        const projectChars = models.reduce((sum, m) => sum + this._modelLength_(m), 0);
        return ok_({
          available:      true,
          selectionChars: this._selectedText_(editor, model).length,
          fileChars:      this._modelLength_(model),
          projectChars,
        });
      }

      case 'getSelection':
        return ok_({ available: true, text: this._selectedText_(editor, model) });

      case 'getFile':
        return ok_({ available: true, name: this._modelDisplayName_(model), text: model.getValue(), versionId: GasCustomEditor._versionOf_(model) });

      case 'getProject': {
        // Mismo orden que `getModels()`; se incluyen archivos hasta que el
        // siguiente supere `maxChars`, el resto se lista en `omitted`.
        const maxChars = Number(payload.maxChars) > 0 ? Number(payload.maxChars) : Infinity;
        const models = window.monaco?.editor?.getModels?.() || [];
        const files = [];
        const omitted = [];
        let total = 0;
        models.forEach((m, index) => {
          if (m?.isDisposed?.() || GasCustomEditor._isPreviewModel_(m)) return;
          let text;
          try { text = m.getValue(); } catch (_) { return; }
          const name = this._modelDisplayName_(m, index);
          if (total + text.length > maxChars) {
            omitted.push(name);
            return;
          }
          total += text.length;
          files.push({ name, text });
        });
        return ok_({ available: true, files, omitted });
      }

      case 'insertAtCursor': {
        if (!editor) return { ok: false, error: 'no-editor' };
        const sel = editor.getSelection?.();
        if (!sel) return { ok: false, error: 'no-cursor' };
        editor.executeEdits('gas-chat', [{
          range: {
            startLineNumber: sel.startLineNumber,
            startColumn:     sel.startColumn,
            endLineNumber:   sel.startLineNumber,
            endColumn:       sel.startColumn,
          },
          text: String(payload.text ?? ''),
          forceMoveMarkers: true,
        }]);
        editor.focus();
        return { ok: true };
      }

      case 'replaceSelection': {
        if (!editor) return { ok: false, error: 'no-editor' };
        const sel = editor.getSelection?.();
        if (!sel || sel.isEmpty?.()) return { ok: false, error: 'no-selection' };
        editor.executeEdits('gas-chat', [{ range: sel, text: String(payload.text ?? ''), forceMoveMarkers: true }]);
        editor.focus();
        return { ok: true };
      }

      case 'replaceFile': {
        if (!editor || !model) return { ok: false, error: 'no-editor' };
        const fullRange = model.getFullModelRange();
        editor.executeEdits('gas-chat-diff', [{
          range: fullRange,
          text: String(payload.text ?? ''),
          forceMoveMarkers: true,
        }]);
        editor.focus();
        return { ok: true };
      }

      case 'listFiles': {
        const files = this._projectModels_().map((m, index) => {
          const name = this._modelDisplayName_(m, index);
          return { name, type: this._modelFileType_(m, name), lines: m.getLineCount?.() || 0 };
        });
        return ok_({ available: !!files.length, files });
      }

      case 'readFile': {
        const name = String(payload.name ?? '');
        const target = this._findModelByName_(name);
        if (!target) return ok_({ available: !!this._projectModels_().length, found: false, name, text: '' });
        return ok_({ available: true, found: true, name: this._modelDisplayName_(target), text: target.getValue(), versionId: GasCustomEditor._versionOf_(target) });
      }

      case 'readFiles': {
        // Varios archivos en un solo viaje; el orden coincide con `names`.
        const names = (Array.isArray(payload.names) ? payload.names : []).slice(0, 200).map((n) => String(n ?? ''));
        const files = names.map((name) => {
          const target = this._findModelByName_(name);
          return target
            ? { found: true, name: this._modelDisplayName_(target), text: target.getValue(), versionId: GasCustomEditor._versionOf_(target) }
            : { found: false, name, text: '' };
        });
        return ok_({ available: !!this._projectModels_().length, files });
      }

      case 'previewChanges': {
        if (!editor) return { ok: false, error: 'no-editor' };
        const preview = window.gasDiffPreview;
        if (!preview?.open) return { ok: false, error: 'preview-unavailable' };
        const requested = Array.isArray(payload.files) ? payload.files : [];
        const files = [];
        const conflicts = [];
        const pinned = new Map(); // nombre → versión mostrada (Accept aplica exactamente lo visto)
        let index = 0;
        requested.forEach((f, i) => {
          const kind = f?.kind === 'create' ? 'create' : 'edit';
          const name = String(f?.name ?? '');
          const target = kind === 'edit' ? this._findModelByName_(name) : null;
          const original = target ? target.getValue() : '';
          let proposed = String(f?.proposed ?? '');
          if (target) {
            const rebased = this._rebaseForPreview_(target, f, original);
            if (rebased.conflict) { conflicts.push({ name, ...rebased.conflict }); return; }
            proposed = rebased.proposed;
            pinned.set(name, { name, mode: 'full', proposed, baseVersionId: GasCustomEditor._versionOf_(target), key: f?.key || '' });
          }
          if (i === (Number(payload.index) || 0)) index = files.length;
          files.push({ name, kind, original, proposed });
        });
        if (!files.length) return conflicts.length ? { ok: true, data: { ok: false, error: 'conflict', conflicts } } : { ok: false, error: 'no-files' };
        preview.open({
          files,
          index,
          editor,
          getModelByName: (n) => this._findModelByName_(n),
          applyFile:      (n, text) => this._applyChangeSetSafe_([pinned.get(n) || { name: n, mode: 'full', proposed: text }], { fromPreview: true })
            .then((res) => ({ ok: res.ok, error: res.ok ? undefined : (res.results?.[0]?.status === 'conflict' ? 'conflict' : res.error) })),
        });
        return { ok: true, data: { ok: true, conflicts } };
      }

      case 'navigatePreview': {
        if (!window.gasDiffPreview?.isActive?.()) return { ok: false, error: 'no-preview' };
        window.gasDiffPreview.navigate(Number(payload.index) || 0);
        return { ok: true };
      }

      case 'closePreview':
        window.gasDiffPreview?.close?.();
        return { ok: true };

      case 'applyFileEdits':
        return this._applyFileEdits_(String(payload.name ?? ''), String(payload.proposed ?? ''));

      case 'applyChangeSet':
        return this._applyChangeSetSafe_(Array.isArray(payload.files) ? payload.files : [])
          .then((res) => ({ ok: true, data: res }));

      case 'saveProject':
        return this._saveProject_();

      case 'reloadPage':
        setTimeout(() => window.top.location.reload(), 50);
        return { ok: true };

      default:
        return { ok: false, error: `unknown-action: ${action}` };
    }
  }

  /** Modelos de archivos reales del proyecto (sin vista previa ni liberados). @private */
  _projectModels_() {
    return (window.monaco?.editor?.getModels?.() || [])
      .filter((m) => m && !m.isDisposed?.() && !GasCustomEditor._isPreviewModel_(m));
  }

  /** Tipo GAS de un modelo: 'gs' | 'html' | 'json'. @private */
  _modelFileType_(model, name = '') {
    const lower = String(name).toLowerCase();
    if (lower.endsWith('.html')) return 'html';
    if (lower.endsWith('.json')) return 'json';
    const lang = model?.getLanguageId?.() || '';
    if (lang === 'html') return 'html';
    if (lang === 'json') return 'json';
    return 'gs';
  }

  /**
   * Busca un modelo por nombre legible: exacto, sin distinguir mayúsculas
   * o ignorando la extensión (`Code` ↔ `Code.gs`).
   * @param {string} name
   * @returns {object|null}
   * @private
   */
  _findModelByName_(name) {
    const wanted = String(name || '').trim();
    if (!wanted) return null;
    const entries = this._projectModels_().map((m, index) => ({ m, n: this._modelDisplayName_(m, index) }));
    const stripExt = (s) => s.toLowerCase().replace(/\.(gs|js|html|json)$/i, '');
    return entries.find((e) => e.n === wanted)?.m
      || entries.find((e) => e.n.toLowerCase() === wanted.toLowerCase())?.m
      || entries.find((e) => stripExt(e.n) === stripExt(wanted))?.m
      || null;
  }

  /**
   * Adaptador legado: aplica `proposed` al archivo `name` (modo archivo
   * completo, sin control de versión) por la ruta de `applyChangeSet`.
   * @param {string} name
   * @param {string} proposed
   * @param {{fromPreview?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, error?:string, unchanged?:boolean}>}
   * @private
   */
  async _applyFileEdits_(name, proposed, opts = {}) {
    const res = await this._applyChangeSetSafe_([{ name, mode: 'full', proposed: String(proposed ?? '') }], opts);
    if (res.ok) return res.results?.[0]?.status === 'unchanged' ? { ok: true, unchanged: true } : { ok: true };
    return { ok: false, error: res.error === 'not-found' ? 'not-found' : (res.error || 'apply-failed') };
  }

  /**
   * Ediciones mínimas por líneas (delegado en `GasEditApplier.fromFullText`).
   * @param {object} model
   * @param {string} next Texto propuesto normalizado a '\n'.
   * @returns {Array<object>|null}
   * @private
   */
  _buildLineEdits_(model, next) {
    if (typeof GasEditApplier === 'undefined') return null;
    return GasEditApplier.fromFullText(model.getLinesContent().join('\n'), next, GasCustomEditor._diffFn_());
  }

  /** Diff por líneas disponible en el MAIN world. @private */
  static _diffFn_() {
    return (typeof GasLineDiff !== 'undefined' && GasLineDiff?.diffLines)
      ? GasLineDiff.diffLines
      : window.GasDiffPreview?.diffLines?.bind(window.GasDiffPreview);
  }

  /** `getAlternativeVersionId()` del modelo o null. @private */
  static _versionOf_(model) {
    try { return typeof model?.getAlternativeVersionId === 'function' ? model.getAlternativeVersionId() : null; } catch (_) { return null; }
  }

  /**
   * Texto propuesto para la vista previa recalculado sobre el texto vivo.
   * @returns {{proposed?:string, conflict?:{reason:string, failed?:Array}}}
   * @private
   */
  _rebaseForPreview_(model, f, original) {
    if (typeof GasEditApplier === 'undefined') return { proposed: String(f?.proposed ?? '') };
    const r = GasEditApplier.rebase(original, f || {}, GasCustomEditor._versionOf_(model));
    return r.conflict ? { conflict: r.conflict } : { proposed: r.proposed };
  }

  /** `_applyChangeSet_` que nunca rechaza. @private */
  async _applyChangeSetSafe_(files, opts = {}) {
    try {
      return await this._applyChangeSet_(files, opts);
    } catch (err) {
      return { ok: false, error: String(err?.message || err), results: [] };
    }
  }

  /**
   * Aplica un ChangeSet en un solo paso por archivo, todo o nada (ver
   * `GasEditApplier.applyChangeSet`). Por defecto activa cada archivo con
   * `setModel` (GAS registra el cambio) y al final vuelve al archivo y view
   * state originales. Idempotente: un reintento tras un timeout no duplica.
   * @param {Array<object>} files
   * @param {{fromPreview?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, error?:string, results:Array<object>}>}
   * @private
   */
  async _applyChangeSet_(files, opts = {}) {
    const editor = this.editor;
    if (!editor) return { ok: false, error: 'no-editor', results: [] };
    if (typeof GasEditApplier === 'undefined') return { ok: false, error: 'applier-unavailable', results: [] };
    if (!opts.fromPreview && window.gasDiffPreview?.isActive?.()) window.gasDiffPreview.close();

    const startModel = editor.getModel?.() || null;
    const startView = editor.saveViewState?.() || null;
    const inPlace = GasCustomEditor.EDIT_INACTIVE_IN_PLACE;
    if (!this._appliedChanges || this._appliedChanges.size > 200) this._appliedChanges = new Map();

    const activate = (model) => {
      if (editor.getModel?.() !== model) editor.setModel(model);
    };
    const deps = {
      findModel: (n) => this._findModelByName_(n),
      diff: GasCustomEditor._diffFn_(),
      applied: this._appliedChanges,
      applyEdits: (model, edits) => {
        if (inPlace && editor.getModel?.() !== model) {
          model.pushStackElement();
          model.pushEditOperations([], edits, () => null);
          model.pushStackElement();
          return;
        }
        activate(model);
        editor.pushUndoStop();
        editor.executeEdits('gas-agent', edits);
        editor.pushUndoStop();
      },
      undo: async (model) => {
        if (!inPlace) activate(model);
        if (typeof model.undo === 'function') await model.undo();
      },
    };

    try {
      return await GasEditApplier.applyChangeSet(files, deps);
    } finally {
      // Volver al archivo y posición del usuario (sin tocar la vista previa)
      try {
        if (startModel && !startModel.isDisposed?.() && !GasCustomEditor._isPreviewModel_(startModel)
          && editor.getModel?.() !== startModel) {
          editor.setModel(startModel);
          if (startView) editor.restoreViewState?.(startView);
        }
      } catch (_) { /* editor destruido */ }
    }
  }

  /**
   * Simula Ctrl+S igual que `_triggerGasSave_` del panel de GitHub y espera
   * a que GAS procese el guardado.
   * @returns {Promise<{ok:boolean, error?:string}>}
   * @private
   */
  async _saveProject_() {
    if (window.gasDiffPreview?.isActive?.()) window.gasDiffPreview.close();
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        keyCode: 83,
        which: 83,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { ok: true };
  }

  /** Nombre legible de un modelo (mapa global `gasFileMap` o fallback). @private */
  _modelDisplayName_(model, index = 0) {
    const uri = String(model?.uri || '');
    return (uri && this._fileNameObjectMap?.get?.(uri)) || this._formatModelName(model, index);
  }

  /** Longitud de un modelo sin materializar el texto cuando es posible. @private */
  _modelLength_(model) {
    if (!model || model.isDisposed?.()) return 0;
    try {
      return typeof model.getValueLength === 'function'
        ? model.getValueLength()
        : String(model.getValue() || '').length;
    } catch (_) { return 0; }
  }

  /** Texto seleccionado en el editor ('' si la selección está vacía). @private */
  _selectedText_(editor, model) {
    const sel = editor?.getSelection?.();
    if (!sel || sel.isEmpty?.()) return '';
    try { return model.getValueInRange(sel) || ''; } catch (_) { return ''; }
  }

  // ──────────────────────────────────────────
  // ACCIONES DEL PROYECTO
  // ──────────────────────────────────────────

  /**
   * Inyecta el botón "Actions" junto al chat. El popover se monta una sola
   * vez en `<body>` como Web Component `<gas-actions-panel>` (Shadow DOM
   * aislado) y conserva su propio estado (toggle de visibilidad del árbol,
   * etc.) entre re-inyecciones.
   * @private
   */
  _injectActionsPanel_() {
    this._teardownActionsPanel_();

    // 1. Crear el popover único en body.
    this._actionsPanel = document.createElement('gas-actions-panel');
    document.body.appendChild(this._actionsPanel);

    // 2. Insertar el botón en cada toolbar activa (idempotente vía helper).
    this._injectToolbarButton_('buttonActionsGas', this.options.actionsButton);

    // 3. Click delegado: abre / cierra el popover anclado al botón.
    this._onActionsButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnActionsGas');
      if (!trigger) return;
      if (!trigger.closest('.INSTk') && !trigger.closest('#buttonActionsGas')) return;
      e.preventDefault();
      e.stopPropagation();
      this._actionsPanel?.toggle?.(trigger);
    };
    document.addEventListener('click', this._onActionsButtonClick);
  }

  /**
   * Elimina el botón "Actions" de las toolbars y el popover del body.
   * @private
   */
  _teardownActionsPanel_() {
    this._teardownToolbarUi_('buttonActionsGas', 'gas-actions-panel', [
      { prop: '_onActionsButtonClick', type: 'click' },
    ]);
    this._actionsPanel = null;
  }

  // ──────────────────────────────────────────
  // PANEL DE GITHUB
  // ──────────────────────────────────────────

  /**
   * Inyecta el botón "GitHub" en cada toolbar y monta el Web Component
   * `<gas-github-panel>` en el body. Atajo global: Alt+Shift+H.
   *
   * El panel decide internamente qué vista mostrar (login / conectado)
   * leyendo el estado de auth desde el background. Aquí solo nos
   * encargamos del cableado UI.
   * @private
   */
  _injectGithubPanel_() {
    this._teardownGithubPanel_();

    // 1. Crear el panel único en body.
    this._githubPanel = document.createElement('gas-github-panel');
    document.body.appendChild(this._githubPanel);
    this._githubPanel.setEditor(this.editor);

    // 2. Insertar el botón en cada toolbar activa.
    this._injectToolbarButton_('buttonGithubGas', this.options.githubButton);

    // 3. Aplicar el indicador de conexión en los botones recién creados.
    //    El panel valida la sesión y pinta el dot verde si corresponde.
    this._githubPanel.refreshBadge?.();

    // 3. Click delegado: abre/cierra el panel anclado al botón.
    this._onGithubButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnGithubGas');
      if (!trigger) return;
      if (!trigger.closest('.INSTk') && !trigger.closest('#buttonGithubGas')) return;
      e.preventDefault();
      e.stopPropagation();
      this._githubPanel?.toggle?.(trigger);
    };
    document.addEventListener('click', this._onGithubButtonClick);

    // 4. Atajos: global (Alt+Shift+H) y Monaco (mismo combo) si disponible.
    this._onGithubShortcut = this._bindGlobalShortcut_('h', () => {
      const anchor = document.querySelector('#rsBtnGithubGas');
      this._githubPanel?.toggle?.(anchor);
    });
    this._bindMonacoShortcut_(
      'gas-tools.github.toggle',
      window.monaco?.KeyCode?.KeyH,
      () => {
        const anchor = document.querySelector('#rsBtnGithubGas');
        this._githubPanel?.toggle?.(anchor);
      }
    );
  }

  /**
   * Elimina el botón "GitHub" de las toolbars y el panel del body.
   * @private
   */
  _teardownGithubPanel_() {
    this._teardownToolbarUi_('buttonGithubGas', 'gas-github-panel', [
      { prop: '_onGithubButtonClick', type: 'click' },
      { prop: '_onGithubShortcut',    type: 'keydown', capture: true },
    ]);
    this._disposeMonacoShortcut_('gas-tools.github.toggle');
    this._githubPanel = null;
  }

  // ──────────────────────────────────────────
  // INDICADOR DE ARCHIVO ACTIVO
  // ──────────────────────────────────────────

  /**
   * Inyecta el indicador de archivo activo en cada toolbar `.INSTk`.
   *
   * Estrategia:
   *  - El **botón** usa el HTML `currentFileButton.html` para reutilizar
   *    el estilo nativo de GAS (sin replicar clases ni estados Material).
   *  - El **popover** se monta una sola vez en `<body>` como Web Component
   *    `<gas-current-file>` (Shadow DOM aislado).
   *
   * El click sobre cualquier botón delegado en `#rsBtnCurrentFile`
   * abre/cierra el popover anclado a ese botón.
   * @private
   */
  _injectCurrentFile_() {
    if (!this._toolsMenuElements?.length) return;

    // 0. Inyectar estilos del botón (idempotente).
    this._injectCurrentFileStyles_();

    // 1. Asegurar el popover único en body.
    if (!this._currentFile || !document.body.contains(this._currentFile)) {
      this._currentFile = document.createElement('gas-current-file');
      document.body.appendChild(this._currentFile);
    }
    this._currentFile.setEditor(this.editor);
    this._buildUriToNameMap();
    this._currentFile.setFileNameObjectMap(this._fileNameObjectMap);

    // 2. Limpiar wrappers previos para evitar duplicados.
    document.querySelectorAll('#ctnCurrentFileName').forEach((el) => el.remove());

    // 3. Crear un wrapper alineado a la derecha en el padre de cada
    //    toolbar `.INSTk`. NO tocamos `.INSTk` ni el padre directamente:
    //    aplicamos `display:flex; flex-flow:row-reverse` y `margin-left:
    //    auto` solo al wrapper, suficiente para que se vaya al borde
    //    derecho cuando el padre ya es un flex container (caso normal en
    //    GAS).
    this._toolsMenuElements.forEach((toolbar) => {
      const wrapper = document.createElement('div');
      wrapper.id = 'ctnCurrentFileName';
      wrapper.className = 'qc__cfn-wrapper yggLIc';
      wrapper.style.cssText = [
        'display:flex',
        'flex-flow:row-reverse',
        'align-items:center',
        'margin-left:auto',
      ].join(';');
      this.DomUtils.setHTML(wrapper, this.options.fileButton);
      DomUtils.applyI18n(wrapper);
      // Como hermano DESPUÉS de `.INSTk` para quedar a la derecha del flow.
      toolbar.parentNode.insertBefore(wrapper, toolbar.nextSibling);
    });

    // 4. Click delegado: cualquier `#rsBtnCurrentFile` en una toolbar
    //    abre o cierra el popover anclado al propio botón.
    if (!this._onCurrentFileClick) {
      this._onCurrentFileClick = (e) => {
        const trigger = e.target.closest('#rsBtnCurrentFile');
        if (!trigger) return;
        if (!trigger.closest('#ctnCurrentFileName')) return;
        e.preventDefault();
        e.stopPropagation();
        this._buildUriToNameMap();
        this._currentFile?.setFileNameObjectMap(this._fileNameObjectMap);
        this._currentFile?.toggle?.(trigger);
      };
      document.addEventListener('click', this._onCurrentFileClick);
    }

    // 5. Refresco inicial del nombre/punto en el botón recién inyectado
    //    y enganche de listeners de Monaco para mantenerlo sincronizado.
    this._renderCurrentFileButton_();
    this._setupCurrentFileButtonListeners_();
  }

  /**
   * Inyecta los estilos del botón nativo como botón tonal GM3 (tokens
   * `--gt-*`; `!important` solo para ganar a las clases de GAS), con el
   * punto de estado y su pulso. El popover trae su propio CSS. Idempotente.
   * @private
   */
  _injectCurrentFileStyles_() {
    const STYLE_ID = 'qc__cfn-styles';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .qc__cfn-btn {
        display: inline-flex !important;
        align-items: center;
        gap: var(--gt-space-2);
        min-width: 200px;
        max-width: 260px;
        padding: 0 var(--gt-space-3) !important;
        border: 0 !important;
        border-radius: var(--gt-shape-full) !important;
        background: var(--gt-primary-container) !important;
        transition: background-color var(--gt-motion-duration) var(--gt-motion-standard),
          box-shadow var(--gt-motion-duration) var(--gt-motion-standard);
      }
      .qc__cfn-btn:hover {
        background: color-mix(in srgb, var(--gt-primary-container) 92%, var(--gt-on-primary-container)) !important;
        box-shadow: var(--gt-elevation-1);
      }
      .qc__cfn-btn .qc__cfn-name {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font-family: var(--gt-font-brand) !important;
        font-weight: 500 !important;
        color: var(--gt-on-primary-container) !important;
        letter-spacing: 0.2px;
      }
      .qc__cfn-dot {
        position: relative;
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: var(--gt-shape-full);
        background: transparent;
      }
      .qc__cfn-dot--error {
        background: var(--gt-error);
        animation: qc__cfn-pulse 1.6s ease-out infinite;
      }
      .qc__cfn-dot--warning { background: var(--gt-warning); }
      @keyframes qc__cfn-pulse {
        0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--gt-error) 55%, transparent); }
        70%  { box-shadow: 0 0 0 6px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      @media (prefers-reduced-motion: reduce) {
        .qc__cfn-dot--error { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Engancha listeners de Monaco para mantener actualizado el TEXTO y el
   * PUNTO del botón nativo. El popover se actualiza por sí solo.
   * Idempotente: libera listeners previos antes de reengancharse.
   * @private
   */
  _setupCurrentFileButtonListeners_() {
    if (this._cfnDisposables?.length) {
      this._cfnDisposables.forEach((d) => d?.dispose?.());
    }
    this._cfnDisposables = [];
    this._cfnRenderDebounced?.cancel?.();

    // Los markers cambian en cada pausa de tecleo (diagnósticos, Error
    // Lens): repintamos con debounce y solo si afectan al modelo activo.
    this._cfnRenderDebounced = this.DomUtils.debounce(() => this._renderCurrentFileButton_(), 150);

    // Solo markers: el cambio de modelo lo gestiona _onFileChange_ con el
    // mapa ya actualizado, así que no lo registramos aquí.
    if (window.monaco?.editor) {
      const d = window.monaco.editor.onDidChangeMarkers?.((uris) => {
        const active = this.editor?.getModel?.()?.uri?.toString?.();
        if (Array.isArray(uris) && active && !uris.some((u) => String(u) === active)) return;
        this._cfnRenderDebounced();
      });
      if (d) this._cfnDisposables.push(d);
    }
  }

  /**
   * Pinta el nombre del archivo y el punto de estado en cada botón
   * inyectado. El punto pulsa rojo si hay errores; ámbar fijo si solo
   * hay warnings; transparente si está limpio.
   * @private
   */
  _renderCurrentFileButton_() {
    const model = this.editor?.getModel?.();
    // Durante la vista previa de cambios se conserva el nombre del archivo real.
    if (GasCustomEditor._isPreviewModel_(model)) return;
    let name = '—';
    let severity = 'none';

    if (model) {
      const uri = String(model.uri || '');
      name = this._fileNameObjectMap.get(uri) || this._formatModelName(model);

      const list = window.monaco?.editor?.getModelMarkers?.({ resource: model.uri }) || [];
      let hasErr = false, hasWarn = false;
      for (const mk of list) {
        if (mk.severity === 8) { hasErr = true; break; }
        if (mk.severity === 4) hasWarn = true;
      }
      severity = hasErr ? 'error' : hasWarn ? 'warning' : 'none';
    }

    // Evento que muestra el nombre del archivo actual
    document.querySelectorAll('#ctnCurrentFileName').forEach((wrapper) => {
      const btnCurrentFile_ = wrapper.querySelector('#ctnCurrentFileName .qc__cfn-host');
      const nameEl = wrapper.querySelector('#qcCfnName');
      const dotEl  = wrapper.querySelector('#qcCfnDot');
      if (nameEl) {
        nameEl.textContent = name;
        btnCurrentFile_?.setAttribute("data-tt", name);
      }
      if (dotEl) {
        dotEl.classList.remove('qc__cfn-dot--error', 'qc__cfn-dot--warning');
        if (severity === 'error')   dotEl.classList.add('qc__cfn-dot--error');
        if (severity === 'warning') dotEl.classList.add('qc__cfn-dot--warning');
      }
    });

    // Sincronizar también el popover por si está abierto.
    this._currentFile?.refresh?.();
  }

  /**
   * Elimina el indicador de archivo activo en todas las toolbars y libera
   * disposables/listener delegado.
   * @private
   */
  _teardownCurrentFile_() {
    document.querySelectorAll('#ctnCurrentFileName').forEach((el) => el.remove());
    document.querySelectorAll('gas-current-file').forEach((el) => el.remove());
    document.getElementById('qc__cfn-styles')?.remove();
    this._currentFile = null;

    if (this._onCurrentFileClick) {
      document.removeEventListener('click', this._onCurrentFileClick);
      this._onCurrentFileClick = null;
    }
    if (this._cfnDisposables?.length) {
      this._cfnDisposables.forEach((d) => d?.dispose?.());
      this._cfnDisposables = [];
    }
    this._cfnRenderDebounced?.cancel?.();
  }

  // ──────────────────────────────────────────
  // SETTINGS
  // ──────────────────────────────────────────

  /**
   * Aplica un mapa de opciones directamente sobre la instancia de Monaco.
   * Ignora claves desconocidas y el toggle `global-enable` (se maneja por separado).
   *
   * @param {Object} settings - Mapa `{ optionId: valor }` con las opciones a aplicar.
   */
  applySettings(settings) {
    // Opciones que no dependen de Monaco: se aplican aunque no haya editor.
    if ('debug-mode' in settings) DomUtils.setDebug(settings['debug-mode'] === true);
    if ('gas-error-lens' in settings || 'gas-error-lens-custom-rules' in settings) {
      this._applyErrorLensCustomRules_();
    }
    if (!this.editor) return;

    // Toggles: aceptan booleanos y los textos heredados ('on', 'none', ...).
    const toBool = GasCustomEditor.toBool_;
    // Estilos de cursor válidos (valor = TextEditorCursorStyle). `updateOptions`
    // solo acepta el nombre: Monaco descarta números y vuelve a 'line'.
    const CURSOR_STYLES = { 'line': 1, 'block': 2, 'underline': 3, 'line-thin': 4, 'block-outline': 5, 'underline-thin': 6 };

    // Tabla de handlers: cada clave mapea a la llamada updateOptions correspondiente
    const SETTINGS_MAP = {
      // Visuales & Layout
      'showMinimap': (val) => this.editor.updateOptions({ minimap: { enabled: val } }),
      'lineNumbers': (val) => this.editor.updateOptions({ lineNumbers: toBool(val) ? 'on' : 'off' }),
      'wordWrap': (val) => this.editor.updateOptions({ wordWrap: val ? 'on' : 'off' }),
      'renderLineHighlight': (val) => this.editor.updateOptions({ renderLineHighlight: toBool(val) ? 'line' : 'none' }),
      'rulers': (val) => this.editor.updateOptions({ rulers: toBool(val) ? [80, 120] : [] }),
      'occurrencesHighlight': (val) => this.editor.updateOptions({ occurrencesHighlight: toBool(val) ? 'singleFile' : 'off' }),
      'renderWhitespace': (val) => this.editor.updateOptions({ renderWhitespace: toBool(val) ? 'selection' : 'none' }),
      // Font
      // 'fontFamily': (val) => this.editor.updateOptions({ fontFamily: val }),
      'fontFamily': (val) => {

        // Incrementamos el ID de request para invalidar cualquier promesa anterior en vuelo
        const requestId = ++this._fontRequestId;

        // Aplicar inmediatamente para fuentes de sistema (sin latencia)
        this.editor.updateOptions({ fontFamily: val });

        this._loadGoogleFont_(val).then(() => {
          // Si llegó una selección más nueva mientras cargábamos, descartamos esta
          if (requestId !== this._fontRequestId) return;
          this.editor.updateOptions({ fontFamily: val });
        });
      },
      'fontSize': (val) => this.editor.updateOptions({ fontSize: parseInt(val, 10) }),
      'lineHeight': (val) => this.editor.updateOptions({ lineHeight: parseInt(val, 10) }),
      // Code Assistance
      'bracketPairs': (val) => this.editor.updateOptions({ bracketPairColorization: { enabled: val } }),
      'quickSuggestions': (val) => this.editor.updateOptions({ quickSuggestions: val }),
      'autoClosingBrackets': (val) => this.editor.updateOptions({ autoClosingBrackets: toBool(val) ? 'always' : 'never' }),
      'guides-indentation': (val) => this.editor.updateOptions({ guides: { indentation: val } }),
      // Navigation
      'folding': (val) => this.editor.updateOptions({ folding: val }),
      // Scrolling
      'smoothScrolling': (val) => this.editor.updateOptions({ smoothScrolling: val }),
      'scrollBeyondLastLine': (val) => this.editor.updateOptions({ scrollBeyondLastLine: toBool(val) }),
      // Editor Behavior
      'tabSize': (val) => {
        const size = parseInt(val, 10) || 2;
        const model_ = this.editor.getModel();
        if (model_) {
          model_.updateOptions({ tabSize: size, indentSize: size, insertSpaces: true });
        }
      },
      'cursorStyle': (val) => this.editor.updateOptions({ cursorStyle: Object.hasOwn(CURSOR_STYLES, val) ? val : 'line' }),
      'cursorBlinking': (val) => this.editor.updateOptions({ cursorBlinking: val }),

      /**
       * Habilita o deshabilita el autocompletado AI basado en el toggle del popup.
       * @param {boolean} val - Estado de habilitación.
       */
      'ai-autocomplete': (val) => {
        this.initAiAutocomplete_();

        // Habilitamos o deshabilitamos el AI Autocomplete
        if (this._aiAutocomplete) {
          val ? this._aiAutocomplete.enable() : this._aiAutocomplete.disable();
        }
      },

      /**
       * Aplica o remueve el tema dark al entorno completo del IDE de GAS.
       * @param {boolean} val - Estado de habilitación.
       */
      'ide-dark-mode': (val) => this._applyIdeDarkMode(val),
    };

    Object.entries(settings).forEach(([key, value]) => {
      // El toggle global se gestiona en el listener de GAS_SettingsUpdated, no aquí
      if (key === 'global-enable') return;
      const handler = SETTINGS_MAP[key];
      if (handler) {
        try {
          handler(value);
        } catch (err) {
          // Setting inválido: lo ignoramos, pero lo dejamos visible en debug.
          DomUtils.debug('Settings', `No se pudo aplicar "${key}"`, err);
        }
      }
    });
  }

  /**
   * Propaga `gas-error-lens-custom-rules` al servicio Error Lens. Se lee
   * de `_settings` (estado completo) porque las actualizaciones parciales
   * pueden traer solo `gas-error-lens`. Se repite en el siguiente tick
   * por si Error Lens se (re)habilita después de este listener.
   * @private
   */
  _applyErrorLensCustomRules_() {
    const apply = () => {
      if (window.__gasGloballyDisabled) return;
      const enabled = this._settings?.['gas-error-lens-custom-rules'] === true;
      window.gasErrorLens?.setCustomRulesEnabled?.(enabled);
    };
    apply();
    setTimeout(apply, 0);
  }

  /**
   * Inicializa la instancia del autocompletado AI si no existe.
   * Verifica que la clase GasAiAutocomplete esté cargada en el contexto global
   * antes de intentar instanciarla para evitar ReferenceErrors.
   * @private
   */
  initAiAutocomplete_() {
    // Si no existe la instancia de AI Autocomplete, la creamos
    if (!this._aiAutocomplete) {
      this._aiAutocomplete = new GasAiAutocomplete(this.editor);
    }
  }

  /**
   * Carga una fuente desde Google Fonts solo si el browser no la tiene ya disponible.
   * Verifica con document.fonts.check() antes de inyectar el <link> para evitar
   * requests redundantes (fuentes de sistema o ya cargadas previamente).
   *
   * @param {string} fontName - Nombre exacto de la fuente (ej: "JetBrains Mono").
   * @returns {Promise<void>}
   * @private
   */
  async _loadGoogleFont_(fontName) {
    // Fuentes del sistema que el browser ya tiene sin necesitar Google Fonts
    const SYSTEM_FONTS = ['Consolas', 'Monaco', 'Menlo', 'Courier New', 'Courier', 'monospace'];
    if (SYSTEM_FONTS.includes(fontName)) return;

    // ID de la fuente cargada
    const fontId = `qc-font-${fontName.replace(/\s+/g, '-').toLowerCase()}`;

    // Evitar inyectar el mismo <link> dos veces aunque la fuente aún no haya cargado
    if (document.getElementById(fontId)) {
      // El link ya existe pero la fuente puede estar en flight: esperamos a que esté lista
      await document.fonts.ready;
      return;
    }

    // URL de la fuente en Google Fonts
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:ital,wght@0,400;0,500;0,700;1,400&display=swap`;

    // Inyectar <link>
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.id = fontId;
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = async () => {
        // Esperamos a que el FontFaceSet confirme que la fuente está activa
        await document.fonts.ready;
        resolve();
      };
      link.onerror = () => {
        resolve(); // Monaco usará el fallback, pero no bloqueamos
      };
      document.head.appendChild(link);
    });
  }

  /**
   * Aplica o remueve el tema oscuro del IDE de Apps Script.
   *  1. `qc__is-dark-mode` en `<body>`: única fuente de verdad; los tokens
   *     `--gt-*` (gas-ui.js) cambian solos y los paneles los heredan.
   *  2. `<style id="qc__ide-dark-mode">` para los nodos nativos de GAS
   *     (selectores en `GasCustomEditor.IDE_SELECTORS`).
   *
   * @param {boolean} enabled - true para aplicar dark mode, false para removerlo.
   * @private
   */
  _applyIdeDarkMode(enabled) {
    const styleId = 'qc__ide-dark-mode';
    const existing = document.getElementById(styleId);
    document.body.classList.toggle('qc__is-dark-mode', !!enabled);

    if (!enabled) {
      existing?.remove();
      return;
    }
    if (DomUtils.isDebug()) this._auditIdeSelectors_();
    if (existing) return; // Ya aplicado

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = this._ideDarkModeCss_();
    document.head.appendChild(style);
  }

  /**
   * CSS del modo oscuro para los nodos nativos de GAS. Colores de los
   * tokens `--gt-*` (body.qc__is-dark-mode); los `#F7F7F7` + `invert()`
   * son el truco de inversión para paneles que GAS pinta en claro.
   * @returns {string}
   * @private
   */
  _ideDarkModeCss_() {
    const S = GasCustomEditor.IDE_SELECTORS;
    const each = (sel, suffix) => sel.split(',').map((s) => `${s.trim()}${suffix}`).join(', ');
    const nested = S.invertedTree.split(',').map((s) => `${s.trim()} ${s.trim()}`).join(', ');
    return `
      /* IDE DARK MODE - Google Apps Script Tools (tokens --gt-* de gas-ui.js). */
      body { background: var(--gt-background) !important; }

      ${S.accountName}, ${S.productName} { color: var(--gt-on-surface) !important; }
      ${S.mutedText}, ${S.labelText} { color: var(--gt-on-surface-variant) !important; }

      /* Cabecera y navegación superior */
      ${S.topBar} {
        background: var(--gt-background) !important;
        border-bottom: 1px solid var(--gt-outline-variant) !important;
      }
      header { background: var(--gt-background) !important; }

      /* Separadores y bordes */
      ${S.separators} { border-top: 1px solid var(--gt-outline-variant) !important; }
      ${each(S.toolbarGroup, '::after')} { border-right: 1px solid var(--gt-surface-container) !important; }
      ${S.sideBorders} { border-left: 1px solid var(--gt-outline-variant) !important; }

      /* Texto */
      :not(.UeVsd) > ${S.treeItemName},
      .qc__folder-children li[role="option"] div[title]::before,
      .qc__folder-header,
      ${S.foregroundText},
      ${S.inputText} { color: var(--gt-on-surface) !important; }
      ${S.inverseText} { color: var(--gt-background) !important; }

      /* Archivo activo del árbol: acento primario tenue. */
      ${S.treeItemActive} {
        filter: none !important;
        background: color-mix(in srgb, var(--gt-primary) 12%, transparent) !important;
        border-radius: 2px;
      }
      ${S.treeItemActive} ${S.treeItemName} { color: var(--gt-on-surface) !important; }

      /* Paneles, modales y menús (inversión de colores) */
      div[aria-modal="true"]:not(.gt-dialog),
      div[role="menu"]:not(.gt-menu),
      div[role="complementary"],
      ${S.invertedSurfaces} {
        background: #F7F7F7 !important;
        filter: invert(1) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      /* Sidebar y árbol: invertidos. Carpetas e iconos propios usan tokens
         --gt-* y conservan su color real (sin contra-inversión). */
      ${S.invertedTree} {
        filter: invert(1) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      /* Inputs */
      ${S.inputText}, ${S.inputs}, input[type="text"] { text-shadow: 0 0 0 rgba(0, 0, 0, 1); }

      /* Toolbar */
      ${S.toolbar} {
        background: #F7F7F7 !important;
        filter: invert(100%) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }
      div${S.toolbar} ${S.toolbarItem} { position: static !important; }
      ${S.toolbarReinvert} { filter: invert(100%) !important; }

      /* Botones inyectados (LjDxcd → invertidos): lo pintado con --gt-*
         se contra-invierte para conservar el color de token oscuro. */
      #ctnCurrentFileName .qc__cfn-btn { filter: none !important; }
      .qc__gh-dot { filter: invert(1); }

      /* Editor Monaco y área de código */
      ${S.editorArea} {
        filter: invert(1) contrast(1) !important;
        -webkit-font-smoothing: none;
        -moz-osx-font-smoothing: unset;
      }

      /* Fondos claros para elementos invertidos */
      ${S.lightBackdrops} { background: #F7F7F7 !important; }

      /* Scrollbars */
      ::-webkit-scrollbar { background: var(--gt-background) !important; width: 6px !important; }
      ::-webkit-scrollbar-thumb { background: var(--gt-surface-container) !important; }
      ::-webkit-scrollbar-thumb:hover { background: var(--gt-outline) !important; }

      c-wiz[data-p] { background: var(--gt-background) !important; }

      /* Prevenir doble inversión en elementos anidados */
      ${nested} { filter: none !important; }
    `;
  }

  /**
   * Modo debug: avisa de los selectores de `IDE_SELECTORS` sin coincidencias
   * (señal de que GAS cambió sus clases ofuscadas).
   * @private
   */
  _auditIdeSelectors_() {
    for (const [key, selector] of Object.entries(GasCustomEditor.IDE_SELECTORS)) {
      let found = false;
      try { found = !!document.querySelector(selector); } catch (_) { /* selector inválido */ }
      if (!found) console.debug('[GASTools:DarkMode] selector sin coincidencias:', key, selector);
    }
  }

  // ──────────────────────────────────────────
  // SNIPPETS  // ──────────────────────────────────────────
  // SNIPPETS
  // ──────────────────────────────────────────

  /**
   * Registra los snippets del estado interno como completion providers en Monaco.
   * Los providers se registran una sola vez (flag estático); las actualizaciones
   * posteriores se reflejan automáticamente porque los providers leen de `this._snippets`.
   *
   * @async
   */
  async reloadSnippets() {
    try {
      // Sincronizamos el estado interno desde options si aún no hay snippets en memoria
      if (!this._snippets.length && this.options.snippets?.length) {
        this._snippets = this.options.snippets;
      }

      // Los providers globales leen los snippets de la instancia dueña.
      GasCustomEditor.snippetOwner = this;

      // Si los providers ya están registrados, no necesitamos hacer nada más:
      // leen `snippetOwner._snippets` en cada invocación.
      if (GasCustomEditor.providersRegistered) return;

      // Grupos de lenguajes que soportamos; 'google apps script' es el identificador
      // que Monaco asigna a los archivos .gs en el editor de GAS
      const langGroups = [
        { id: 'html', types: ['html'] },
        { id: 'javascript', types: ['javascript', 'typescript', 'js', 'google apps script'] },
        { id: 'google apps script', types: ['javascript', 'typescript', 'js', 'google apps script'] },
      ];

      langGroups.forEach(group => {
        const disposable = monaco.languages.registerCompletionItemProvider(group.id, {
          provideCompletionItems: (model, position) => {
            if (GasCustomEditor._isPreviewModel_(model)) return { suggestions: [] };
            const owner = GasCustomEditor.snippetOwner || this;
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            // Filtramos desde el estado interno de la instancia (siempre actualizado)
            const filtered = (owner._snippets || []).filter(s =>
              group.types.includes(s.lang?.toLowerCase())
            );
            return { suggestions: owner._buildSuggestions(filtered, range) };
          },
        });
        if (disposable) GasCustomEditor.snippetProviderDisposables.push(disposable);
      });

      // Marcamos como registrado a nivel de clase para que nuevas instancias no dupliquen
      GasCustomEditor.providersRegistered = true;
      DomUtils.debug('Snippets', 'Completion providers registrados.');
    } catch (err) {
      DomUtils.debug('Snippets', 'Error al registrar snippets', err);
    }
  }

  /**
   * Libera los completion providers de snippets y resetea el flag para
   * que el próximo `reloadSnippets()` los registre de nuevo (una sola vez).
   * @private
   */
  _disposeSnippetProviders_() {
    GasCustomEditor.snippetProviderDisposables.forEach((d) => {
      try { d?.dispose?.(); } catch (_) { /* ignorar */ }
    });
    GasCustomEditor.snippetProviderDisposables = [];
    GasCustomEditor.providersRegistered = false;
  }

  /**
   * Convierte los snippets del estado interno en objetos de sugerencia de Monaco.
   *
   * @param {Array}         snippets - Lista de snippets a convertir.
   * @param {monaco.IRange} range    - Rango de reemplazo en el editor.
   * @returns {Array} Array de objetos `CompletionItem` listos para Monaco.
   * @private
   */
  _buildSuggestions(snippets, range) {
    return snippets.map(snip => ({
      label: snip.prefix,
      kind: monaco.languages.CompletionItemKind.Snippet,
      documentation: snip.title,
      detail: `[${snip.lang}] ${snip.title}`,
      insertText: snip.code,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range,
    }));
  }

  // ──────────────────────────────────────────
  // TEMAS
  // ──────────────────────────────────────────

  /**
   * Aplica el tema del estado interno a Monaco.
   * Si el tema es custom (no nativo), lo define en Monaco antes de aplicarlo.
   * Instala el interceptor de setTheme para que nuestra extensión siempre gane.
   *
   * @async
   */
  async reloadTheme() {
    try {
      // Usamos el estado interno; options.activeTheme se mantiene sincronizado
      if (window.__gasGloballyDisabled) return;
      const themeData = this._activeTheme || this.options.activeTheme;
      if (!themeData) return;

      // Temas nativos de Monaco que no necesitan ser definidos
      const NATIVE_THEMES = ['vs', 'vs-dark', 'hc-black', 'hc-light'];
      const isNative = themeData.protected && NATIVE_THEMES.includes(themeData.value);
      // Los temas custom reciben un prefijo para evitar colisiones con los nativos
      const themeName = isNative ? themeData.value : `qc-theme-${themeData.value}`;

      // Registrar el tema custom en Monaco (solo necesario si tiene datos y no es nativo)
      if (!isNative && themeData.data) {
        monaco.editor.defineTheme(themeName, this._buildMonacoTheme(themeData));
      }

      // Instalar el interceptor para que GAS no pueda sobreescribir nuestro tema
      this._interceptSetTheme(themeName);

      // Aplicar inmediatamente usando la función original (no el interceptor)
      monaco.editor.setTheme(themeName);
    } catch (err) {
      DomUtils.debug('Theme', 'Error al cargar tema', err);
    }
  }

  /**
   * Monkey-patch de `monaco.editor.setTheme`.
   * Cualquier llamada externa (GAS u otra extensión) que intente cambiar el tema
   * será interceptada y reemplazada por el nuestro.
   * El patch se instala una sola vez; si el tema cambia, solo se actualiza `_activeThemeName`.
   *
   * @param {string} ourThemeName - Nombre del tema que debe imponerse.
   * @private
   */
  _interceptSetTheme(ourThemeName) {
    // Actualizamos el nombre objetivo para que el interceptor siempre use el más reciente
    this._activeThemeName = ourThemeName;

    // Si ya patcheamos, solo actualizamos el nombre objetivo y salimos
    if (this._themePatched) return;

    // Guardamos setTheme original para poder restaurarla en _releaseThemeControl()
    this.originalSetTheme = monaco.editor.setTheme.bind(monaco.editor);
    const self = this;

    monaco.editor.setTheme = function (requestedTheme) {
      const target = self._activeThemeName;
      // Si el llamante ya pide nuestro tema, dejamos pasar sin recursión
      if (requestedTheme === target) return self.originalSetTheme(requestedTheme);
      // Cualquier otro intento de cambio lo bloqueamos y aplicamos el nuestro
      return self.originalSetTheme(target);
    };

    this._themePatched = true;
  }

  /**
   * Convierte la entrada de tema del popup al formato `IStandaloneThemeData` de Monaco.
   *
   * @param {Object} themeEntry       - Entrada del tema tal como viene del storage.
   * @param {Object} themeEntry.data  - Datos crudos del archivo JSON del tema.
   * @returns {monaco.IStandaloneThemeData}
   * @private
   */
  _buildMonacoTheme(themeEntry) {
    const data = themeEntry.data || {};

    // Normalizar colores del mapa de tokens
    const colors = {};
    if (data.colors && typeof data.colors === 'object') {
      Object.entries(data.colors).forEach(([key, value]) => {
        colors[key] = this._normalizeColor(value);
      });
    }

    // Normalizar las reglas de sintaxis; omitir fontStyle 'normal' para no sobreescribir defaults
    const rules = (data.rules || [])
      .map(rule => ({
        token: rule.token,
        foreground: this._normalizeColor(rule.foreground).replace('#', ''),
        fontStyle: rule.fontStyle !== 'normal' ? rule.fontStyle : undefined,
      }))
      .filter(r => r.token);

    return {
      base: data.base || 'vs-dark',
      inherit: data.inherit !== false,
      rules,
      colors,
    };
  }

  /**
   * Normaliza un string de color al formato `#RRGGBB` o `#RRGGBBAA` que espera Monaco.
   * Expande colores cortos (#RGB → #RRGGBB) y añade `#` si falta.
   * Devuelve `#ffffff` como fallback seguro.
   *
   * @param {string} color - Color en cualquier formato hex.
   * @returns {string} Color normalizado.
   * @private
   */
  _normalizeColor(color) {
    if (!color || typeof color !== 'string') return '#ffffff';
    const c = color.trim().startsWith('#') ? color.trim() : `#${color.trim()}`;
    // Expandir formato corto #RGB → #RRGGBB
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    // Formato largo válido (#RRGGBB o #RRGGBBAA)
    if (/^#[0-9a-fA-F]{6,8}$/.test(c)) return c;
    // Último intento: limpiar caracteres no hex y tomar los primeros 6 dígitos
    const digits = c.replace('#', '').replace(/[^0-9a-fA-F]/g, '');
    return digits.length >= 6 ? `#${digits.substring(0, 6)}` : '#ffffff';
  }

  // ──────────────────────────────────────────
  // HABILITAR / DESHABILITAR
  // ──────────────────────────────────────────

  /**
   * Desactiva la extensión y limpia todos los cambios inyectados.
   */
  disable() {
    DomUtils.debug('Editor', 'disable()');
    //  Mostramos el sidebar
    const actionsPanel_ = document.querySelector('gas-actions-panel');
    if (actionsPanel_){
      actionsPanel_.showPanel();
    }
    
    // 1. Limpiar el estado interno
    this._settings = {};
    this._snippets = [];
    this._activeTheme = null;
    // 2. Restaurar el control del tema a GAS
    this._releaseThemeControl();
    // 3. Revertir opciones del editor a los defaults de Monaco/GAS
    this._resetEditorDefaults();
    // 4. Eliminar la UI inyectada y los listeners
    this._teardownInjectedUi_();
    // 5. Remover el tema dark del IDE y la clase canónica del body (los
    //    tokens --gt-* vuelven a claro en todos los paneles).
    document.getElementById('qc__ide-dark-mode')?.remove();
    document.body.classList.remove('qc__is-dark-mode');
    document.getElementById('gt-toast-host')?.remove();

    // 6. Deshabilitar autocompletado AI si existe
    if (this._aiAutocomplete) {
      this._aiAutocomplete.disable();
    }

    // 7. Liberar los providers de snippets (enable() los re-registra).
    this._disposeSnippetProviders_();

    // 8. Desconectar el bridge del editor (enable() lo re-registra) y
    // cerrar la vista previa de cambios si estaba abierta.
    this._unbindEditorBridge_();
    try { window.gasDiffPreview?.close?.(); } catch (_) { /* editor ya destruido */ }
  }

  /**
   * Reactiva la extensión con el estado guardado en memoria.
   */
  enable() {
    DomUtils.debug('Editor', 'enable()');
    // Restaurar el estado desde memoria (o desde options si aún no hay nada en memoria)
    const settingsToApply = Object.keys(this._settings).length > 0
      ? this._settings
      : (this.options.settings || {});
    const snippetsToUse = this._snippets.length > 0
      ? this._snippets
      : (this.options.snippets || []);
    const themeToUse = this._activeTheme || this.options.activeTheme;

    // Sincronizar estado interno con los valores que se van a aplicar
    this._settings = settingsToApply;
    this._snippets = snippetsToUse;
    this._activeTheme = themeToUse;
    // Mantener options sincronizado para mergeAndReinit
    this.options.settings = settingsToApply;
    this.options.snippets = snippetsToUse;
    this.options.activeTheme = themeToUse;

    // Refrescar la raíz DOM activa antes de reinyectar UI / consultar el árbol.
    this._refreshRootParent_();

    // Re-inyectar botones y paneles sin pasar por init()
    this._reinjectUI_();
    this._bindEditorBridge_();

    // Reaplicar settings, snippets y tema desde el estado ya sincronizado
    this.applySettings(settingsToApply);
    this.reloadSnippets();
    this.reloadTheme();
  }

  /**
   * Re-inyecta los elementos de UI sin reinicializar todo desde cero.
   * Usa requestAnimationFrame para alinear las operaciones DOM con el
   * ciclo de renderizado del navegador.
   * @private
   */
  _reinjectUI_() {
    const inject = () => {
      this._injectSidePanelButton_();
      this._injectActionsPanel_();
      this._injectGithubPanel_();
      this._injectCurrentFile_();
    };

    requestAnimationFrame(() => {
      if (this._toolsMenuElements?.length) {
        inject();
        return;
      }
      // Las toolbars pueden no existir si disable() se llamó muy temprano.
      this._waitForToolsMenu_().then((list) => {
        this._toolsMenuElements = list;
        if (list.length) requestAnimationFrame(inject);
      });
    });
  }

  /**
   * Limpia toda la UI inyectada: botones (en todas las toolbars), paneles,
   * listeners delegados y atajos globales. También libera los disposables
   * de Monaco (incluidos los atajos) y detiene el intervalo de
   * verificación de cambio de archivo.
   * @private
   */
  _teardownInjectedUi_() {
    // Cerrar paneles antes de eliminarlos para que cierren listeners propios.
    this._actionsPanel?.close?.();
    this._githubPanel?.close?.();

    // Delegar el teardown específico (botones + paneles + listeners + atajos).
    this._teardownSidePanelButton_();
    this._teardownActionsPanel_();
    this._teardownGithubPanel_();
    this._teardownCurrentFile_();

    // Limpiar elementos auxiliares que pudieran haber quedado de versiones
    // anteriores (no atados a los teardown específicos).
    document.querySelectorAll('#sltRubThemeList').forEach((el) => el.remove());

    // Liberar disposables de Monaco para evitar memory leaks.
    this._modelChangeDisposable?.dispose();
    this._modelChangeDisposable = null;
    this._disposeMonacoShortcut_();

    this._stopFileCheckInterval_();
    this._lastModelUri = null;
  }

  /**
   * Restaura `monaco.editor.setTheme` a su implementación original
   * y aplica el tema por defecto de GAS para que retome el control visual.
   * @private
   */
  _releaseThemeControl() {
    // Solo restaurar si el patch está activo y tenemos la función original guardada
    if (!this._themePatched || !this.originalSetTheme) return;
    // Restauramos la función original en Monaco
    monaco.editor.setTheme = this.originalSetTheme;
    this._themePatched = false;
    this._activeThemeName = null;
    // Dejamos que GAS retome el control con su tema por defecto
    monaco.editor.setTheme(this._defaultThemeName);
  }

  /**
   * Revierte las opciones del editor Monaco a los valores por defecto de GAS.
   * @private
   */
  _resetEditorDefaults() {
    if (!this.editor) return;
    try {
      this.editor.updateOptions({
        // Visuales
        minimap: { enabled: false },
        lineNumbers: 'on',
        wordWrap: 'off',
        renderLineHighlight: 'line',
        // Asistencia de código
        bracketPairColorization: { enabled: false },
        quickSuggestions: true,
        autoClosingBrackets: 'always',
        tabCompletion: 'off',
        formatOnPaste: false,
        // Navegación
        folding: true,
        foldingHighlight: true,
        definitionLinkOpensInPeek: false,
        // Scroll
        smoothScrolling: false,
        scrollBeyondLastLine: true,
      });
    } catch (_) { /* ignorar fallos al revertir */ }
  }
}
