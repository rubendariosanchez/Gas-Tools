"use strict";

// Clave usada para identificar las propiedades de la extensión en storage
const STORAGE_KEY = 'gasToolsNewProperties';
// Selector del contenedor raíz del editor de Google Apps Script
const EDITOR_SELECTOR = '#yDmH0d';

// ─────────────────────────────────────────────
// CARGA DE RECURSOS
// ─────────────────────────────────────────────

/**
 * Descarga en paralelo los fragmentos HTML de los botones de UI
 * que serán inyectados en el editor.
 *
 * @async
 * @returns {Promise<Object>} Objeto con las claves `searchButton` y `chatButton`
 *                            conteniendo el HTML de cada botón como string.
 */
async function loadResources() {
  // Rutas relativas a la raíz de la extensión para cada fragmento HTML
  const urls = {
    searchButton: 'extension/html/searchButton.html',
    chatButton: 'extension/html/chatButton.html',
  };

  // Descarga todos los archivos en paralelo y reconstruye el objeto con sus contenidos
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, path]) => {
      const res = await fetch(chrome.runtime.getURL(path));
      return [key, await res.text()];
    })
  );

  return Object.fromEntries(entries);
}

/**
 * Inyecta los scripts de la extensión en el contexto MAIN de la página
 * respetando el orden de dependencias mediante `async = false`.
 * Es necesario inyectarlos en MAIN porque Monaco Editor solo es accesible
 * desde ese contexto; los content scripts corren en un contexto aislado.
 *
 * @returns {Promise<void>} Se resuelve cuando todos los scripts han cargado.
 */
function injectScripts() {
  // Orden crítico: domUtils debe estar disponible antes que los demás módulos
  const scriptPaths = [
    'extension/js/domUtils.js',
    'extension/js/gas-ai-autocomplete.js',
    'extension/js/gasTools.js',
    'extension/js/components/gas-search-panel.js',
    'extension/js/components/gas-chat-panel.js',
    'extension/js/components/gas-file-tree-panel.js',
  ];

  const loadPromises = scriptPaths.map(path => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = chrome.runtime.getURL(path);
    // async=false asegura ejecución en el orden del array a pesar de la carga paralela
    el.async = false;
    // Limpia el tag del DOM tras la carga para no ensuciar el <head>
    el.addEventListener('load', () => { el.remove(); resolve(); }, { once: true });
    el.addEventListener('error', (e) => { el.remove(); reject(e); }, { once: true });
    (document.head || document.documentElement).appendChild(el);
  }));

  return Promise.all(loadPromises);
}

// ─────────────────────────────────────────────
// OBTENCIÓN DE DATOS
// ─────────────────────────────────────────────

/**
 * Envía un mensaje al background y devuelve una promesa con la respuesta.
 * Centraliza el patrón repetido de sendMessage + lastError para evitar duplicación.
 *
 * @param {Object} message - Mensaje a enviar al background script.
 * @param {*}      fallback - Valor a resolver si la respuesta es nula.
 * @returns {Promise<*>} Respuesta del background o el valor fallback.
 */
function _sendMessage(message, fallback) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(response ?? fallback);
    });
  });
}

/**
 * Solicita la configuración de toggles guardada al background.
 *
 * @async
 * @returns {Promise<Object>} Objeto con las opciones del usuario, o `{}` si no hay datos.
 */
async function getSavedSettings() {
  return _sendMessage({ type: 'GET_SETTINGS' }, {});
}

/**
 * Solicita el tema activo (colores y reglas) al background.
 *
 * @async
 * @returns {Promise<Object|null>} Objeto del tema activo, o `null` si no hay ninguno.
 */
async function getSavedTheme() {
  return _sendMessage({ type: 'GET_ACTIVE_THEME' }, null);
}

/**
 * Solicita todos los snippets personalizados y predeterminados al background.
 *
 * @async
 * @returns {Promise<Array>} Lista de snippets disponibles, o `[]` si no hay ninguno.
 */
