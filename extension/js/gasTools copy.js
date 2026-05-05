"use strict";

console.log("[GASTools] Script loaded and running");

/**
 * G_SHARED_SNIPPETS: Única fuente de verdad compartida.
 * Los providers de Monaco leerán de aquí para evitar registros duplicados.
 */
let G_SHARED_SNIPPETS = [];
let G_ACTIVE_THEME = null;
let G_CURRENT_SETTINGS = {};
let G_GAS_TOOLS_INSTANCE = null;
let G_GLOBALLY_DISABLED = false;
let G_MONACO_READY = false;
let G_GAS_DEFAULT_THEME = null; // Se detecta al inicializar

/**
 * Listener para cuando la extensión está deshabilitada al cargar la página.
 * Establece el flag para evitar inicialización automática.
 */
document.addEventListener('GAS_GlobalDisable', () => {
  G_GLOBALLY_DISABLED = true;
  console.log("[GASTools] Global disable flag set from page load");
});

/**
 * Marca Monaco como listo y procesa los datos pendientes (si los hay).
 * Se llama desde dos sitios:
 *   1. Inmediatamente, si Monaco ya estaba listo cuando este script cargó (cache caliente).
 *   2. Desde el MutationObserver, cuando Monaco aparece tras una mutación del DOM.
 */
function markMonacoReady_() {
  if (G_MONACO_READY) return;
  G_MONACO_READY = true;
  console.log("[GASTools] Monaco detected and ready");

  // Si ya teníamos datos pendientes de un evento GAS_TransferData previo, inicializamos
  if (window._PENDING_GAS_DATA) {
    initializeEditor_(window._PENDING_GAS_DATA);
  }
}

/**
 * MutationObserver para detectar cuándo Monaco se inyecta en el DOM.
 * Solo se usa cuando el script se cargó ANTES de que Monaco existiera.
 */
const G_MAIN_OBSERVER = new MutationObserver((mutations, obs) => {
  if (!window.jsWireMonacoEditor) return;

  // Desconectar SIEMPRE en cuanto detectamos Monaco
  obs.disconnect();
  markMonacoReady_();
});

// CASO CRÍTICO (cache caliente): si window.jsWireMonacoEditor ya está disponible
// cuando este script se ejecuta, el observer nunca se disparará porque depende
// de mutaciones futuras del DOM. Comprobamos sincrónicamente y lo marcamos listo
// de inmediato; si no, observamos el body en espera de la próxima mutación.
if (window.jsWireMonacoEditor) {
  markMonacoReady_();
} else {
  G_MAIN_OBSERVER.observe(document.body, { childList: true, subtree: true });
}

/**
 * Inicialización: crea la instancia cuando llegan los datos del editor
 */
document.addEventListener('GAS_TransferData', function (e) {
  const responseJson_ = JSON.parse(e.detail);
  console.log("[GASTools] Received data in content script:", responseJson_);

  // Guardamos los datos globalmente por si Monaco aún no carga
  window._PENDING_GAS_DATA = responseJson_;

  // Si Monaco ya está listo, inicializamos de inmediato
  if (G_MONACO_READY && window.jsWireMonacoEditor) {
    initializeEditor_(responseJson_);
  } else {
    console.log("[GASTools] Data received but Monaco not ready. Waiting...");
  }
});

/**
 * Permite inicializar la instancia principal del editor personalizado con los datos recibidos.
 * @param {Object} data - Datos base a enviar con cada editor nuevo
 */
function initializeEditor_(data) {
  // Si el usuario desactivó la extensión globalmente, no inicializar
  if (G_GLOBALLY_DISABLED) {
    console.log("[GASTools] Globally disabled, skipping init.");
    window._PENDING_GAS_DATA = null;
    return;
  }

  // Evitar doble inicialización si ya existe instancia
  if (G_GAS_TOOLS_INSTANCE) {
    console.log("[GASTools] Instance already exists, updating with cached data and re-init.");

    // Usar los datos en memoria (ya actualizados por eventos GAS_DataUpdated/GAS_SettingsUpdated)
    G_GAS_TOOLS_INSTANCE.options = {
      ...data,
      settings: Object.keys(G_CURRENT_SETTINGS).length > 0 ? G_CURRENT_SETTINGS : data.settings,
      snippets: G_SHARED_SNIPPETS.length > 0 ? G_SHARED_SNIPPETS : data.snippets,
      activeTheme: G_ACTIVE_THEME || data.activeTheme,
    };

    // Llamar init para reaplicar todo
    G_GAS_TOOLS_INSTANCE.init();
    window._PENDING_GAS_DATA = null;
    return;
  }

  // Iniciamos las mejoras del IDE
  G_GAS_TOOLS_INSTANCE = new GasCustomEditor(data);
  G_GAS_TOOLS_INSTANCE.init();

  // Limpiamos los datos pendientes para evitar doble carga
  window._PENDING_GAS_DATA = null;
}

/**
 * Maneja el evento de settings actualizados desde el popup.
 * Incluye lógica para habilitar/deshabilitar la extensión completamente.
 * @param {CustomEvent} e - Evento con los settings en detail
 */
