"use strict";

/**
 * G_SHARED_SNIPPETS: Única fuente de verdad compartida.
 * Los providers de Monaco leerán de aquí para evitar registros duplicados.
 */
let G_SHARED_SNIPPETS = [];
let G_GAS_TOOLS_INSTANCE = null;
let G_GLOBALLY_DISABLED = false;
let G_MONACO_READY = false;

/**
 * MutationObserver para detectar cuándo Monaco se inyecta en el DOM
 */
const G_MAIN_OBSERVER = new MutationObserver((mutations, obs) => {
  if (!window.jsWireMonacoEditor) return;

  // Desconectar SIEMPRE, independientemente de si hay datos pendientes.
  obs.disconnect();
  G_MONACO_READY = true;

  console.log("[GASTools] Monaco detected via MutationObserver");
  console.log("[GASTools] Pending data for editor initialization:", window._PENDING_GAS_DATA);
  
  // Si ya teníamos datos pendientes, inicializamos
  if (window._PENDING_GAS_DATA) {
    // Iniciamos el editor
    initializeEditor_(window._PENDING_GAS_DATA);
  }
});

// Empezamos a observar el body en busca de cambios en los hijos
G_MAIN_OBSERVER.observe(document.body, { childList: true, subtree: true });

/**
 * Inicialización: crea la instancia cuando llegan los datos del editor
 */