async function getSavedSnippets() {
  return _sendMessage({ type: 'GET_SNIPPETS' }, []);
}

// ─────────────────────────────────────────────
// OBSERVADOR DE EDITORES
// ─────────────────────────────────────────────

/**
 * Observa el DOM para detectar nuevas instancias de Monaco Editor
 * y despacha el payload de inicialización a cada una mediante un CustomEvent.
 * Cada editor recibe un `referenceId` único para evitar inicializaciones duplicadas.
 *
 * @param {Object} payload - Datos de inicialización a transferir a cada editor.
 */
function watchForEditors(payload) {
  const target = document.querySelector(EDITOR_SELECTOR);

  // Si el contenedor raíz no existe, no hay nada que observar
  if (!target) {
    console.warn('[GASTools] Contenedor principal no encontrado:', EDITOR_SELECTOR);
    return;
  }

  /**
   * Despacha el payload de inicialización a un editor Monaco específico.
   * El atributo `data-gasreference` actúa como marca para evitar doble despacho.
   *
   * @param {Element} el - Elemento del editor Monaco a inicializar.
   */
  const dispatchEditorData_ = (el) => {
    // Omite el elemento si es inválido o ya fue inicializado anteriormente
    if (!el || el.dataset.gasreference) return;
    // Asigna un ID único al editor para rastrearlo durante su ciclo de vida
    el.dataset.gasreference = crypto.randomUUID();
    document.dispatchEvent(new CustomEvent('GAS_TransferData', {
      detail: JSON.stringify({ ...payload, referenceId: el.dataset.gasreference }),
    }));
  };

  // Inicializa los editores que ya existen en el DOM al momento de ejecutarse
  document.querySelectorAll('.monaco-editor').forEach(dispatchEditorData_);

  // Observa cambios en el DOM para capturar editores que se monten después
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {

      // Detecta cuando un elemento existente recibe la clase 'monaco-editor'
      if (mutation.type === 'attributes') {
        const el = mutation.target;
        if (mutation.attributeName === 'class' && el.classList?.contains('monaco-editor')) {
          dispatchEditorData_(el);
        }
        continue;
      }

      // Detecta nuevos nodos añadidos al DOM que sean o contengan editores Monaco
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof Element)) return;
          // Verifica si el nodo raíz es directamente un editor
          if (node.matches('.monaco-editor')) dispatchEditorData_(node);
          // Busca editores anidados dentro del nodo añadido
          node.querySelectorAll?.('.monaco-editor').forEach(dispatchEditorData_);
        });
      }
    }
  });

  observer.observe(target, {
    attributes: true,
    // Solo reacciona a cambios en el atributo 'class' para evitar trabajo innecesario
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

/**
 * Punto de entrada del content script.
 * Carga en paralelo todos los datos necesarios, inyecta los scripts en MAIN
 * y arranca la observación de editores Monaco.
 * Si la extensión está desactivada globalmente, notifica a gasTools.js y aborta.
 *
 * @async
 * @returns {Promise<void>}
 */
async function init() {
  try {
    // Carga en paralelo para minimizar el tiempo de espera antes de la inyección
    const [settings, snippets, activeTheme, resources] = await Promise.all([
      getSavedSettings(),
      getSavedSnippets(),
      getSavedTheme(),
      loadResources(),
    ]);

    // Si el usuario desactivó la extensión, notifica al mundo MAIN y no continúa
    if (settings['global-enable'] === false) {
      console.log('[GASTools] Extensión desactivada globalmente.');
      document.dispatchEvent(new CustomEvent('GAS_GlobalDisable'));
      return;
    }

    // Los scripts deben estar completamente cargados antes de despachar cualquier evento
    await injectScripts();

    // Inicia la observación y pasa todos los datos necesarios para los editores
    watchForEditors({
      searchButton: resources.searchButton,
      chatButton: resources.chatButton,
      // URL base de la carpeta de temas para que MAIN pueda construir rutas absolutas
      themeUrl: chrome.runtime.getURL('themes'),
      settings,
      snippets,
      activeTheme,
    });
  } catch (err) {
    console.error('[GASTools] Error en init:', err);
  }
}

// ─────────────────────────────────────────────
// ACTUALIZACIONES EN TIEMPO REAL (popup → página)
// ─────────────────────────────────────────────

/**
 * Puente entre el background y los scripts inyectados en MAIN.
 * Recibe los cambios guardados desde el popup vía `SETTINGS_UPDATED`
 * y los redespacha como CustomEvents, ya que el mundo MAIN no tiene
 * acceso a `chrome.runtime`.
 *
 * @listens chrome.runtime.onMessage
 */
chrome.runtime.onMessage.addListener(async (msg) => {
  // Ignora cualquier mensaje que no sea una notificación de actualización
  if (msg.type !== 'SETTINGS_UPDATED') return;

  const { options, data, updateType } = msg.payload;
  console.log('[MainFunctions] Actualización recibida:', updateType);

  // Propaga los nuevos valores de los toggles al mundo MAIN
  if (updateType === 'settings') {
    console.log('[MainFunctions] GAS_SettingsUpdated recibido:', options);

    // Si se habilita la extensión y los scripts no están inyectados, re-inicializar
    if (options['global-enable'] === true && !document.querySelector('script[src*="gasTools.js"]')) {
      console.log('[MainFunctions] Re-inicializando extensión...');
      // Limpiar referencias de editores para forzar re-inicialización
      document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
        delete el.dataset.gasreference;
      });

      // Resetear el flag de disabled para que gasTools.js acepte la inicialización
      document.dispatchEvent(new CustomEvent('GAS_GlobalEnable'));

      // Iniciamos la extensión
      await init();
      // return;
    }

    // Enviamos al cliente la actualización de settings
    document.dispatchEvent(new CustomEvent('GAS_SettingsUpdated', {
      detail: JSON.stringify(options),
    }));
    console.log('[MainFunctions] GAS_SettingsUpdated despachado');
  }

  // Usa los snippets del payload si vienen incluidos; si no, los solicita frescos al background
  if (updateType === 'snippets') {
    const newSnippets = data || await getSavedSnippets();
    console.log('[MainFunctions] Enviando snippets:', newSnippets.length);
    document.dispatchEvent(new CustomEvent('GAS_DataUpdated', {
      detail: JSON.stringify({ updateType: 'snippets', data: newSnippets }),
    }));
  }

  // Usa el tema del payload si viene incluido; si no, lo solicita fresco al background
  if (updateType === 'themes') {
    const newTheme = data || await getSavedTheme();
    console.log('[MainFunctions] Enviando tema:', newTheme?.text);
    document.dispatchEvent(new CustomEvent('GAS_DataUpdated', {
      detail: JSON.stringify({ updateType: 'themes', data: newTheme }),
    }));
  }
});