document.addEventListener('GAS_SettingsUpdated', (e) => {
  console.log("[GASTools] GAS_SettingsUpdated event received!");
  const options = JSON.parse(e.detail);
  console.log("[GASTools] Settings updated:", options);

  // Manejar el toggle global antes que cualquier otra cosa
  if ('global-enable' in options) {
    console.log("[GASTools] RUBENCHO GLOBAL ENABLE:", options['global-enable']);
    if (options['global-enable'] === false) {
      console.log("[GASTools] RUBENCHO DESHABILITAR:", options['global-enable'], G_GAS_TOOLS_INSTANCE);
      // Deshabilitar completamente la extensión
      if (G_GAS_TOOLS_INSTANCE) {
        G_GAS_TOOLS_INSTANCE.disable();
      }
      G_GLOBALLY_DISABLED = true;
      console.log("[GASTools] Extension disabled globally");
      return;
    } else {
      // Habilitar la extensión
      G_GLOBALLY_DISABLED = false;
      if (G_GAS_TOOLS_INSTANCE) {
        G_GAS_TOOLS_INSTANCE.enable();
      } else {
        // Si no hay instancia, necesitamos inicializar desde cero
        // Re-disparar la inicialización con los datos pendientes
        if (window._PENDING_GAS_DATA) {
          initializeEditor_(window._PENDING_GAS_DATA);
        }
      }
      console.log("[GASTools] Extension enabled globally");
      return;
    }
  }

  // Guardar settings en memoria para usarlos al cambiar de archivo
  G_CURRENT_SETTINGS = { ...G_CURRENT_SETTINGS, ...options };
  console.log("[GASTools] Settings updated in memory:", Object.keys(G_CURRENT_SETTINGS));

  if (!G_GAS_TOOLS_INSTANCE) return;

  // Actualizar las opciones internas antes de aplicar
  G_GAS_TOOLS_INSTANCE.options.settings = options;
  G_GAS_TOOLS_INSTANCE.applySettings(options);
});

/**
 * Cuando cambian snippets o temas, le avisamos a la instancia para que recargue.
 */
document.addEventListener('GAS_DataUpdated', (e) => {
  console.log("[GASTools] GAS_DataUpdated received, instance exists:", !!G_GAS_TOOLS_INSTANCE);

  if (!G_GAS_TOOLS_INSTANCE) {
    console.log("[GASTools] No instance, cannot update. Data:", e.detail);
    return;
  }

  const { updateType, data } = JSON.parse(e.detail);
  console.log("[GASTools] Data updated:", updateType, "items:", data);

  if (updateType === 'snippets') {
    // Actualizamos la fuente de verdad compartida y la instancia
    G_SHARED_SNIPPETS = data;
    G_GAS_TOOLS_INSTANCE.options.snippets = data;
    G_GAS_TOOLS_INSTANCE.reloadSnippets();
    console.log("[GASTools] Snippets reloaded, count:", data.length);
  }

  if (updateType === 'themes') {
    console.log("[GASTools] Active theme updated:", data?.text);
    // Actualizamos el tema activo global y la instancia
    G_ACTIVE_THEME = data;
    G_GAS_TOOLS_INSTANCE.options.activeTheme = data;
    G_GAS_TOOLS_INSTANCE.reloadTheme();
    console.log("[GASTools] Theme reloaded");
  }
});

/**
 * Observa cambios de modelo en Monaco para reaplicar snippets cuando el usuario cambia de archivo.
 * @private
 */
function setupModelChangeListener_() {
  if (!window.monaco?.editor) return;

  const originalOnDidCreateModel = window.monaco.editor.onDidCreateModel;
  window.monaco.editor.onDidCreateModel = (callback) => {
    return originalOnDidCreateModel.call(window.monaco.editor, (model) => {
      callback(model);
      // Cuando se crea un nuevo modelo (nuevo archivo), reaplicar snippets
      console.log("[GASTools] New model created, reapplying snippets");
      if (G_GAS_TOOLS_INSTANCE && G_SHARED_SNIPPETS.length > 0) {
        G_GAS_TOOLS_INSTANCE.reloadSnippets();
      }
    });
  };
}


// ─────────────────────────────────────────────
// CLASE PRINCIPAL
// ─────────────────────────────────────────────

class GasCustomEditor {

  constructor(options_) {
    console.log("[GASTools] Constructor called with options:", options_);
    this.options = options_;
    this.editor = null;

    // referenciamos la clase DomUtils para usarla en métodos futuros sin necesidad de importarla cada vez
    this.DomUtils = DomUtils;
    console.log("this.DomUtils reference set in constructor:", this.DomUtils);

    // Variables para manejo de estado interno
    this._currentSnippets = [];

    // Para el observer de prioridad de tema
    this._themePatched = false;

    // Contenedor del menú de herramientas de GAS donde inyectamos el botón de búsqueda.
    // Puede no existir aún cuando el constructor corre; se resuelve diferidamente
    // dentro de `_enableAdvancedSearch` mediante `_waitForToolsMenu_`.
    this._toolsMenuElement = null;
    this._searchPanel = null;
    this._chatPanel = null;

    // Referencias para desmontar listeners al desactivar.
    this._toolbarParentElement = null;
    this._onSearchButtonClick = null;
    this._onChatButtonClick = null;
    this._onSearchShortcut = null;
    this._onChatShortcut = null;

    // Listeners de cambio de modelo Monaco
    this._modelChangeDisposable = null;
    this._modelCreateDisposable = null;

    // Verificación de cambio de archivo
    this._lastModelUri = null;
    this._fileCheckInterval = null;

    // Tema por defecto de GAS
    this._defaultThemeName = 'vs-light';
    console.log("[GASTools] Default theme captured:", this._defaultThemeName);
  }

  // ──────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────

