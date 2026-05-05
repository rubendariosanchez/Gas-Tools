"use strict";

console.log("[GASTools] Script cargado y ejecutándose");

// ─────────────────────────────────────────────
// ESTADO GLOBAL MÍNIMO
// Solo lo que debe existir ANTES de que la clase se instancie.
// Todo lo demás vive dentro de GasCustomEditor.
// ─────────────────────────────────────────────

// Flag que indica si la extensión fue deshabilitada antes de que Monaco cargara
let G_GLOBALLY_DISABLED = false;
// Flag que indica si Monaco ya está disponible en window
let G_MONACO_READY = false;
// Referencia única a la instancia activa del editor personalizado
let G_GAS_TOOLS_INSTANCE = null;

// ─────────────────────────────────────────────
// DETECCIÓN DE MONACO
// ─────────────────────────────────────────────

/**
 * Marca Monaco como listo y arranca la inicialización si hay datos pendientes.
 * Se invoca desde dos rutas:
 *   1. Síncronamente, si Monaco ya estaba en window cuando este script cargó (cache caliente).
 *   2. Desde el MutationObserver, cuando Monaco aparece tras una mutación del DOM.
 */
function markMonacoReady_() {
  // Evitar ejecución doble si ya fue marcado
  if (G_MONACO_READY) return;
  G_MONACO_READY = true;
  console.log("[GASTools] Monaco detectado y listo");
  // Si ya habían llegado datos antes de que Monaco cargara, inicializamos ahora
  if (window._PENDING_GAS_DATA) {
    initializeEditor_(window._PENDING_GAS_DATA);
  }
}

/**
 * Observa el DOM para detectar cuándo Monaco se inyecta en la página.
 * Solo activo cuando el script cargó ANTES de que Monaco existiera.
 */
const G_MAIN_OBSERVER = new MutationObserver((mutations, obs) => {
  if (!window.jsWireMonacoEditor) return;
  // Desconectamos tan pronto detectamos Monaco para no seguir observando
  obs.disconnect();
  markMonacoReady_();
});

// CASO CRÍTICO (cache caliente): Monaco puede ya estar disponible en window
// cuando este script se evalúa. En ese caso el observer nunca se dispararía.
if (window.jsWireMonacoEditor) {
  markMonacoReady_();
} else {
  // Monaco aún no existe: observamos el body hasta que aparezca
  G_MAIN_OBSERVER.observe(document.body, { childList: true, subtree: true });
}

// ─────────────────────────────────────────────
// RECEPCIÓN DE DATOS DEL CONTENT SCRIPT
// ─────────────────────────────────────────────

/**
 * Resetea el flag de disabled para que gasTools.js acepte la inicialización
*/
document.addEventListener('GAS_GlobalEnable', () => {
  G_GLOBALLY_DISABLED = false;
  console.log('[GASTools] Flag de disabled reseteado');
});

/**
 * Recibe el payload inicial desde el content script (mainFunctions.js).
 * Si Monaco ya está listo, inicializa de inmediato; si no, guarda los datos
 * para procesarlos cuando Monaco esté disponible.
 *
 * @listens document#GAS_TransferData
 */
document.addEventListener('GAS_TransferData', (e) => {
  const data = JSON.parse(e.detail);
  console.log("[GASTools] GAS_TransferData recibido:", data);
  // Guardamos siempre como pendientes por si Monaco aún no cargó
  window._PENDING_GAS_DATA = data;
  if (G_MONACO_READY && window.jsWireMonacoEditor) {
    initializeEditor_(data);
  } else {
    console.log("[GASTools] Datos recibidos pero Monaco no está listo. Esperando...");
  }
});

/**
 * Crea o actualiza la instancia de GasCustomEditor con los datos recibidos.
 * Si la extensión está deshabilitada globalmente, no hace nada.
 * Si ya existe una instancia, actualiza sus opciones con el estado en memoria y la reinicia.
 *
 * @param {Object} data - Payload inicial con settings, snippets, tema y HTML de botones.
 */
