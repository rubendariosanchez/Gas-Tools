"use strict";

const STORAGE_KEY = 'gasToolsNewProperties';
const EDITOR_SELECTOR = '#yDmH0d';

// ─────────────────────────────────────────────
// RESOURCE LOADING
// ─────────────────────────────────────────────

/**
 * Carga los recursos estáticos necesarios en paralelo.
 * @returns {Promise<Object>}
 */
async function loadResources() {

  // Definimos las URLs de los recursos a cargar
  const urls = {
    searchButton: 'extension/html/searchButton.html',
  };

  // Cargamos todos los recursos en paralelo y los retornamos como un objeto
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, path]) => {
      const res = await fetch(chrome.runtime.getURL(path));
      return [key, await res.text()];
    })
  );

  return Object.fromEntries(entries);
}

/**
 * Inyecta los scripts de la extensión en el contexto MAIN de la página.
 */
function injectScripts() {
  // Lista de scripts a inyectar (puede ser ampliada fácilmente)
  const scriptPaths = ['extension/js/domUtils.js', 'extension/js/gasTools.js'];

  // Inyectar cada script y eliminarlo una vez cargado para mantener el DOM limpio
  scriptPaths.forEach(path => {
    const el = document.createElement('script');
    el.src = chrome.runtime.getURL(path);
    (document.head || document.documentElement).appendChild(el);
    el.addEventListener('load', () => el.remove(), { once: true });
  });
}

// ─────────────────────────────────────────────
// DATA FETCHING
// ─────────────────────────────────────────────

/**
 * Obtiene la configuración guardada desde el background script.
 * @returns {Promise<Object>}
 */
async function getSavedSettings() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, response => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response ?? {});
    });
  });
}

/**
 * Obtiene el tema activo completo desde el background script.
 * @returns {Promise<Object|null>}
 */
async function getSavedTheme() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_ACTIVE_THEME' }, response => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response ?? null);
    });
  });
}

/**
 * Obtiene todos los snippets personalizados desde el background script.
 * @returns {Promise<Array>}
 */
async function getSavedSnippets() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_SNIPPETS' }, response => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response ?? []);
    });
  });
}

// ─────────────────────────────────────────────
// EDITOR OBSERVER
// ─────────────────────────────────────────────

/**
 * Observa el DOM esperando instancias nuevas de Monaco Editor
 * y despacha los datos necesarios para inicializarlas.
 * @param {Object} payload — datos base a enviar con cada editor nuevo
 */
function watchForEditors(payload) {
  const target = document.querySelector(EDITOR_SELECTOR);
  if (!target) {
    console.warn('[GASTools] Contenedor principal no encontrado:', EDITOR_SELECTOR);
    return;
  }

  // Cada vez que se detecta un nuevo editor, se le envía un CustomEvent con el payload completo
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      const el = mutation.target;

      if (
        mutation.attributeName === 'class' &&
        el.classList.contains('monaco-editor') &&
        !el.dataset.gasreference
      ) {
        const referenceId = crypto.randomUUID();
        el.dataset.gasreference = referenceId;

        // Enviamos un CustomEvent con el payload completo + un ID de referencia único para este editor
        document.dispatchEvent(new CustomEvent('GAS_TransferData', {
          detail: JSON.stringify({ ...payload, referenceId }),
        }));
      }
    }
  });

  observer.observe(target, {
    attributes: true,
    childList: true,
    subtree: true,
  });
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

/**
 * Punto de entrada principal.
 * Carga configuración, snippets y tema en paralelo antes de arrancar.
 */
async function init() {
  try {
    // Carga en paralelo lo que no depende de otro
    const [settings, snippets, activeTheme, resources] = await Promise.all([
      getSavedSettings(),
      getSavedSnippets(),
      getSavedTheme(),
      loadResources(),
    ]);

    console.log("[GASTools] Init — settings:", settings);
    console.log("[GASTools] Init — snippets count:", snippets.length);
    console.log("[GASTools] Init — active theme:", activeTheme?.value);

    // Si el toggle global está desactivado, no hacemos nada
    if (settings['global-enable'] === false) {
      console.log("[GASTools] Extension is globally disabled.");
      return;
    }

    // Inyectar estilos
    const styleEl = document.createElement('style');
    styleEl.textContent = resources.styles;
    document.head.appendChild(styleEl);

    // Inyectar scripts (gasTools.js, library.js, etc.)
    injectScripts();

    // Payload completo que recibirá cada nueva instancia de GasCustomEditor
    const payload_ = {
      // Recursos HTML para los paneles de UI
      searchButton:  resources.searchButton,
      // URL base para cargar archivos JSON de temas del sistema
      themeUrl:      chrome.runtime.getURL('themes'),
      // Datos iniciales listos para ser usados sin mensajes adicionales
      settings,
      snippets,
      activeTheme,
    };

    // Observar el DOM para inicializar cada nuevo editor con el payload
    watchForEditors(payload_);

  } catch (err) {
    console.error('[GASTools] Error en init:', err);
  }
}

// ─────────────────────────────────────────────
// LISTENER DE ACTUALIZACIONES EN TIEMPO REAL
// ─────────────────────────────────────────────

/**
 * Escucha actualizaciones enviadas desde el background cuando el popup
 * guarda cambios en settings, snippets o themes, y los redispacha como
 * CustomEvents al script inyectado (world: MAIN).
 *
 * El script inyectado NO tiene acceso a chrome.runtime, por lo que
 * este content script actúa como puente.
 */
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== 'SETTINGS_UPDATED') return;

  const { options, updateType } = msg.payload;

  // 1. Caso: Cambio en configuración (toggles)
  if (updateType === 'settings') {
    document.dispatchEvent(new CustomEvent('GAS_SettingsUpdated', {
      detail: JSON.stringify(options)
    }));
  }

  // 2. Caso: Cambio en Snippets
  if (updateType === 'snippets') {
    const newSnippets = await getSavedSnippets(); // Pedir al background
    document.dispatchEvent(new CustomEvent('GAS_DataUpdated', {
      detail: JSON.stringify({ 
        updateType: 'snippets', 
        data: newSnippets 
      })
    }));
  }

  // 3. Caso: Cambio en Temas
  if (updateType === 'themes') {
    const newTheme = await getSavedTheme(); // Pedir al background
    document.dispatchEvent(new CustomEvent('GAS_DataUpdated', {
      detail: JSON.stringify({ 
        updateType: 'themes', 
        data: newTheme 
      })
    }));
  }
});

// Arrancar la extensión
init();