document.addEventListener('GAS_TransferData', function(e) {
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
  // Evitar doble inicialización si ya existe instancia
  if (G_GAS_TOOLS_INSTANCE) {
    console.log("[GASTools] Instance already exists, skipping re-init.");
    G_GAS_TOOLS_INSTANCE.options = data;
    G_GAS_TOOLS_INSTANCE.init(); // El init volverá a llamar applySettings, reloadSnippets y reloadTheme
    window._PENDING_GAS_DATA = null;
    return;
  }

  // Si el usuario desactivó la extensión mientras cargaba, no inicializar
  if (G_GLOBALLY_DISABLED) {
    console.log("[GASTools] Globally disabled, skipping init.");
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
 * Cuando el popup guarda cambios en settings, actualizamos el editor activo.
 */
document.addEventListener('GAS_SettingsUpdated', (e) => {
  const options = JSON.parse(e.detail);
  console.log("[GASTools] Settings updated:", options);

  // Manejar el toggle global antes que cualquier otra cosa
  if ('global-enable' in options) {
    if (options['global-enable'] === false) {
      // Si no hay instancia aún, solo bloqueamos la inicialización futura
      if (G_GAS_TOOLS_INSTANCE) G_GAS_TOOLS_INSTANCE.disable();
      G_GLOBALLY_DISABLED = true;
      return;
    } else {
      G_GLOBALLY_DISABLED = false;
      if (G_GAS_TOOLS_INSTANCE) G_GAS_TOOLS_INSTANCE.enable();
      // No return: puede venir con otros settings también
    }
  }

  if (!G_GAS_TOOLS_INSTANCE) return;

  // Actualizar las opciones internas antes de aplicar
  G_GAS_TOOLS_INSTANCE.options.settings = options;
  G_GAS_TOOLS_INSTANCE.applySettings(options);
});

/**
 * Cuando cambian snippets o temas, le avisamos a la instancia para que recargue.
 */
document.addEventListener('GAS_DataUpdated', (e) => {
  if (!G_GAS_TOOLS_INSTANCE) return;
  
  const { updateType, data } = JSON.parse(e.detail);
  console.log("[GASTools] Data updated:", updateType);

  if (updateType === 'snippets') {
    // Actualizamos la fuente de verdad compartida y la instancia
    G_SHARED_SNIPPETS = data;
    G_GAS_TOOLS_INSTANCE.options.snippets = data; 
    G_GAS_TOOLS_INSTANCE.reloadSnippets();
  }
  
  if (updateType === 'themes') {
    console.log("[GASTools] Active theme updated:", data);
    // Actualizamos el tema activo en la instancia
    G_GAS_TOOLS_INSTANCE.options.activeTheme = data; 
    G_GAS_TOOLS_INSTANCE.reloadTheme();
  }
});


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

    // definimo el elento donde podemos agregar acciones en el menu de herramientas
    this._toolsMenuElement = document.querySelector('.INSTk');
    this._searchPanel = null;
  }

  // ──────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────

  /**
   * Punto de entrada: aplica configuración inicial, registra snippets y aplica tema.
   */
  async init() {
    // Capturamos el editor que ya sabemos que existe gracias al Observer
    this.editor = window.jsWireMonacoEditor;    
    if (!this.editor) return;

    // El elemento de referencia para este editor (puede ser útil para futuras mejoras específicas por editor)
    this.element = document.querySelector("[data-gasreference='" + this.options.referenceId + "']");
    
    console.log("[GASTools] Initializing Editor Instance");

    // Aplicar opciones del editor (minimap, wordWrap, etc.)
    this.applySettings(this.options.settings || {});

    // Registrar snippets como completion provider
    await this.reloadSnippets();

    // Aplicar tema activo
    await this.reloadTheme();

    // Obtenemos el mapa de archivos
    this._fileNameObjectMap = new Map();

    // Construimos el mapa de archivos
    this._buildUriToNameMap();

    // Habilitamos el campo de busqueda en archivos avanzado
    this._enableAdvancedSearch();
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
      const parts    = rawPath.split('/').filter(Boolean);
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
   */
  _enableAdvancedSearch() {
    const _this = this;
    console.log("[GASTools] Enabling advanced search UI...");
    console.log("[GASTools] Targeting tools menu element:", this._toolsMenuElement);

    // Si no encontramos el contenedor principal de GAS, abortamos
    if (!this._toolsMenuElement) return;

    // Evitar duplicados: usamos DomUtils para verificar si ya inyectamos nuestra opción
    if (document.getElementById("buttonAdvancedSearch")) return;

    // 1. Limpieza de elementos antiguos (si existieran por un re-init)
    this.DomUtils.remove("buttonAdvancedSearch");
    this.DomUtils.remove("ctnCurrentFileName");

    // 2. Creación del nuevo elemento
    const option = document.createElement('div');
    option.className = "yggLIc";
    option.id = "buttonAdvancedSearch";

    // 3. Inserción segura de HTML usando la política centralizada en DomUtils
    // Nota: Pasamos el HTML que viene en options.searchButton
    this.DomUtils.setHTML(option, this.options.searchButton);

    // 4. Inyectar en el DOM de GAS
    this._toolsMenuElement.appendChild(option);

    // 1. Inyectar el Web Component en el body si no existe
    if (!document.querySelector('gas-search-panel')) {
      this._searchPanel = document.createElement('gas-search-panel');
      document.body.appendChild(this._searchPanel);
    } else {
      this._searchPanel = document.querySelector('gas-search-panel');
    }

    // Enlazamos la instancia del editor en el componente para permitir "goto line".
    this._searchPanel.setEditor(this.editor);

    // 2. Escuchar el clic en el botón recién creado usando DomUtils
    this.DomUtils.delegate(this._toolsMenuElement, 'click', '#rsBtnSearchGas', (e) => {
      e.preventDefault();
      console.log("[GASTools] Advanced Search button clicked");
      console.log(this._searchPanel);

      // Obtenemos las lista actualizada del mapa de archivos
      this._buildUriToNameMap();
      console.log(this._fileNameObjectMap);
      // habilitamos la función para obtener nombre
      this._searchPanel._formatModelName = _this._formatModelName;

      // Estblecemos la lista actualizada de archivo
      this._searchPanel.setFileNameObjectMap(_this._fileNameObjectMap);

      // mostramos el panel
      this._searchPanel.toggle(
        e.target.closest('#rsBtnSearchGas'),
        this._fileNameObjectMap
      );
    });

    // Atajo global solicitado: Alt + Shift + F.
    if (!this._searchShortcutBound) {
      this._searchShortcutBound = true;
      document.addEventListener('keydown', (evt) => {
        const isF = (evt.key || '').toLowerCase() === 'f';
        const requestedShortcut = isF && evt.altKey && evt.shiftKey;
        if (!requestedShortcut) return;

        evt.preventDefault();
        evt.stopPropagation();
        const anchorBtn = document.querySelector('#rsBtnSearchGas');
        this._searchPanel?.toggle(anchorBtn);
      }, true);
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
      'showMinimap':           (val) => this.editor.updateOptions({ minimap: { enabled: val } }),
      'wordWrap':              (val) => this.editor.updateOptions({ wordWrap: val ? 'on' : 'off' }),
      'bracketPairs':          (val) => this.editor.updateOptions({ bracketPairColorization: { enabled: val } }),
      'smoothScrolling':       (val) => this.editor.updateOptions({ smoothScrolling: val }),
      'tabCompletion':         (val) => this.editor.updateOptions({ tabCompletion: val ? 'on' : 'off' }),
      'scrollBeyondLastLine':  (val) => this.editor.updateOptions({ scrollBeyondLastLine: val }),
      'peekWidget':            (val) => this.editor.updateOptions({ definitionLinkOpensInPeek: val }),
      'formatOnSave':          (val) => {
        this._formatOnSave = val;
      },
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
      // Actualizar siempre la variable global compartida
      G_SHARED_SNIPPETS = this.options.snippets || [];
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
        { id: 'javascript', types: ['javascript', 'typescript', 'js', 'google apps script'] }
      ];

      langGroups.forEach(group => {
        monaco.languages.registerCompletionItemProvider(group.id, {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber:   position.lineNumber,
              startColumn:      word.startColumn,
              endColumn:        word.endColumn,
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
      label:           snip.prefix,
      kind:            monaco.languages.CompletionItemKind.Snippet,
      documentation:   snip.title,
      detail:          `[${snip.lang}] ${snip.title}`,
      insertText:      snip.code,
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
    monaco.editor.setTheme = function(requestedTheme) {
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
      token:      rule.token,
      foreground: this._normalizeColor(rule.foreground).replace('#', ''),
      fontStyle:  rule.fontStyle !== 'normal' ? rule.fontStyle : undefined,
    })).filter(r => r.token);

    return {
      base:    data.base || 'vs-dark',
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
    console.log("[GASTools] Disabling extension...");

    // 1. Restaurar control de temas a GAS
    this._releaseThemeControl();

    // 2. Vaciar snippets (el provider sigue registrado, pero devuelve [])
    G_SHARED_SNIPPETS = [];

    // 3. Revertir settings del editor a defaults de Monaco/GAS
    this._resetEditorDefaults();

    // Limpiar UI inyectada
    DomUtils.remove("sltRubThemeList");
    DomUtils.remove("ctnCurrentFileName");

    console.log("[GASTools] Extension disabled and UI cleaned.");
  }

  /**
   * Reactiva todas las mejoras con los settings guardados.
   */
  enable() {
    console.log("[GASTools] Re-enabling extension...");

    // 1. Re-aplicar settings guardados
    this.applySettings(this.options.settings || {});

    // 2. Re-cargar snippets
    G_SHARED_SNIPPETS = this.options.snippets || [];

    // 3. Re-aplicar tema
    this.reloadTheme();

    console.log("[GASTools] Extension re-enabled.");
  }

  /**
   * Libera el control del tema: restaura monaco.editor.setTheme original
   * y aplica el tema por defecto de GAS.
   * @private
   */
  _releaseThemeControl() {
    if (!this._themePatched || !this._originalSetTheme) return;

    // Restaurar la función original
    monaco.editor.setTheme = this._originalSetTheme;
    this._themePatched = false;
    this._activeThemeName = null;

    // Dejar que GAS tome el control aplicando su tema por defecto
    monaco.editor.setTheme('vs-dark');
    console.log("[GASTools] Theme control released, restored to vs-dark.");
  }

  /**
   * Revierte las opciones del editor a los valores por defecto de GAS.
   * @private
   */
  _resetEditorDefaults() {
    if (!this.editor) return;
    try {
      this.editor.updateOptions({
        minimap:                 { enabled: true },
        wordWrap:                'off',
        bracketPairColorization: { enabled: false },
        smoothScrolling:         false,
        tabCompletion:           'off',
        scrollBeyondLastLine:    true,
        definitionLinkOpensInPeek: false,
      });
    } catch (err) {
      console.warn("[GASTools] Error resetting defaults:", err);
    }
  }
}