  /**
   * Punto de entrada: aplica configuración inicial, registra snippets y aplica tema.
   *
   * IMPORTANTE: Esperamos PRIMERO a que la barra de herramientas de GAS (`.INSTk`)
   * esté disponible antes de continuar, ya que varios pasos posteriores
   * (botón de búsqueda avanzada, futuras integraciones de UI, etc.) dependen
   * de que ese contenedor exista en el DOM. Así evitamos race conditions
   * intermitentes en las que el editor Monaco aparece antes que la toolbar.
   */
  async init() {
    // Capturamos el editor que ya sabemos que existe gracias al Observer
    this.editor = window.jsWireMonacoEditor;
    if (!this.editor) return;

    // Tema por defecto de GAS
    this._defaultThemeName = this.editor._themeService._theme.themeName;
    console.log("[GASTools] Default theme captured - INIT:", this._defaultThemeName);

    // El elemento de referencia para este editor (puede ser útil para futuras mejoras específicas por editor)
    this.element = document.querySelector("[data-gasreference='" + this.options.referenceId + "']");

    console.log("[GASTools] Initializing Editor Instance");

    // Esperamos a que la barra de herramientas de GAS esté lista en el DOM.
    // Bloquea aquí hasta 15 s; si no aparece, seguimos en modo degradado
    // (el resto del editor funciona, pero no inyectamos UI dependiente de la toolbar).
    this._toolsMenuElement = await this._waitForToolsMenu_();
    if (!this._toolsMenuElement) {
      console.warn("[GASTools] Tools menu (.INSTk) no encontrado tras esperar. Continuando sin UI inyectada.");
    }

    // Aplicar opciones del editor (minimap, wordWrap, etc.)
    this.applySettings(this.options.settings || {});

    // Registrar snippets como completion provider
    await this.reloadSnippets();

    // Aplicar tema activo
    await this.reloadTheme();

    // Inicializamos el mapa URI → nombre legible de archivo
    this._fileNameObjectMap = new Map();

    // Construimos el mapa de archivos
    this._buildUriToNameMap();

    // Habilitamos el campo de búsqueda avanzada (solo si la toolbar existe)
    if (this._toolsMenuElement) {
      this._enableAdvancedSearch();
      this._injectChatPanel_();
    }

    // Escuchar cambios de modelo para mantener snippets activos al cambiar de archivo
    this._setupModelListeners_();
  }

  /**
   * Configura listeners para detectar cuando el usuario cambia de archivo (modelo).
   * Esto asegura que los snippets y configuraciones se reaplican al cambiar entre archivos.
   * @private
   */
  _setupModelListeners_() {
    console.log("[GASTools] Setting up model listeners...");
    if (!this.editor) {
      console.log("[GASTools] No editor, cannot setup listeners");
      return;
    }

    // Escuchar cuando se cambia el modelo activo
    this._modelChangeDisposable = this.editor.onDidChangeModel(() => {
      console.log("[GASTools] Model changed, reapplying snippets and theme");
      // Reaplicar snippets al cambiar de archivo
      if (G_SHARED_SNIPPETS.length > 0) {
        this.reloadSnippets();
      }
      // Reaplicar tema al cambiar de archivo
      this.reloadTheme();
      // Reconstruir el mapa de archivos
      this._buildUriToNameMap();
    });

    // También escuchar cuando se crea un nuevo modelo
    if (window.monaco?.editor) {
      this._modelCreateDisposable = window.monaco.editor.onDidCreateModel((model) => {
        console.log("[GASTools] New model created:", model.uri.toString());
        // Reaplicar snippets para el nuevo modelo
        if (G_SHARED_SNIPPETS.length > 0) {
          this.reloadSnippets();
        }
        // Reaplicar tema para el nuevo modelo
        this.reloadTheme();
      });
    }

    // También escuchar el evento de cambio de modelo del editor directamente
    if (this.editor.onDidChangeModelUri) {
      this.editor.onDidChangeModelUri(() => {
        console.log("[GASTools] Model URI changed");
        if (G_SHARED_SNIPPETS.length > 0) {
          this.reloadSnippets();
        }
        this.reloadTheme();
        this._buildUriToNameMap();
      });
    }

    // Escuchar cambios de modelo desde el modelo activo directamente
    const currentModel = this.editor.getModel();
    if (currentModel) {
      console.log("[GASTools] Current model:", currentModel.uri.toString());
      // El modelo puede tener su propio listener de cambio
    }

    // Observador de mutaciones para detectar cambios en el DOM del IDE (cambio de archivo activo)
    this._setupDomObserver_();

    console.log("[GASTools] Model listeners setup complete");
  }

  /**
   * Escucha cambios de foco y ejecuta verificaciones periódicas.
   * @private
   */
  _setupDomObserver_() {
    // Escuchar cambios de foco del editor
    this.editor.onDidFocusEditorText(() => {
      console.log("[GASTools] Editor focused, refreshing snippets and theme");
      if (G_SHARED_SNIPPETS.length > 0) {
        this.reloadSnippets();
      }
      this.reloadTheme();
      this._buildUriToNameMap();
    });

    // Verificación periódica cada 2 segundos para detectar cambios de archivo
    this._fileCheckInterval = setInterval(() => {
      const currentModel = this.editor?.getModel();
      if (currentModel && this._lastModelUri !== currentModel.uri.toString()) {
        console.log("[GASTools] Model changed (interval), refreshing");
        this._lastModelUri = currentModel.uri.toString();
        if (G_SHARED_SNIPPETS.length > 0) {
          this.reloadSnippets();
        }
        this.reloadTheme();
        this._buildUriToNameMap();
      }
    }, 2000);

    console.log("[GASTools] Editor focus and interval listener setup");
  }