// ─────────────────────────────────────────────
// BRIDGE LLM (MAIN ↔ background)
// El panel <gas-chat-panel> no tiene acceso a chrome.runtime,
// por lo que este content script actúa como intermediario.
// ─────────────────────────────────────────────

/**
 * Envía un mensaje al background de forma segura, manejando el caso en que
 * el contexto de la extensión haya sido invalidado por una recarga o actualización.
 *
 * @param {Object}        msg      - Mensaje a enviar al background.
 * @param {Function|null} callback - Función a invocar con la respuesta, o `null` si no se necesita.
 */
function _safeSendMessage(msg, callback) {
  console.log('[GAS-Tools] Enviando mensaje al background:', msg.type);
  try {
    chrome.runtime.sendMessage(msg, (response) => {
      // Si el service worker fue recargado, el contexto queda inválido; se notifica al usuario
      if (chrome.runtime.lastError?.message?.includes('Extension context invalidated')) {
        console.warn('[GAS-Tools] Contexto invalidado. Recarga la página.');
        callback?.(null);
        return;
      }
      callback?.(response);
    });
  } catch (err) {
    // Captura errores síncronos al llamar sendMessage (p. ej. extensión desinstalada)
    console.error('[GAS-Tools] Error enviando mensaje al background:', err);
    callback?.(null);
  }
}