function initializeEditor_(data) {
  // Si el usuario desactivó la extensión, no inicializar
  if (G_GLOBALLY_DISABLED) {
    console.log("[GASTools] Deshabilitado globalmente, omitiendo inicialización.");
    window._PENDING_GAS_DATA = null;
    return;
  }

  if (G_GAS_TOOLS_INSTANCE) {
    // Ya existe una instancia: actualizamos sus opciones con el estado más reciente en memoria
    // para no perder cambios hechos desde el popup mientras se cambiaba de archivo
    console.log("[GASTools] Instancia existente detectada. Actualizando opciones y reiniciando.");
    G_GAS_TOOLS_INSTANCE.mergeAndReinit(data);
    window._PENDING_GAS_DATA = null;
    return;
  }

  // Primera inicialización: creamos la instancia y la arrancamos
  G_GAS_TOOLS_INSTANCE = new GasCustomEditor(data);
  G_GAS_TOOLS_INSTANCE.init();
  window._PENDING_GAS_DATA = null;
}

// ─────────────────────────────────────────────
// EVENTOS DESDE EL POPUP (vía mainFunctions.js)
// ─────────────────────────────────────────────

/**
 * Aplica cambios de configuración emitidos desde el popup.
 * Procesa `global-enable` primero; el resto se delega a la instancia activa.
 *
 * @listens document#GAS_SettingsUpdated
 */
document.addEventListener('GAS_SettingsUpdated', (e) => {
  const options = JSON.parse(e.detail);

  // El toggle global debe ser procesado primero
  if ('global-enable' in options) {
    const isEnabled = options['global-enable'];
    G_GLOBALLY_DISABLED = !isEnabled;

    if (!isEnabled) {
      G_GAS_TOOLS_INSTANCE?.disable();
      console.info('[GASTools] Extensión deshabilitada globalmente');
      return;
    }

    // Sin instancia previa: inicializar desde cero si hay datos pendientes
    if (G_GAS_TOOLS_INSTANCE) {
      G_GAS_TOOLS_INSTANCE.enable();
    } else if (window._PENDING_GAS_DATA) {
      initializeEditor_(window._PENDING_GAS_DATA);
    }

    console.info('[GASTools] Extensión habilitada globalmente');
  }

  // Sin instancia activa no hay donde aplicar los cambios
  if (!G_GAS_TOOLS_INSTANCE) {
    console.warn('[GASTools] Sin instancia activa — actualización de settings omitida.');
    return;
  }

  // Aplicamos los cambios de settings en la instancia activa
  G_GAS_TOOLS_INSTANCE.updateSettings(options);
});

/**
 * Recibe snippets o tema actualizados desde el popup.
 *
 * @listens document#GAS_DataUpdated
 */
document.addEventListener('GAS_DataUpdated', (e) => {
  const { updateType, data } = JSON.parse(e.detail);
  console.log("[GASTools] GAS_DataUpdated recibido:", updateType);

  if (!G_GAS_TOOLS_INSTANCE) {
    console.log("[GASTools] Sin instancia activa, ignorando actualización.");
    return;
  }

  if (updateType === 'snippets') {
    // Delega en la instancia para que actualice su propio estado y recargue
    G_GAS_TOOLS_INSTANCE.updateSnippets(data);
  }

  if (updateType === 'themes') {
    // Delega en la instancia para que actualice su propio estado y recargue
    G_GAS_TOOLS_INSTANCE.updateTheme(data);
  }
});

/**
 * Recibe la señal de deshabilitación global emitida por mainFunctions.js
 * antes de que la instancia se cree (durante la carga inicial de la página).
 *
 * @listens document#GAS_GlobalDisable
 */
document.addEventListener('GAS_GlobalDisable', () => {
  G_GLOBALLY_DISABLED = true;
  console.log("[GASTools] Flag de deshabilitación global establecido en carga de página");
});