  /**
   * Detiene la verificación periódica.
   * @private
   */
  _stopFileCheckInterval_() {
    if (this._fileCheckInterval) {
      clearInterval(this._fileCheckInterval);
      this._fileCheckInterval = null;
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
    const map = new Map();

    // 1. Obtener archivos del DOM en orden visual real
    const items = [...document.querySelectorAll('li[role="option"][data-res-id]')];

    const files = items.map(li => ({
      name: li.getAttribute('aria-label')?.trim(),
      index: parseInt(li.getAttribute('data-index'), 10)
    }))
      .filter(f => f.name)
      .sort((a, b) => a.index - b.index);

    // 2. Separar appsscript.json
    const normalFiles = files.filter(f => f.name !== 'appsscript.json');
    const appScript = files.find(f => f.name === 'appsscript.json');

    // 3. Obtener modelos Monaco ordenados
    const models = (window.monaco?.editor?.getModels?.() || [])
      .map(m => ({
        uri: m.uri.toString(),
        id: parseInt(m.uri.path.replace('/', ''), 10)
      }))
      .sort((a, b) => a.id - b.id);

    // 4. Asignar archivos normales en orden
    let modelIndex = 0;

    for (const file of normalFiles) {
      const model = models[modelIndex++];
      if (model) {
        map.set(model.uri, file.name);
      }
    }

    // 5. Insertar appsscript.json en su posición correcta
    if (appScript) {
      // Este "3" puedes hacerlo dinámico si quieres luego
      const target = models.find(m => m.id === 3);
      if (target) {
        map.set(target.uri, appScript.name);
      }
    }

    // 6. Guardar en cache global
    this._fileNameObjectMap = map;

    console.log('[GasSearch] 🚀 Mapa final:', map);
  }

  /**
   * Devuelve un nombre legible para un modelo Monaco.
   *
   * Estrategia de resolución (en orden de preferencia):
   *   1. Cache por URI (hit rápido, evita recalcular).
   *   2. Basename de la URI si parece un nombre de archivo real (.gs, .json, etc.).
   *   3. Fallback: "File N".
   *
   * @param {object} model
   * @param {number} [index=0]
   * @returns {string}
   */
  _formatModelName(model, index = 0) {
    // Permite obtener la URL del modelo actual
    const uriKey = String(
      model?.uri?.toString?.() || model?.uri?._formatted || model?.uri?.path || ''
    );
    if (uriKey && this._fileNameObjectMap.has(uriKey)) {
      return this._fileNameObjectMap.get(uriKey);
    }
    // Si por alguna razón no está en cache (modelo añadido después de abrir),
    // intentamos el basename directo de la URI.
    const rawPath = String(model?.uri?.path || model?.uri?._formatted || '');
    if (rawPath) {
      const parts = rawPath.split('/').filter(Boolean);
      const baseName = parts[parts.length - 1] || '';
      if (this._looksLikeRealFileName(baseName)) return baseName;
    }
    return `File ${index + 1}`;
  }

  /**
   * Determina si una cadena tiene aspecto de nombre real de archivo.
   * Acepta .gs, .js, .ts, .json, .html, .css, .md, .txt
   * Descarta cadenas genéricas como "Model 1".
   * @param {string} value
   * @returns {boolean}
   */
  _looksLikeRealFileName(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/^model\s*\d+$/i.test(text)) return false;
    return /\.(gs|js|ts|json|html|css|md|txt)$/i.test(text);
  }

  /**
   * Habilita el campo de búsqueda avanzada en el editor, que por defecto está oculto en GAS.
   *
   * Precondición: `init()` ya garantizó que `this._toolsMenuElement` (el contenedor `.INSTk`)
   * existe — la espera se hace al inicio de init() porque otras partes futuras
   * de la UI también dependen de la toolbar.
   */
  _enableAdvancedSearch() {
    console.log("[GASTools] Enabling advanced search UI...");

    // Si por algún motivo la toolbar no está disponible, no hacemos nada.
    // (init() ya loguea el warning correspondiente).
    if (!this._toolsMenuElement) return;

    this._injectAdvancedSearch_();
  }

