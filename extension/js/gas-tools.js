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
   * @param {Object} options               - Datos iniciales del editor.
   * @param {Object} options.settings      - Toggles de configuración del usuario.
   * @param {Array}  options.snippets      - Snippets del usuario + predeterminados.
   * @param {Object} options.activeTheme   - Entrada del tema activo.
   * @param {string} options.chatButton    - HTML del botón del chat AI.
   * @param {string} options.fileButton    - HTML del indicador de archivo activo.
   * @param {string} options.actionsButton - HTML del botón de acciones del proyecto.
   * @param {string} options.themeUrl      - URL base de la carpeta de temas.
   * @param {string} options.referenceId   - UUID del editor Monaco al que corresponde esta instancia.
   */
  constructor(options) {

    // ── Estado principal ─────────────────────────────────────────
    // Copia defensiva para no mutar el objeto original recibido del content script
    this._settings = { ...(options.settings || {}) };
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
    this._chatPanel = null;

    // ── Listeners (guardados para poder eliminarlos en disable()) ─
    this._onChatButtonClick = null;
    this._onChatShortcut = null;

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
    this._githubMonacoCommandBound = false;

    // ── Flags de registro único ──────────────────────────────────
    // Solo aplican a comandos registrados con `editor.addCommand` (Monaco
    // no expone API para deshacerlos, por eso se registran una sola vez).
    this._chatMonacoCommandBound = false;

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
    // web components (gas-current-file, gas-chat-panel) lo consuman
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
      this.editor = null;
    }
    this.init();
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
    // Permite establecer el elemento padre de todas las opciones
    if (cwizRootParent_) this._setRootParent_(cwizRootParent_);

    // Elemento Monaco al que está anclada esta instancia (útil para mejoras futuras por editor)
    this.element = document.querySelector(`[data-gasreference='${this.options.referenceId}']`);
    if (!this.element) return;

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

    // Debounce compartido: si llegan varios eventos seguidos (p. ej. el
    // intervalo y onDidChangeModel al mismo tiempo), solo ejecutamos una vez.
    let debounceTimer = null;
    const scheduleFileChange = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this._onFileChange_(), 150);
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
    // Refrescar la raíz por si la navegación SPA cambió la `c-wiz` activa.
    this._refreshRootParent_();
    if (this._snippets.length > 0) this.reloadSnippets();
    this.reloadTheme();

    // Construye el mapa y refresca todos los consumidores en cadena.
    const syncAll = () => {
      this._buildUriToNameMap();
      this._chatPanel?.setEditor?.(this.editor);
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

    [120, 350, 800].forEach((delay) => {
      setTimeout(() => {
        if (isResolved()) return;
        syncAll();
      }, delay);
    });
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
    const containers = document.querySelectorAll('c-wiz[data-p]');
    let next = null;

    if (containers.length === 1 && containers[0].getAttribute('aria-hidden') !== 'true') {
      next = containers[0];
    } else {
      next = document.querySelector(
        'c-wiz[data-p]:not([aria-hidden="true"]):not([aria-busy="true"])'
      );
    }

    if (next) this._rootParent = next;
    return this._rootParent ?? null;
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

    const files = items
      .map(li => ({
        name:   li.getAttribute('aria-label')?.trim(),
        index:  parseInt(li.getAttribute('data-index'), 10),
        active: li.getAttribute('aria-selected') === 'true',
      }))
      .filter(f => f.name)
      .sort((a, b) => a.index - b.index);

    const normalFiles = files.filter(f => f.name !== 'appsscript.json');
    const appScript = files.find(f  => f.name === 'appsscript.json');

    // Modelos de Monaco ordenados por ID numérico
    const models = (window.monaco?.editor?.getModels?.() || [])
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
   *   (p.ej. `'gas-chat-panel'`).
   * @param {{type:string, capture?:boolean}[]} listenerSpecs  Lista de
   *   listeners a quitar; cada uno con la propiedad de instancia que lo
   *   guarda (`prop`) y el tipo de evento (`type`, `capture` opcional).
   * @private
   */
  _teardownToolbarUi_(buttonId, panelTag, listenerSpecs) {
    document.querySelectorAll(`#${buttonId}`).forEach((el) => el.remove());
    document.querySelector(panelTag)?.remove();
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
   * Registra un atajo dentro de Monaco. `editor.addCommand` no expone
   * API de remoción, así que el caller debe pasar un flag de "ya
   * registrado" para evitar duplicados al re-inyectar.
   *
   * @param {string} flagProp   Propiedad de instancia que actúa de guard.
   * @param {number} keyCode    `monaco.KeyCode.KeyX` correspondiente.
   * @param {() => void} run    Acción a ejecutar.
   * @private
   */
  _bindMonacoShortcut_(flagProp, keyCode, run) {
    if (this[flagProp]) return;
    if (!this.editor?.addCommand || !window.monaco?.KeyMod) return;
    this[flagProp] = true;
    this.editor.addCommand(
      window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | keyCode,
      run
    );
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
      toolbar.parentNode.insertBefore(option, toolbar);
    });
  }

  /**
   * Mantiene la UI inyectada al día con un comportamiento idempotente:
   *
   *  - Si el panel de chat falta en el body (GAS desmontó la página por
   *    completo), reinyecta TODO desde cero.
   *  - Si el panel sigue vivo, solo añade los botones faltantes a las
   *    toolbars `.INSTk` que aún no los tienen. Esto evita cerrar el
   *    panel abierto cuando el usuario está usándolo.
   *
   * @private
   */
  _ensureUiInjected_() {
    const chatPanel = document.querySelector('gas-chat-panel');
    const panelsAlive = !!chatPanel;

    if (!panelsAlive) {
      this._injectChatPanel_();
      this._injectActionsPanel_();
      this._injectGithubPanel_();
      this._injectCurrentFile_();
      return;
    }

    // Panel vivo: refrescamos referencias para que esta instancia lo
    // controle y el editor activo sea el actual.
    this._chatPanel = chatPanel;
    this._chatPanel.setEditor(this.editor);
    this._buildUriToNameMap();

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
    // Si por algún motivo _rootParent no está establecido aún, usamos document como fallback
    const all   = () => Array.from(this._getDomScope_().querySelectorAll('.INSTk'));

    // Creamos la promesa para validar que el lemento este creado
    return new Promise((resolve) => {
      const existing = all();
      if (existing.length) {
        this._refreshRootParent_();
        return resolve(existing);
      }

      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearTimeout(timeoutId);
        // Aprovechamos para anclar la raíz al `c-wiz` activa que acaba de
        // emerger, así los siguientes consumidores la usan sin redoblar
        // queries innecesarias.
        if (value.length) this._refreshRootParent_();
        resolve(value);
      };

      const observer = new MutationObserver(() => {
        const found = all();
        if (found.length) finish(found);
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
   * Crea (o recrea) el botón del chat AI. El panel se reutiliza entre
   * re-inyecciones para preservar la conversación, configuración del LLM,
   * tema y posición ajustados por el usuario.
   * @private
   */
  _injectChatPanel_() {
    // 1. Limpiar todo: botones duplicados, panel viejo, listeners y atajo.
    this._teardownChatPanel_();

    // 2. Crear el panel limpio (recreado en cada inyección).
    this._chatPanel = document.createElement('gas-chat-panel');
    document.body.appendChild(this._chatPanel);
    this._chatPanel.setEditor(this.editor);

    // 3. Insertar un botón en cada toolbar `.INSTk` activa.
    this._injectToolbarButton_('buttonChatGas', this.options.chatButton);

    // 4. Click delegado a nivel de documento. Verificamos que el trigger
    //    esté dentro de una toolbar `.INSTk` o del contenedor inyectado.
    this._onChatButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnChatGas');
      if (!trigger) return;
      if (!trigger.closest('.INSTk') && !trigger.closest('#buttonChatGas')) return;
      e.preventDefault();
      this._chatPanel.setEditor(this.editor);
      this._chatPanel.toggle();
    };
    document.addEventListener('click', this._onChatButtonClick);

    // 5. Atajo global Alt+Shift+C. Siempre abre el panel.
    const openChat = () => {
      this._chatPanel?.setEditor(this.editor);
      this._chatPanel?.open();
    };
    this._onChatShortcut = this._bindGlobalShortcut_('c', openChat);

    // 6. Atajo dentro de Monaco (registrado una sola vez).
    this._bindMonacoShortcut_(
      '_chatMonacoCommandBound',
      window.monaco?.KeyCode?.KeyC,
      openChat
    );
  }

  /**
   * Elimina todos los botones del chat duplicados, el panel del body, el
   * click delegado y el atajo global.
   * @private
   */
  _teardownChatPanel_() {
    this._teardownToolbarUi_('buttonChatGas', 'gas-chat-panel', [
      { prop: '_onChatButtonClick', type: 'click' },
      { prop: '_onChatShortcut',    type: 'keydown', capture: true },
    ]);
    this._chatPanel = null;
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
      '_githubMonacoCommandBound',
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
   * Inyecta los estilos CSS del botón nativo (ancho fijo, dot, pulso).
   * El popover trae su propio CSS dentro del Shadow DOM. Idempotente.
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
        gap: 8px;
        min-width: 200px;
        max-width: 260px;
        padding: 0 12px !important;
        border-radius: 18px !important;
        background: #e8f0fe !important;
        border: 1px solid #d2e3fc !important;
        transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
      }
      .qc__cfn-btn:hover {
        background: #d2e3fc !important;
        border-color: #aecbfa !important;
        box-shadow: 0 1px 3px rgba(26,115,232,0.18);
      }
      .qc__cfn-btn .qc__cfn-name {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font-weight: 600 !important;
        color: #1a73e8 !important;
        letter-spacing: 0.2px;
      }
      .qc__cfn-dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: transparent;
        position: relative;
      }
      .qc__cfn-dot--error {
        background: #d93025;
        box-shadow: 0 0 0 0 rgba(217, 48, 37, 0.6);
        animation: qc__cfn-pulse 1.6s ease-out infinite;
      }
      .qc__cfn-dot--warning { background: #f9ab00; }
      @keyframes qc__cfn-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(217,48,37,0.55); }
        70%  { box-shadow: 0 0 0 6px rgba(217,48,37,0); }
        100% { box-shadow: 0 0 0 0 rgba(217,48,37,0); }
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

    // Solo markers: el cambio de modelo lo gestiona _onFileChange_ con el
    // mapa ya actualizado, así que no lo registramos aquí.
    if (window.monaco?.editor) {
      const d = window.monaco.editor.onDidChangeMarkers?.(() => this._renderCurrentFileButton_());
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
        btnCurrentFile_.setAttribute("data-tt", name);
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
    if (!this.editor) return;

    // Tabla de handlers: cada clave mapea a la llamada updateOptions correspondiente
    const SETTINGS_MAP = {
      // Visuales & Layout
      'showMinimap': (val) => this.editor.updateOptions({ minimap: { enabled: val } }),
      'lineNumbers': (val) => this.editor.updateOptions({ lineNumbers: val ? 'on' : 'off' }),
      'wordWrap': (val) => this.editor.updateOptions({ wordWrap: val ? 'on' : 'off' }),
      'renderLineHighlight': (val) => this.editor.updateOptions({ renderLineHighlight: val }),
      'rulers': (val) => this.editor.updateOptions({ rulers: val ? [80, 120] : [] }),
      'occurrencesHighlight': (val) => this.editor.updateOptions({ occurrencesHighlight: val ? 'singleFile' : 'off' }),
      'renderWhitespace': (val) => this.editor.updateOptions({ renderWhitespace: val ? 'selection' : 'none' }),
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
      'autoClosingBrackets': (val) => this.editor.updateOptions({ autoClosingBrackets: val ? 'always' : 'never' }),
      'guides-indentation': (val) => this.editor.updateOptions({ guides: { indentation: val } }),
      // Navigation
      'folding': (val) => this.editor.updateOptions({ folding: val }),
      // Scrolling
      'smoothScrolling': (val) => this.editor.updateOptions({ smoothScrolling: val }),
      'scrollBeyondLastLine': (val) => this.editor.updateOptions({ scrollBeyondLastLine: val }),
      // Editor Behavior
      'tabSize': (val) => {
        const size = parseInt(val, 10) || 2;
        const model_ = this.editor.getModel();
        if (model_) {
          model_.updateOptions({ tabSize: size, indentSize: size, insertSpaces: true });
        }
      },
      'cursorStyle': (val) => this.editor.updateOptions({ cursorStyle: val === 'block' ? 2 : 1 }),
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
        } catch (_) { /* setting inválido: ignorar */ }
      }
    });
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
   * Aplica o remueve el tema dark al entorno completo del IDE de Google
   * Apps Script y notifica al resto de Web Components inyectados.
   *
   * Tres responsabilidades:
   *  1. Inyecta/elimina el `<style id="qc__ide-dark-mode">` con la
   *     paleta dark para los nodos nativos de GAS.
   *  2. Mantiene la clase `gc__is-dark-mode` en el `<body>` como única
   *     fuente de verdad para que cualquier componente del proyecto
   *     pueda adaptar su estética leyéndola.
   *  3. Sincroniza el atributo `theme` en los Web Components flotantes
   *     (`gas-chat-panel`, `gas-github-panel`, `gas-actions-panel`,
   *     `gas-current-file`) para que adopten su paleta dark/light al
   *     instante.
   *
   * @param {boolean} enabled - true para aplicar dark mode, false para removerlo.
   * @private
   */
  _applyIdeDarkMode(enabled) {
    const styleId = 'qc__ide-dark-mode';
    const existing = document.getElementById(styleId);

    // Marca canónica en el <body>: el resto del proyecto la consulta para
    // decidir su paleta sin duplicar heurísticas.
    document.body.classList.toggle('gc__is-dark-mode', !!enabled);

    // Propaga el tema a los Web Components inyectados. Cada panel decide
    // cómo reaccionar al atributo `theme` desde su propio CSS scoped.
    this._syncFloatingPanelsTheme_(enabled);

    if (!enabled) {
      existing?.remove();
      return;
    }

    if (existing) return; // Ya aplicado

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* ═══════════════════════════════════════════════════════════════
         IDE DARK MODE - Google Apps Script Tools
         Tema dark para el entorno completo del IDE de GAS
         Basado en clases específicas de Google Apps Script.
         La paleta se mantiene alineada con la del chat/web components
         (ver DomUtils.themeTokensCss): mismas familias de fondo, texto y
         acento para que el IDE y los paneles flotantes "respiren" igual.
         ═══════════════════════════════════════════════════════════════ */
      :root{
        /* Backgrounds (mirror de --gc-bg / --gc-bg-raised / --gc-bg-elevated). */
        --gc__root-bg:           #16181c;
        --gc__root-bg-raised:    #1e2027;
        --gc__root-bg-elevated:  #262830;
        --gc__root-bg-deep:      #11131a;  /* equivalente a --gc-code-bg */

        /* Texto. */
        --gc__root-foreground:   #e8eaed;  /* --gc-text */
        --gc__root-text-muted:   #8b8fa8;  /* --gc-text-muted */

        /* Borde sólido equivalente a --gc-border (rgba .08) sobre bg-raised. */
        --gc__root-border:       #262830;

        /* Acento (highlight de archivo activo, hovers azulados). */
        --gc__root-accent-dim:   rgba(99,179,237,.12);  /* --gc-accent-dim */
        --gc__root-accent-soft:  rgba(99,179,237,.20);

        /* Aliases legacy: nombres antiguos siguen funcionando para
           cualquier consumidor externo que los lea. */
        --gc__root-background:   var(--gc__root-bg);
        --gc__root-forenground:  var(--gc__root-foreground);
      }

      /* ── Fondo principal y body ────────────────────────────────── */
      body {
        background: var(--gc__root-bg) !important;
      }

      .gb_Zc .gb_Vd{
        color: var(--gc__root-foreground) !important;
      }

      .UGZzee, .jvZ3Wb, .e0Nwve{
        color: var(--gc__root-text-muted) !important;
      }

      /* ── Header y navegación superior ──────────────────────────── */
      .voS0mf,
      .xifBgf {
        background: var(--gc__root-bg) !important;
        border-bottom: 1px solid var(--gc__root-border) !important;
      }

      header {
        background: var(--gc__root-bg-deep) !important;
      }

      /* ── Separadores y bordes ──────────────────────────────────── */
      .ZHQ5U,
      .GLLFQe:not(:first-child) {
        border-top: 1px solid var(--gc__root-border) !important;
      }

      .yggLIc::after {
        border-right: 1px solid var(--gc__root-bg-elevated) !important;
      }

      .LDouke,
      .MJnCFe {
        border-left: 1px solid var(--gc__root-border) !important;
      }

      /* ── Texto y colores de fuente ─────────────────────────────── */
      .AVdUn {
        color: var(--gc__root-text-muted) !important;
      }

      :not(.UeVsd) > .dxw0vf,
      .qc__folder-children li[role="option"] div[title]::before,
      .qc__folder-header {
        color: var(--gc__root-foreground) !important;
      }

      /* Item activo del árbol: usa el accent de la paleta del chat
         (azul tenue) en vez de un ámbar suelto, para que el highlight
         entre IDE y panels comparta lenguaje visual. */
      li.UeVsd {
        filter: none !important;
        background: var(--gc__root-accent-dim) !important;
        border-radius: 2px;
      }

      li.UeVsd .dxw0vf {
        color: var(--gc__root-foreground) !important;
      }

      .ry3kXd,
      .cfWmIb,
      .orScbe,
      .VfPpkd-fmcmS-yrriRe,
      .VfPpkd-fmcmS-yrriRe-OWXEXe-mWPk3d {
        color: var(--gc__root-foreground) !important;
      }

      .MocG8c {
        color: var(--gc__root-foreground) !important;
      }

      .ncFHed .MocG8c,
      .eU809d {
        color: var(--gc__root-bg) !important;
      }

      /* ── Paneles, modales y menús (inversión de colores) ───────── */
      div[aria-modal="true"],
      .vL6DV,
      .vZzXQ,
      .awn63d,
      .ZBGfLd,
      .N3bjuf,
      .td5WLe,
      .hmN6tf,
      .OaLLmb,
      div[role="menu"],
      div[role="complementary"],
      .wNGeMc {
        background: #F7F7F7 !important;
        filter: invert(1) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      /* ── Sidebar y árbol de archivos ───────────────────────────── */
      .UeVsd,
      .z2IeMc {
        filter: invert(1) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      /* Excepción: iconos de carpetas y archivos personalizados NO se invierten */
      .qc__folder-icon-wrapper,
      .qc__file-icon {
        filter: invert(1) !important;
      }

      /* ── Inputs y campos de texto ──────────────────────────────── */
      .MocG8c,
      .icpHQc,
      input[type="text"] {
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      /* ── Toolbar y botones ─────────────────────────────────────── */
      .g3VIld {
        background: #F7F7F7 !important;
        filter: invert(100%) !important;
        text-shadow: 0 0 0 rgba(0, 0, 0, 1);
      }

      div.g3VIld .ncFHed {
        position: static !important;
      }

      div.yggLIc .ncFHed,
      .CtTFvc .eU809d {
        filter: invert(100%) !important;
      }

      /* ── Editor Monaco y área de código ────────────────────────── */
      .LjDxcd,
      .ry3kXd {
        filter: invert(1) contrast(1) !important;
        -webkit-font-smoothing: none;
        -moz-osx-font-smoothing: unset;
        font-smoothing: unset;
        font-smooth: never;
      }

      /* ── Fondos claros para elementos invertidos ───────────────── */
      .z9lUof,
      .Y7MQLd {
        background: #F7F7F7 !important;
      }

      /* ── Scrollbars personalizados ─────────────────────────────── */
      ::-webkit-scrollbar {
        background: var(--gc__root-bg) !important;
        width: 6px !important;;
      }

      ::-webkit-scrollbar-thumb {
        background: var(--gc__root-bg-elevated) !important;
      }

      ::-webkit-scrollbar-thumb:hover {
        background: #3a3d47 !important;
      }

      /* ── Ajustes adicionales para compatibilidad ───────────────── */
      c-wiz[data-p] {
        background: var(--gc__root-bg) !important;
      }

      /* Prevenir doble inversión en elementos anidados */
      .UeVsd .UeVsd,
      .z2IeMc .z2IeMc {
        filter: none !important;
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Sincroniza el atributo `theme` en los Web Components flotantes con
   * el estado de la opción "IDE Dark Mode". Cada componente expone su
   * propia paleta dark/light usando selectores `:host([theme="dark"])`
   * o `:host([theme="light"])`; este helper solo activa/desactiva el
   * atributo, no toca CSS interno.
   *
   * Se ejecuta tanto al toggle del usuario como al re-init del editor,
   * para cubrir el caso de paneles que se montaron antes de que el
   * estado dark estuviera disponible.
   *
   * @param {boolean} enabled - true para tema dark, false para tema light.
   * @private
   */
  _syncFloatingPanelsTheme_(enabled) {
    const tags = (typeof DomUtils !== 'undefined' && DomUtils.FLOATING_PANEL_TAGS)
      ? DomUtils.FLOATING_PANEL_TAGS
      : [
          'gas-chat-panel',
          'gas-current-file',
          'gas-actions-panel',
          'gas-github-panel',
        ];

    const value = enabled ? 'dark' : 'light';
    for (const tag of tags) {
      document.querySelectorAll(tag).forEach((el) => {
        el.setAttribute('theme', value);
      });
    }

    // El badge del botón de GitHub vive fuera del Shadow DOM (en la
    // toolbar nativa de GAS) y usa estilos inline para el anillo. Tras
    // cambiar el tema lo repintamos para que recalcule el color del
    // ring contra el nuevo fondo del IDE.
    document.querySelector('gas-github-panel')?.refreshBadge?.();
  }

  // ──────────────────────────────────────────
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

      // Si los providers ya están registrados, no necesitamos hacer nada más:
      // el closure ya apunta a this._snippets y se actualiza automáticamente
      if (GasCustomEditor.providersRegistered) return;

      // Grupos de lenguajes que soportamos; 'google apps script' es el identificador
      // que Monaco asigna a los archivos .gs en el editor de GAS
      const langGroups = [
        { id: 'html', types: ['html'] },
        { id: 'javascript', types: ['javascript', 'typescript', 'js', 'google apps script'] },
        { id: 'google apps script', types: ['javascript', 'typescript', 'js', 'google apps script'] },
      ];

      langGroups.forEach(group => {
        monaco.languages.registerCompletionItemProvider(group.id, {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            // Filtramos desde el estado interno de la instancia (siempre actualizado)
            const filtered = this._snippets.filter(s =>
              group.types.includes(s.lang?.toLowerCase())
            );
            return { suggestions: this._buildSuggestions(filtered, range) };
          },
        });
      });

      // Marcamos como registrado a nivel de clase para que nuevas instancias no dupliquen
      GasCustomEditor.providersRegistered = true;
    } catch (_) { /* error al registrar snippets */ }
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
    } catch (_) { /* error al cargar tema */ }
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
    // 5. Remover el tema dark del IDE si está aplicado.
    //    También quitamos la clase canónica del body y reseteamos el
    //    atributo `theme` de los paneles flotantes a 'light' para que
    //    cualquiera que se quede montado vuelva a su paleta clara.
    document.getElementById('qc__ide-dark-mode')?.remove();
    document.body.classList.remove('gc__is-dark-mode');
    this._syncFloatingPanelsTheme_(false);

    // 6. Deshabilitar autocompletado AI si existe
    if (this._aiAutocomplete) {
      this._aiAutocomplete.disable();
    }
  }

  /**
   * Reactiva la extensión con el estado guardado en memoria.
   */
  enable() {
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
      this._injectChatPanel_();
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
   * de Monaco y detiene el intervalo de verificación de cambio de archivo.
   * Los flags de comandos de Monaco no se resetean (la API no permite
   * deshacer `addCommand`).
   * @private
   */
  _teardownInjectedUi_() {
    // Cerrar paneles antes de eliminarlos para que cierren listeners propios.
    this._chatPanel?.close?.();
    this._actionsPanel?.close?.();
    this._githubPanel?.close?.();

    // Delegar el teardown específico (botones + paneles + listeners + atajos).
    this._teardownChatPanel_();
    this._teardownActionsPanel_();
    this._teardownGithubPanel_();
    this._teardownCurrentFile_();

    // Limpiar elementos auxiliares que pudieran haber quedado de versiones
    // anteriores (no atados a los teardown específicos).
    document.querySelectorAll('#sltRubThemeList').forEach((el) => el.remove());

    // Liberar disposables de Monaco para evitar memory leaks.
    this._modelChangeDisposable?.dispose();
    this._modelChangeDisposable = null;

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