// ─────────────────────────────────────────────
// CLASE PRINCIPAL
// ─────────────────────────────────────────────

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
   * @param {string} options.searchButton  - HTML del botón de búsqueda avanzada.
   * @param {string} options.chatButton    - HTML del botón del chat AI.
   * @param {string} options.themeUrl      - URL base de la carpeta de temas.
   * @param {string} options.referenceId   - UUID del editor Monaco al que corresponde esta instancia.
   */
  constructor(options) {
    console.log("[GASTools] Constructor llamado");

    // ── Estado principal ─────────────────────────────────────────
    // Copia defensiva para no mutar el objeto original recibido del content script
    this._settings = { ...(options.settings || {}) };
    this._snippets = [...(options.snippets || [])];
    this._activeTheme = options.activeTheme || null;

    // Opciones de solo lectura (HTML de botones, URL de temas, referencia del editor)
    this.options = options;

    // ── Monaco ───────────────────────────────────────────────────
    this.editor = null;
    // Nombre del tema aplicado por GAS por defecto; se captura en init()
    this._defaultThemeName = 'vs-light';

    // ── UI inyectada ─────────────────────────────────────────────
    this.DomUtils = DomUtils;
    this._toolsMenuElement = null;
    this._toolbarParentElement = null;
    this._searchPanel = null;
    this._chatPanel = null;

    // ── Listeners (guardados para poder eliminarlos en disable()) ─
    this._onSearchButtonClick = null;
    this._onChatButtonClick = null;
    this._onSearchShortcut = null;
    this._onChatShortcut = null;

    // ── Flags de registro único ──────────────────────────────────
    // Evitan registrar atajos y comandos de Monaco más de una vez
    this._searchShortcutBound = false;
    this._chatShortcutBound = false;
    this._searchMonacoCommandBound = false;
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
    this._modelCreateDisposable = null;
    this._lastModelUri = null;
    this._fileCheckInterval = null;

    // ── Mapa URI → nombre legible de archivo ─────────────────────
    this._fileNameObjectMap = new Map();
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
    console.log("[GASTools] Settings actualizados en memoria:", Object.keys(this._settings));
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
    console.log("[GASTools] Snippets actualizados en memoria:", snippets.length);
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
    console.log("[GASTools] Tema actualizado en memoria:", theme?.text);
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
  async init() {
    // Monaco debe existir en este punto; si no, no hay nada que hacer
    this.editor = window.jsWireMonacoEditor;
    if (!this.editor) return;

    this.editor.onDidPaste(() => {
      console.info('[GASTools] Paste detectado por Monaco');
    });

    // Capturamos el tema por defecto de GAS para poder restaurarlo en disable()
    this._defaultThemeName = this.editor._themeService._theme.themeName;
    console.log("[GASTools] Tema por defecto de GAS capturado:", this._defaultThemeName);

    // Elemento Monaco al que está anclada esta instancia (útil para mejoras futuras por editor)
    this.element = document.querySelector(`[data-gasreference='${this.options.referenceId}']`);

    console.log("[GASTools] Inicializando instancia del editor...");

    // Esperamos hasta 15s a que la toolbar exista; si no aparece, continuamos sin UI inyectada
    this._toolsMenuElement = await this._waitForToolsMenu_();
    if (!this._toolsMenuElement) {
      console.warn("[GASTools] Toolbar (.INSTk) no encontrada tras 15s. Continuando sin UI inyectada.");
    }

    // Aplicar opciones de Monaco (minimap, wordWrap, etc.) desde el estado interno
    this.applySettings(this._settings);

    // Registrar snippets como completion providers en Monaco
    await this.reloadSnippets();

    // Aplicar tema activo
    await this.reloadTheme();

    // Construir el mapa URI → nombre legible para el panel de búsqueda
    this._buildUriToNameMap();

    if (this._toolsMenuElement) {
      // Inyectar botón y panel de búsqueda avanzada
      this._enableAdvancedSearch();
      // Inyectar botón y panel del chat AI
      this._injectChatPanel_();
    }

    // Escuchar cambios de modelo para mantener snippets y tema activos al cambiar de archivo
    this._setupModelListeners_();
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

    // Evento nativo de Monaco: se dispara al cambiar el modelo activo en el editor
    this._modelChangeDisposable = this.editor.onDidChangeModel(() => {
      console.log("[GASTools] Modelo cambiado, reaplicando snippets y tema");
      this._onFileChange_();
    });

    // Evento global de Monaco: se dispara cuando se crea un modelo nuevo (nuevo archivo)
    if (window.monaco?.editor) {
      this._modelCreateDisposable = window.monaco.editor.onDidCreateModel(() => {
        console.log("[GASTools] Nuevo modelo creado, reaplicando snippets y tema");
        this._onFileChange_();
      });
    }

    // Red de seguridad: intervalo de 2s para detectar cambios que los eventos no capturen
    // (p. ej. cambios de archivo iniciados desde la UI de GAS sin mutación de Monaco)
    this._fileCheckInterval = setInterval(() => {
      const currentUri = this.editor?.getModel()?.uri?.toString();
      if (currentUri && currentUri !== this._lastModelUri) {
        console.log("[GASTools] Cambio de modelo detectado por intervalo");
        this._lastModelUri = currentUri;
        this._onFileChange_();
      }
    }, 2000);

    console.log("[GASTools] Listeners de cambio de archivo configurados");
  }

  /**
   * Acciones comunes a ejecutar cada vez que el usuario cambia de archivo.
   * Centraliza la lógica que antes estaba duplicada en varios listeners.
   * @private
   */
  _onFileChange_() {
    // Si la extensión fue deshabilitada mientras el intervalo o un listener
    // estaba en vuelo, no hacemos nada y dejamos que _teardownInjectedUi_ termine
    if (G_GLOBALLY_DISABLED) return;
    if (this._snippets.length > 0) this.reloadSnippets();
    this.reloadTheme();
    this._buildUriToNameMap();
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
  // MAPA URI → NOMBRE DE ARCHIVO
  // ──────────────────────────────────────────

  /**
   * Construye el mapa URI → nombre legible usando la posición DOM como ancla.
   *
   * Las URIs de Monaco son opacas (inmemory://model/N), así que el único
   * anclaje confiable es el modelo activo: Monaco nos dice qué URI está
   * abierta, la UI de GAS nos dice qué archivo está activo. Con ese par
   * fijado, asignamos el resto por posición excluyendo ese slot de ambas listas.
   */
  _buildUriToNameMap() {
    const map = new Map();

    // 1. Leer los archivos del árbol DOM en el orden visual real
    const items = [...document.querySelectorAll('li[role="option"][data-res-id]')];
    const files = items
      .map(li => ({
        name: li.getAttribute('aria-label')?.trim(),
        index: parseInt(li.getAttribute('data-index'), 10),
      }))
      .filter(f => f.name)
      .sort((a, b) => a.index - b.index);

    // 2. Separar appsscript.json del resto (tiene una posición especial en Monaco)
    const normalFiles = files.filter(f => f.name !== 'appsscript.json');
    const appScript = files.find(f => f.name === 'appsscript.json');

    // 3. Obtener los modelos de Monaco ordenados por su ID numérico
    const models = (window.monaco?.editor?.getModels?.() || [])
      .map(m => ({
        uri: m.uri.toString(),
        id: parseInt(m.uri.path.replace('/', ''), 10),
      }))
      .sort((a, b) => a.id - b.id);

    // 4. Asignar archivos normales en orden posicional
    normalFiles.forEach((file, i) => {
      if (models[i]) map.set(models[i].uri, file.name);
    });

    // 5. Asignar appsscript.json al modelo con ID 3 (posición fija en GAS)
    if (appScript) {
      const target = models.find(m => m.id === 3);
      if (target) map.set(target.uri, appScript.name);
    }

    this._fileNameObjectMap = map;
    console.log('[GASTools] Mapa URI → archivo actualizado:', map);
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
   * Comprueba si una cadena parece un nombre real de archivo de GAS.
   * Acepta extensiones .gs, .js, .ts, .json, .html, .css, .md, .txt.
   * Descarta cadenas genéricas como "model 1".
   *
   * @param {string} value - Cadena a comprobar.
   * @returns {boolean}
   */
  _looksLikeRealFileName(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    // Descartar nombres genéricos tipo "model 1", "model 2", etc.
    if (/^model\s*\d+$/i.test(text)) return false;
    return /\.(gs|js|ts|json|html|css|md|txt)$/i.test(text);
  }

  // ──────────────────────────────────────────
  // BÚSQUEDA AVANZADA
  // ──────────────────────────────────────────

  /**
   * Punto de entrada para la inyección del botón y panel de búsqueda avanzada.
   * Precondición: `init()` ya garantiza que `_toolsMenuElement` existe.
   */
  _enableAdvancedSearch() {
    // Si la toolbar no está disponible, init() ya habrá logueado el warning
    if (!this._toolsMenuElement) return;
    this._injectAdvancedSearch_();
  }

  /**
   * Espera a que el contenedor `.INSTk` (toolbar de GAS) esté en el DOM.
   * Usa un MutationObserver con un timeout máximo de 15s.
   *
   * @returns {Promise<HTMLElement|null>} El elemento o null si no aparece en 15s.
   * @private
   */
  _waitForToolsMenu_() {
    return new Promise((resolve) => {
      // Si ya existe en el DOM, resolemos inmediatamente
      const existing = document.querySelector('.INSTk');
      if (existing) return resolve(existing);

      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearTimeout(timeoutId);
        resolve(value);
      };

      // Observamos el body hasta que el contenedor aparezca
      const observer = new MutationObserver(() => {
        const found = document.querySelector('.INSTk');
        if (found) finish(found);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Timeout de seguridad: si no aparece en 15s, resolvemos con null
      const timeoutId = setTimeout(() => finish(null), 15000);
    });
  }

  /**
   * Crea e inyecta el botón de búsqueda avanzada y el Web Component `<gas-search-panel>`.
   * Registra el click delegado y los atajos de teclado (documento y Monaco).
   * @private
   */
  _injectAdvancedSearch_() {
    // Evitar duplicados si init() corre dos veces
    if (document.getElementById('buttonAdvancedSearch')) return;

    // 1. Limpiar elementos residuales de una sesión anterior
    this.DomUtils.remove('buttonAdvancedSearch');
    this.DomUtils.remove('ctnCurrentFileName');

    // 2. Crear el contenedor del botón e insertar el HTML precargado
    const option = document.createElement('div');
    option.className = 'yggLIc';
    option.id = 'buttonAdvancedSearch';
    // Usamos DomUtils.setHTML para respetar la política de seguridad centralizada
    this.DomUtils.setHTML(option, this.options.searchButton);

    // 3. Insertar ANTES de `.INSTk` (no dentro) para que aparezca a su izquierda
    this._toolsMenuElement.parentNode.insertBefore(option, this._toolsMenuElement);

    // 4. Inyectar el Web Component en el body (uno por documento, compartido)
    if (!document.querySelector('gas-search-panel')) {
      this._searchPanel = document.createElement('gas-search-panel');
      document.body.appendChild(this._searchPanel);
    } else {
      this._searchPanel = document.querySelector('gas-search-panel');
    }
    // Enlazamos la instancia activa de Monaco para habilitar "ir a línea"
    this._searchPanel.setEditor(this.editor);

    // 5. Registrar click delegado en el padre de la toolbar
    this._toolbarParentElement = this._toolsMenuElement.parentNode;
    this._onSearchButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnSearchGas');
      if (!trigger || !this._toolbarParentElement?.contains(trigger)) return;
      e.preventDefault();
      // Actualizamos el mapa antes de mostrar el panel para que los nombres estén frescos
      this._buildUriToNameMap();
      this._searchPanel._formatModelName = this._formatModelName.bind(this);
      this._searchPanel.setFileNameObjectMap(this._fileNameObjectMap);
      this._searchPanel.toggle(trigger, this._fileNameObjectMap);
    };
    this._toolbarParentElement.addEventListener('click', this._onSearchButtonClick);

    // 6. Atajo global Alt+Shift+F (registrado una sola vez por instancia)
    if (!this._searchShortcutBound) {
      this._searchShortcutBound = true;
      this._onSearchShortcut = (evt) => {
        if (!(evt.key?.toLowerCase() === 'f' && evt.altKey && evt.shiftKey)) return;
        evt.preventDefault();
        evt.stopPropagation();
        this._searchPanel?.toggle(document.querySelector('#rsBtnSearchGas'));
      };
      document.addEventListener('keydown', this._onSearchShortcut, true);
    }

    // 7. Atajo dentro de Monaco (registrado una sola vez por instancia)
    if (!this._searchMonacoCommandBound && this.editor?.addCommand && window.monaco?.KeyMod) {
      this._searchMonacoCommandBound = true;
      this.editor.addCommand(
        window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | window.monaco.KeyCode.KeyF,
        () => this._searchPanel?.toggle(document.querySelector('#rsBtnSearchGas'))
      );
    }

    console.log("[GASTools] UI de búsqueda avanzada inyectada.");
  }

  /**
   * Crea e inyecta el botón del chat AI y el Web Component `<gas-chat-panel>`.
   * Registra el click delegado y los atajos de teclado (documento y Monaco).
   * @private
   */
  _injectChatPanel_() {
    // Evitar duplicados si init() corre dos veces
    if (document.getElementById('buttonChatGas')) return;

    // 1. Crear el contenedor del botón e insertar el HTML precargado
    const option = document.createElement('div');
    option.className = 'yggLIc';
    option.id = 'buttonChatGas';
    this.DomUtils.setHTML(option, this.options.chatButton);
    // Insertamos ANTES de `.INSTk`, al igual que el botón de búsqueda
    this._toolsMenuElement.parentNode.insertBefore(option, this._toolsMenuElement);

    // 2. Inyectar el Web Component en el body (uno por documento, compartido)
    if (!document.querySelector('gas-chat-panel')) {
      this._chatPanel = document.createElement('gas-chat-panel');
      document.body.appendChild(this._chatPanel);
    } else {
      this._chatPanel = document.querySelector('gas-chat-panel');
    }
    // Enlazamos la instancia activa de Monaco para que el panel pueda leer el código
    this._chatPanel.setEditor(this.editor);

    // 3. Registrar click delegado en el padre de la toolbar
    this._toolbarParentElement = this._toolsMenuElement.parentNode;
    this._onChatButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnChatGas');
      if (!trigger || !this._toolbarParentElement?.contains(trigger)) return;
      e.preventDefault();
      // Refrescamos la referencia al editor por si cambió desde la última apertura
      this._chatPanel.setEditor(this.editor);
      this._chatPanel.toggle();
    };
    this._toolbarParentElement.addEventListener('click', this._onChatButtonClick);

    // 4. Atajo global Alt+Shift+C (registrado una sola vez por instancia)
    if (!this._chatShortcutBound) {
      this._chatShortcutBound = true;
      this._onChatShortcut = (evt) => {
        if (!(evt.key?.toLowerCase() === 'c' && evt.altKey && evt.shiftKey)) return;
        evt.preventDefault();
        evt.stopPropagation();
        this._chatPanel?.setEditor(this.editor);
        this._chatPanel?.toggle();
      };
      document.addEventListener('keydown', this._onChatShortcut, true);
    }

    // 5. Atajo dentro de Monaco (registrado una sola vez por instancia)
    if (!this._chatMonacoCommandBound && this.editor?.addCommand && window.monaco?.KeyMod) {
      this._chatMonacoCommandBound = true;
      this.editor.addCommand(
        window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | window.monaco.KeyCode.KeyC,
        () => {
          this._chatPanel?.setEditor(this.editor);
          this._chatPanel?.toggle();
        }
      );
    }

    console.log("[GASTools] Panel de chat AI inyectado.");
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
    if (!this.editor) {
      console.warn("[GASTools] Editor Monaco no disponible aún");
      return;
    }

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
      'fontFamily': (val) => this.editor.updateOptions({ fontFamily: val }),
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
      'tabSize': (val) => this.editor.updateOptions({ tabSize: parseInt(val, 10) }),
      'cursorStyle': (val) => this.editor.updateOptions({ cursorStyle: val === 'block' ? 2 : 1 }),
      'cursorBlinking': (val) => this.editor.updateOptions({ cursorBlinking: val }),
    };

    Object.entries(settings).forEach(([key, value]) => {
      // El toggle global se gestiona en el listener de GAS_SettingsUpdated, no aquí
      if (key === 'global-enable') return;
      const handler = SETTINGS_MAP[key];
      if (handler) {
        try {
          handler(value);
          console.log(`[GASTools] Setting aplicado: ${key} = ${value}`);
        } catch (err) {
          console.warn(`[GASTools] No se pudo aplicar "${key}":`, err);
        }
      }
    });
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

      console.log("[GASTools] Snippets en memoria:", this._snippets.length);

      // Si los providers ya están registrados, no necesitamos hacer nada más:
      // el closure ya apunta a this._snippets y se actualiza automáticamente
      if (GasCustomEditor.providersRegistered) {
        console.log("[GASTools] Providers ya activos. Datos actualizados en memoria.");
        return;
      }

      console.log("[GASTools] Registrando completion providers...");

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
      console.log("[GASTools] Completion providers registrados.");
    } catch (err) {
      console.error("[GASTools] Error registrando snippets:", err);
    }
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
      if (G_GLOBALLY_DISABLED) return;
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
      console.log("[GASTools] Tema aplicado:", themeName);
    } catch (err) {
      console.error("[GASTools] Error al recargar el tema:", err);
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
    if (this._themePatched) {
      console.log("[GASTools] Patch activo. Tema objetivo actualizado:", ourThemeName);
      return;
    }

    // Guardamos setTheme original para poder restaurarla en _releaseThemeControl()
    this.originalSetTheme = monaco.editor.setTheme.bind(monaco.editor);
    const self = this;

    monaco.editor.setTheme = function (requestedTheme) {
      const target = self._activeThemeName;
      // Si el llamante ya pide nuestro tema, dejamos pasar sin recursión
      if (requestedTheme === target) return self.originalSetTheme(requestedTheme);
      // Cualquier otro intento de cambio lo bloqueamos y aplicamos el nuestro
      console.log(`[GASTools] Cambio de tema bloqueado: "${requestedTheme}" → forzando "${target}"`);
      return self.originalSetTheme(target);
    };

    this._themePatched = true;
    console.log("[GASTools] setTheme interceptado. Nuestro tema siempre ganará.");
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
   * Desactiva todas las mejoras de la extensión:
   * restaura el tema original de GAS, elimina el patch de setTheme,
   * revierte las opciones del editor y elimina la UI inyectada.
   */
  disable() {
    console.log("[GASTools] Deshabilitando extensión...");
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
    console.log("[GASTools] Extensión deshabilitada y UI limpiada.");
  }

  /**
   * Reactiva todas las mejoras con el estado en memoria.
   * Re-inyecta la UI y reaplica settings, snippets y tema
   * sin llamar a `init()` para evitar duplicar comandos de Monaco.
   */
  enable() {
    console.log("[GASTools] Re-habilitando extensión...");

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

    // Re-inyectar botones y paneles sin pasar por init()
    this._reinjectUI_();

    // Reaplicar settings, snippets y tema desde el estado ya sincronizado
    this.applySettings(settingsToApply);
    this.reloadSnippets();
    this.reloadTheme();

    console.log("[GASTools] Extensión re-habilitada con", this._snippets.length, "snippets");
  }

  /**
   * Re-inyecta los elementos de UI sin reinicializar todo desde cero.
   * Espera la toolbar si aún no está disponible.
   * @private
   */
  _reinjectUI_() {
    if (!this._toolsMenuElement) {
      // La toolbar puede no existir si disable() se llamó muy temprano
      this._waitForToolsMenu_().then((el) => {
        this._toolsMenuElement = el;
        if (el) {
          this._injectAdvancedSearch_();
          this._injectChatPanel_();
        }
      });
      return;
    }
    this._injectAdvancedSearch_();
    this._injectChatPanel_();
  }

  /**
   * Elimina todos los elementos inyectados en el DOM y desregistra los listeners.
   * Los flags de comandos de Monaco NO se resetean para evitar duplicados al re-habilitar.
   * @private
   */
  _teardownInjectedUi_() {
    // Cerrar paneles antes de eliminarlos del DOM
    this._searchPanel?.close?.();
    this._chatPanel?.close?.();

    // Desregistrar clicks delegados
    if (this._toolbarParentElement) {
      if (this._onSearchButtonClick) {
        this._toolbarParentElement.removeEventListener('click', this._onSearchButtonClick);
      }
      if (this._onChatButtonClick) {
        this._toolbarParentElement.removeEventListener('click', this._onChatButtonClick);
      }
    }

    // Desregistrar atajos globales de teclado
    if (this._onSearchShortcut) document.removeEventListener('keydown', this._onSearchShortcut, true);
    if (this._onChatShortcut) document.removeEventListener('keydown', this._onChatShortcut, true);

    // Eliminar elementos del DOM
    this.DomUtils.remove('buttonAdvancedSearch');
    this.DomUtils.remove('buttonChatGas');
    this.DomUtils.remove('ctnCurrentFileName');
    this.DomUtils.remove('sltRubThemeList');
    document.querySelector('gas-search-panel')?.remove();
    document.querySelector('gas-chat-panel')?.remove();

    // Limpiar disposables de Monaco para evitar memory leaks
    this._modelChangeDisposable?.dispose();
    this._modelChangeDisposable = null;
    this._modelCreateDisposable?.dispose();
    this._modelCreateDisposable = null;

    // Detener el intervalo de verificación periódica
    this._stopFileCheckInterval_();
    this._lastModelUri = null;

    // Limpiar referencias a listeners y elementos (no los flags de Monaco)
    this._toolbarParentElement = null;
    this._onSearchButtonClick = null;
    this._onChatButtonClick = null;
    this._onSearchShortcut = null;
    this._onChatShortcut = null;
    this._searchShortcutBound = false;
    this._chatShortcutBound = false;
    this._searchPanel = null;
    this._chatPanel = null;
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
    console.log("[GASTools] Control del tema liberado. Restaurado a:", this._defaultThemeName);
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
    } catch (err) {
      console.warn("[GASTools] Error al revertir defaults:", err);
    }
  }
}