  /**
   * Espera a que el contenedor `.INSTk` esté disponible en el DOM.
   * Usa un MutationObserver con timeout máximo de 15s para no bloquear indefinidamente.
   * @returns {Promise<HTMLElement|null>} Resuelve con el elemento o null si nunca aparece.
   * @private
   */
  _waitForToolsMenu_() {
    return new Promise((resolve) => {
      // Si ya existe, resolvemos de inmediato
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

      // Observer que vigila la aparición del contenedor en el DOM
      const observer = new MutationObserver(() => {
        const found = document.querySelector('.INSTk');
        if (found) finish(found);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Timeout de seguridad: 15 segundos máximo de espera
      const timeoutId = setTimeout(() => finish(null), 15000);
    });
  }

  /**
   * Inyecta el botón de búsqueda avanzada y el panel asociado en el DOM de GAS.
   * Se separa de `_enableAdvancedSearch` para mantener la lógica de espera aislada.
   * @private
   */
  _injectAdvancedSearch_() {
    const _this = this;
    console.log("[GASTools] Targeting tools menu element:", this._toolsMenuElement);

    // Evitar duplicados: si el botón ya existe, no hacemos nada
    if (document.getElementById("buttonAdvancedSearch")) return;

    // 1. Limpieza de elementos antiguos (si existieran por un re-init)
    this.DomUtils.remove("buttonAdvancedSearch");
    this.DomUtils.remove("ctnCurrentFileName");

    // 2. Creación del nuevo elemento contenedor del botón
    const option = document.createElement('div');
    option.className = "yggLIc";
    option.id = "buttonAdvancedSearch";

    // 3. Inserción segura de HTML usando la política centralizada en DomUtils
    // Nota: el HTML viene precargado en options.searchButton (loadResources)
    this.DomUtils.setHTML(option, this.options.searchButton);

    // 4. Inyectar el contenedor en el DOM de GAS, ANTES del menú `.INSTk`
    //    (no como hijo) para que aparezca a la izquierda del bloque de tools.
    this._toolsMenuElement.parentNode.insertBefore(option, this._toolsMenuElement);

    // 5. Inyectar el Web Component <gas-search-panel> en el body si no existe
    if (!document.querySelector('gas-search-panel')) {
      this._searchPanel = document.createElement('gas-search-panel');
      document.body.appendChild(this._searchPanel);
    } else {
      this._searchPanel = document.querySelector('gas-search-panel');
    }

    // Enlazamos la instancia del editor en el componente para permitir "goto line".
    this._searchPanel.setEditor(this.editor);

    // 6. Escuchar el clic en el botón recién creado usando DomUtils (event delegation).
    //    Delegamos en el padre porque el botón vive ahora fuera de `.INSTk`.
    this._toolbarParentElement = this._toolsMenuElement.parentNode;
    this._onSearchButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnSearchGas');
      if (!trigger || !this._toolbarParentElement?.contains(trigger)) return;
      e.preventDefault();
      console.log("[GASTools] Advanced Search button clicked");

      // Refrescamos la lista actualizada del mapa de archivos antes de mostrar el panel
      this._buildUriToNameMap();
      // Compartimos la función para resolver nombres de modelo con el panel
      this._searchPanel._formatModelName = _this._formatModelName;

      // Establecemos la lista actualizada de archivos en el panel
      this._searchPanel.setFileNameObjectMap(_this._fileNameObjectMap);

      // Mostramos / ocultamos el panel anclado al botón
      this._searchPanel.toggle(trigger, this._fileNameObjectMap);
    };
    this._toolbarParentElement.addEventListener('click', this._onSearchButtonClick);

    // Atajo global solicitado: Alt + Shift + F (registrado a nivel documento)
    if (!this._searchShortcutBound) {
      this._searchShortcutBound = true;
      this._onSearchShortcut = (evt) => {
        const isF = (evt.key || '').toLowerCase() === 'f';
        const requestedShortcut = isF && evt.altKey && evt.shiftKey;
        if (!requestedShortcut) return;

        evt.preventDefault();
        evt.stopPropagation();
        const anchorBtn = document.querySelector('#rsBtnSearchGas');
        this._searchPanel?.toggle(anchorBtn);
      };
      document.addEventListener('keydown', this._onSearchShortcut, true);
    }

    // Registramos el mismo atajo dentro de Monaco para que responda directo en el IDE.
    if (!this._searchMonacoCommandBound && this.editor?.addCommand && window.monaco?.KeyMod && window.monaco?.KeyCode) {
      this._searchMonacoCommandBound = true;
      this.editor.addCommand(
        window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | window.monaco.KeyCode.KeyF,
        () => {
          const anchorBtn = document.querySelector('#rsBtnSearchGas');
          this._searchPanel?.toggle(anchorBtn);
        }
      );
    }

    console.log("[GASTools] Advanced search UI injected.");
  }

  /**
   * Inyecta el botón del chat AI en la toolbar y el Web Component <gas-chat-panel>.
   *
   * Patrón análogo a `_injectAdvancedSearch_`:
   *   1. Crea un contenedor con el HTML del botón (precargado en options.chatButton).
   *   2. Inserta el componente <gas-chat-panel> en el body si no existe.
   *   3. Conecta la instancia de Monaco con el panel (setEditor).
   *   4. Registra el click delegado en #rsBtnChatGas para abrir/cerrar el panel.
   *   5. Registra el atajo Alt+Shift+C tanto a nivel documento como dentro de Monaco.
   * @private
   */
  _injectChatPanel_() {
    // Evitar duplicados si init() corre dos veces (cache caliente, re-attach, etc.)
    if (document.getElementById('buttonChatGas')) return;

    // 1. Contenedor del botón
    const option = document.createElement('div');
    option.className = 'yggLIc';
    option.id = 'buttonChatGas';
    this.DomUtils.setHTML(option, this.options.chatButton);
    // Insertamos el botón ANTES de la toolbar `.INSTk` (no dentro de ella).
    this._toolsMenuElement.parentNode.insertBefore(option, this._toolsMenuElement);

    // 2. Web Component (uno por documento, compartido entre instancias del editor)
    if (!document.querySelector('gas-chat-panel')) {
      this._chatPanel = document.createElement('gas-chat-panel');
      document.body.appendChild(this._chatPanel);
    } else {
      this._chatPanel = document.querySelector('gas-chat-panel');
    }

    // 3. Mantener la instancia activa de Monaco en el panel (cambia al hacer setModel).
    this._chatPanel.setEditor(this.editor);

    // 4. Click en el botón → toggle del panel (delegado en el padre, ya que el
    //    botón vive ahora fuera de `.INSTk`).
    this._toolbarParentElement = this._toolsMenuElement.parentNode;
    this._onChatButtonClick = (e) => {
      const trigger = e.target.closest('#rsBtnChatGas');
      if (!trigger || !this._toolbarParentElement?.contains(trigger)) return;
      e.preventDefault();
      // Refrescamos la referencia al editor por si cambió desde la última apertura.
      this._chatPanel.setEditor(this.editor);
      this._chatPanel.toggle();
    };
    this._toolbarParentElement.addEventListener('click', this._onChatButtonClick);

    // 5. Atajo global Alt+Shift+C (a nivel documento, una sola vez)
    if (!this._chatShortcutBound) {
      this._chatShortcutBound = true;
      this._onChatShortcut = (evt) => {
        const isC = (evt.key || '').toLowerCase() === 'c';
        if (!(isC && evt.altKey && evt.shiftKey)) return;
        evt.preventDefault();
        evt.stopPropagation();
        this._chatPanel?.setEditor(this.editor);
        this._chatPanel?.toggle();
      };
      document.addEventListener('keydown', this._onChatShortcut, true);
    }

    // Registramos el mismo atajo dentro de Monaco para que responda también con foco en el editor.
    if (!this._chatMonacoCommandBound && this.editor?.addCommand && window.monaco?.KeyMod && window.monaco?.KeyCode) {
      this._chatMonacoCommandBound = true;
      this.editor.addCommand(
        window.monaco.KeyMod.Alt | window.monaco.KeyMod.Shift | window.monaco.KeyCode.KeyC,
        () => {
          this._chatPanel?.setEditor(this.editor);
          this._chatPanel?.toggle();
        }
      );
    }

    console.log("[GASTools] AI chat panel injected.");
  }

  /**
   * Aplica un mapa de opciones directamente sobre la instancia de Monaco.
   * Solo actualiza las propiedades que realmente cambiaron.
   * @param {Object} settings - Mapa { optionId: boolean }
   */
  applySettings(settings) {
    if (!this.editor) {
      console.warn("[GASTools] Monaco editor not available yet");
      return;
    }

    const SETTINGS_MAP = {
      // Visuales
      'showMinimap': (val) => this.editor.updateOptions({ minimap: { enabled: val } }),
      'lineNumbers': (val) => this.editor.updateOptions({ lineNumbers: val ? 'on' : 'off' }),
      'wordWrap': (val) => this.editor.updateOptions({ wordWrap: val ? 'on' : 'off' }),
      'renderLineHighlight': (val) => this.editor.updateOptions({ renderLineHighlight: val ? 'line' : 'none' }),
      // Code assistance
      'bracketPairs': (val) => this.editor.updateOptions({ bracketPairColorization: { enabled: val } }),
      'quickSuggestions': (val) => this.editor.updateOptions({ quickSuggestions: val }),
      'autoClosingBrackets': (val) => this.editor.updateOptions({ autoClosingBrackets: val ? 'always' : 'never' }),
      'tabCompletion': (val) => this.editor.updateOptions({ tabCompletion: val ? 'on' : 'off' }),
      'formatOnPaste': (val) => this.editor.updateOptions({ formatOnPaste: val }),
      // Navigation
      'folding': (val) => this.editor.updateOptions({ folding: val }),
      'foldingHighlight': (val) => this.editor.updateOptions({ foldingHighlight: val }),
      'peekWidget': (val) => this.editor.updateOptions({ definitionLinkOpensInPeek: val }),
      // Scrolling
      'smoothScrolling': (val) => this.editor.updateOptions({ smoothScrolling: val }),
      'scrollBeyondLastLine': (val) => this.editor.updateOptions({ scrollBeyondLastLine: val }),
    };

    Object.entries(settings).forEach(([key, value]) => {
      if (key === 'global-enable') return;

      const handler = SETTINGS_MAP[key];
      if (handler) {
        try {
          handler(value);
          console.log(`[GASTools] Applied setting: ${key} = ${value}`);
        } catch (err) {
          console.warn(`[GASTools] Could not apply setting "${key}":`, err);
        }
      }
    });
  }

  // ──────────────────────────────────────────
  // SNIPPETS
  // ──────────────────────────────────────────

  /**
   * Carga los snippets y los registra en Monaco.
   * Soporta múltiples lenguajes (JS/TS y HTML) de forma única para evitar duplicados.
   */
  async reloadSnippets() {
    try {
      // Usar la variable global como fuente de verdad (puede haber sido actualizada por eventos externos)
      if (!G_SHARED_SNIPPETS.length && this.options.snippets) {
        G_SHARED_SNIPPETS = this.options.snippets;
      }
      console.log("[GASTools] Snippets loaded into shared variable. Count:", G_SHARED_SNIPPETS.length);

      // Evitar registros múltiples si ya existen providers activos en la sesión
      if (GasCustomEditor.providersRegistered) {
        console.log("[GASTools] Snippet providers already active. Data updated.");
        return;
      }

      console.log("[GASTools] Registering Global Snippet Providers...");

      // Definimos los grupos de lenguajes que queremos soportar
      const langGroups = [
        { id: 'html', types: ['html'] },
        { id: 'javascript', types: ['javascript', 'typescript', 'js', 'google apps script'] },
        { id: 'google apps script', types: ['javascript', 'typescript', 'js', 'google apps script'] }
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

            // Filtrar desde la fuente de verdad GLOBAL compartida
            const filteredSnippets = G_SHARED_SNIPPETS.filter(s =>
              group.types.includes(s.lang?.toLowerCase())
            );

            const suggestions = this._buildSuggestions(filteredSnippets, range);
            return { suggestions };
          }
        });
      });

      // Marcar como registrado a nivel estático de clase
      GasCustomEditor.providersRegistered = true;
      console.log(`[GASTools] Providers registered successfully.`);
    } catch (err) {
      console.error("[GASTools] Error registering snippets:", err);
    }
  }

  /**
   * Convierte los snippets del storage en objetos de sugerencia de Monaco.
   * @param {Array} snippets
   * @param {monaco.IRange} range
   * @returns {Array}
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
   * Carga el tema activo desde el background y lo aplica a Monaco.
   */
  async reloadTheme() {
    try {
      console.log("[GASTools] Reloading theme", this.options);
      const themeData = this.options.activeTheme;
      if (!themeData) return;

      // Precalculamos el nombre del tema una sola vez
      const NATIVE = ['vs', 'vs-dark', 'hc-black', 'hc-light'];
      const isNative = themeData.protected && NATIVE.includes(themeData.value);
      const themeName = isNative ? themeData.value : `qc-theme-${themeData.value}`;

      // Registrar el tema custom en Monaco (solo necesario una vez por tema)
      if (!isNative && themeData.data) {
        monaco.editor.defineTheme(themeName, this._buildMonacoTheme(themeData));
      }

      // Interceptar setTheme para que nuestra extensión siempre gane
      this._interceptSetTheme(themeName);

      // Aplicar inmediatamente
      monaco.editor.setTheme(themeName);
      console.log("[GASTools] Theme applied:", themeName);

    } catch (err) {
      console.error("[GASTools] Error reloading theme:", err);
    }
  }

  /**
   * Monkey-patch de monaco.editor.setTheme.
   * Cualquier llamada externa (GAS, otra extensión) que intente cambiar el tema
   * será interceptada y reemplazada por el nuestro.
   *
   * Solo se aplica el patch una vez; si el tema cambia, se actualiza _activeThemeName.
   */
  _interceptSetTheme(ourThemeName) {
    // Guardamos el nombre activo para que el interceptor siempre use el más reciente
    this._activeThemeName = ourThemeName;

    // Si ya patcheamos, solo actualizamos el nombre y listo
    if (this._themePatched) {
      console.log("[GASTools] Patch already active, updated theme target:", ourThemeName);
      return;
    }

    // Guardamos la función original para no perderla y evitar recursión infinita
    this.originalSetTheme = monaco.editor.setTheme.bind(monaco.editor);
    const self = this;

    // Establece el tema que nosotros manejamos
    monaco.editor.setTheme = function (requestedTheme) {
      const target = self._activeThemeName;

      // Si el caller ya pide nuestro tema, dejamos pasar sin recursión
      if (requestedTheme === target) {
        return self.originalSetTheme(requestedTheme);
      }

      // Cualquier otro intento de cambio de tema lo bloqueamos y aplicamos el nuestro
      console.log(`[GASTools] Blocked theme change: "${requestedTheme}" → enforcing "${target}"`);
      return self.originalSetTheme(target);
    };

    // Marcamos que ya aplicamos el patch para no hacerlo de nuevo
    this._themePatched = true;
    console.log("[GASTools] setTheme intercepted. Our theme will always win.");
  }

  /**
   * Convierte la estructura del popup en un ThemeData válido para Monaco.
   */
  _buildMonacoTheme(themeEntry) {
    const data = themeEntry.data || {};

    const colors = {};
    if (data.colors && typeof data.colors === 'object') {
      Object.entries(data.colors).forEach(([key, value]) => {
        colors[key] = this._normalizeColor(value);
      });
    }

    const rules = (data.rules || []).map(rule => ({
      token: rule.token,
      foreground: this._normalizeColor(rule.foreground).replace('#', ''),
      fontStyle: rule.fontStyle !== 'normal' ? rule.fontStyle : undefined,
    })).filter(r => r.token);

    return {
      base: data.base || 'vs-dark',
      inherit: data.inherit !== false,
      rules,
      colors,
    };
  }

  /**
   * Normaliza un string de color a formato #RRGGBB o #RRGGBBAA.
   */
  _normalizeColor(color) {
    if (!color || typeof color !== 'string') return '#ffffff';
    const c = color.trim().startsWith('#') ? color.trim() : `#${color.trim()}`;
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    if (/^#[0-9a-fA-F]{6,8}$/.test(c)) return c;
    const digits = c.replace('#', '').replace(/[^0-9a-fA-F]/g, '');
    return digits.length >= 6 ? `#${digits.substring(0, 6)}` : '#ffffff';
  }

  /**
   * Desactiva todas las mejoras de la extensión:
   * - Restaura el tema original de GAS (vs-dark)
   * - Elimina el patch de setTheme para que GAS vuelva a controlarlo
   * - Vacía los snippets para que no aparezcan en el autocompletado
   */
  disable() {
    console.log("[GASTools] Disabling extension...", {
      hasInstance: !!this,
      hasEditor: !!this.editor,
      hasToolbar: !!this._toolsMenuElement
    });

    // 1. Limpiar variables globales
    G_CURRENT_SETTINGS = {};
    G_ACTIVE_THEME = null;
    G_SHARED_SNIPPETS = [];

    // 2. Restaurar control de temas a GAS
    console.log("[GASTools] Calling _releaseThemeControl...");
    this._releaseThemeControl();

    // Resetear flag de theme para que al habilitar se detecte nuevamente
    this._themePatched = false;

    // 3. Revertir settings del editor a defaults de Monaco/GAS
    console.log("[GASTools] Calling _resetEditorDefaults...");
    this._resetEditorDefaults();

    // 4. Limpiar UI inyectada (botones y web components)
    console.log("[GASTools] Calling _teardownInjectedUi_...");
    this._teardownInjectedUi_();

    console.log("[GASTools] Extension disabled and UI cleaned.");
  }

  /**
     * Reactiva todas las mejoras con los settings guardados.
     * No llama a init() para evitar duplicar comandos de Monaco.
     * En su lugar, re-inyecta la UI y reaplica todo manualmente.
     */
  /** Restablece el estado de la extensión: reaplica settings, recarga snippets, tema e inyecta UI. */
  enable() {
    console.log("[GASTools] Re-enabling extension...");

    // 1. Re-aplicar settings desde memoria (o los defaults)
    const settingsToApply = Object.keys(G_CURRENT_SETTINGS).length > 0
      ? G_CURRENT_SETTINGS
      : this.options.settings || {};
    this.applySettings(settingsToApply);
    this.options.settings = settingsToApply;

    // 2. Re-cargar snippets desde memoria (o los defaults)
    const snippetsToUse = G_SHARED_SNIPPETS.length > 0
      ? G_SHARED_SNIPPETS
      : (this.options.snippets || []);
    G_SHARED_SNIPPETS = snippetsToUse;

    // 3. Re-aplicar tema desde memoria (o el que venía en options)
    const themeToUse = G_ACTIVE_THEME || this.options.activeTheme;
    this.options.activeTheme = themeToUse;

    // 4. Re-inyectar botones y paneles sin usar init()
    // Esto evita que se dupliquen comandos de Monaco
    this._reinjectUI_();

    // 5. Recargar snippets y tema
    this.reloadSnippets();
    this.reloadTheme();

    console.log("[GASTools] Extension re-enabled with", G_SHARED_SNIPPETS.length, "snippets");
  }

  /**
   * Re-inyecta los elementos de UI sin inicializar todo desde cero.
   * Utilizado cuando se vuelve a habilitar la extensión.
   * @private
   */
  _reinjectUI_() {
    if (!this._toolsMenuElement) {
      this._waitForToolsMenu_().then(() => {
        if (this._toolsMenuElement) {
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
   * Elimina los elementos inyectados por la extensión en el DOM de GAS.
   * Se usa al desactivar globalmente para que el editor quede limpio.
   * Nota: Los flags de comandos de Monaco NO se resetean para evitar
   * duplicados al volver a habilitar la extensión.
   * @private
   */
  _teardownInjectedUi_() {
    this._searchPanel?.close?.();
    this._chatPanel?.close?.();

    if (this._toolbarParentElement) {
      if (this._onSearchButtonClick) {
        this._toolbarParentElement.removeEventListener('click', this._onSearchButtonClick);
      }
      if (this._onChatButtonClick) {
        this._toolbarParentElement.removeEventListener('click', this._onChatButtonClick);
      }
    }

    if (this._onSearchShortcut) {
      document.removeEventListener('keydown', this._onSearchShortcut, true);
    }
    if (this._onChatShortcut) {
      document.removeEventListener('keydown', this._onChatShortcut, true);
    }

    this.DomUtils.remove('buttonAdvancedSearch');
    this.DomUtils.remove('buttonChatGas');
    this.DomUtils.remove('ctnCurrentFileName');
    this.DomUtils.remove('sltRubThemeList');

    document.querySelector('gas-search-panel')?.remove();
    document.querySelector('gas-chat-panel')?.remove();

    this._toolbarParentElement = null;
    this._onSearchButtonClick = null;
    this._onChatButtonClick = null;
    this._onSearchShortcut = null;
    this._onChatShortcut = null;
    this._searchShortcutBound = false;
    this._chatShortcutBound = false;
    // No reseteamos _searchMonacoCommandBound ni _chatMonacoCommandBound
    // para evitar duplicar comandos de Monaco al re-habilitar
    this._searchPanel = null;
    this._chatPanel = null;

    // Limpiar listeners de cambio de modelo Monaco
    if (this._modelChangeDisposable) {
      this._modelChangeDisposable.dispose();
      this._modelChangeDisposable = null;
    }
    if (this._modelCreateDisposable) {
      this._modelCreateDisposable.dispose();
      this._modelCreateDisposable = null;
    }

    // Limpiar verificación periódica de cambio de archivo
    this._stopFileCheckInterval_();
    this._lastModelUri = null;
  }

  /**
   * Libera el control del tema: restaura monaco.editor.setTheme original
   * y aplica el tema por defecto de GAS.
   * @private
   */
  _releaseThemeControl() {
    // Importante: la función original se guarda como `this.originalSetTheme` (sin guion bajo)
    // dentro de `_interceptSetTheme`. Antes este método chequeaba `_originalSetTheme`
    // y por eso nunca se ejecutaba al desactivar la extensión.
    if (!this._themePatched || !this.originalSetTheme) return;

    // Restauramos la función original en Monaco
    monaco.editor.setTheme = this.originalSetTheme;
    this._themePatched = false;
    this._activeThemeName = null;

    // Dejamos que GAS retome el control aplicando su tema original
    monaco.editor.setTheme(this._defaultThemeName);
    console.log("[GASTools] Theme control released, restored to:", defaultTheme);
  }

  /**
   * Revierte las opciones del editor a los valores por defecto de GAS.
   * @private
   */
  _resetEditorDefaults() {
    if (!this.editor) return;
    try {
      this.editor.updateOptions({
        // Visuales
        minimap: { enabled: true },
        lineNumbers: 'on',
        wordWrap: 'off',
        renderLineHighlight: 'line',
        // Code assistance
        bracketPairColorization: { enabled: false },
        quickSuggestions: true,
        autoClosingBrackets: 'always',
        tabCompletion: 'off',
        formatOnPaste: false,
        // Navigation
        folding: true,
        foldingHighlight: true,
        definitionLinkOpensInPeek: false,
        // Scrolling
        smoothScrolling: false,
        scrollBeyondLastLine: true,
      });
    } catch (err) {
      console.warn("[GASTools] Error resetting defaults:", err);
    }
  }
}