/**
 * Recibe una solicitud de chat LLM desde el mundo MAIN,
 * la retransmite al background y devuelve la respuesta del modelo
 * vía el evento `GAS_LLM_RESPONSE`.
 *
 * @listens document#GAS_LLM_REQUEST
 */
document.addEventListener('GAS_LLM_REQUEST', (e) => {
  let payload;
  // Descarta el evento si el detalle no es JSON válido
  try { payload = JSON.parse(e.detail); } catch (_) { return; }

  // Separa el requestId del resto del payload para poder correlacionar la respuesta
  const { requestId, ...rest } = payload || {};
  console.log('[MainFunctions] GAS_LLM_REQUEST recibido:', payload);
  _safeSendMessage({ type: 'LLM_CHAT_REQUEST', payload: rest }, (response) => {
    const ok = response?.ok;
    document.dispatchEvent(new CustomEvent('GAS_LLM_RESPONSE', {
      detail: JSON.stringify({
        requestId,
        ok,
        // En éxito devuelve el contenido; en error lo omite para evitar confusión
        content: ok ? (response?.content || '') : null,
        error: ok ? null : (response?.error || 'Unknown error'),
      }),
    }));
  });
});

/**
 * Solicita la configuración LLM al background y la devuelve al mundo MAIN
 * vía el evento `GAS_LLM_CONFIG_RESULT`.
 *
 * @listens document#GAS_LLM_GET_CONFIG
 */
document.addEventListener('GAS_LLM_GET_CONFIG', (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { payload = {}; }
  const { requestId } = payload || {};

  _safeSendMessage({ type: 'LLM_GET_CONFIG' }, (data) => {
    document.dispatchEvent(new CustomEvent('GAS_LLM_CONFIG_RESULT', {
      detail: JSON.stringify({ requestId, data: data || null }),
    }));
  });
});

/**
 * Persiste la configuración LLM en el background (fire-and-forget).
 * No espera respuesta ya que el guardado es transparente para el usuario.
 *
 * @listens document#GAS_LLM_SAVE_CONFIG
 */
document.addEventListener('GAS_LLM_SAVE_CONFIG', (e) => {
  let payload;
  // Descarta el evento si el detalle no es JSON válido
  try { payload = JSON.parse(e.detail); } catch (_) { return; }
  console.log('[MainFunctions] GAS_LLM_SAVE_CONFIG recibido:', payload);
  _safeSendMessage({ type: 'LLM_SAVE_CONFIG', payload });
});

/**
 * Solicita el contexto global de IA al background y lo devuelve al mundo MAIN
 * vía el evento `GAS_LLM_CONFIG_RESULT`.
 * Comparte el mismo canal de respuesta que `GAS_LLM_GET_CONFIG` para simplificar
 * el receptor en MAIN.
 *
 * @listens document#GAS_LLM_GET_GLOBAL_AI_CONTEXT
 */
document.addEventListener('GAS_LLM_GET_GLOBAL_AI_CONTEXT', (e) => {
  let payload;
  try { payload = JSON.parse(e.detail); } catch (_) { payload = {}; }
  const { requestId } = payload || {};

  _safeSendMessage({ type: 'GET_GLOBAL_AI_CONTEXT' }, (data) => {
    document.dispatchEvent(new CustomEvent('GAS_LLM_CONFIG_RESULT', {
      detail: JSON.stringify({ requestId, data: data || null }),
    }));
  });
});

// Arranca el content script una vez que el módulo ha sido evaluado por el navegador
init();