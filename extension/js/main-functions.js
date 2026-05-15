"use strict";

// ─────────────────────────────────────────────
// CONSTANTES DE EVENTOS (compartidas con gas-tools.js vía CustomEvent)
// Los valores string deben coincidir exactamente con los usados en el mundo MAIN.
// ─────────────────────────────────────────────

const GAS_EVENTS = {
  TRANSFER_DATA:    'GAS_TransferData',
  SETTINGS_UPDATED: 'GAS_SettingsUpdated',
  DATA_UPDATED:     'GAS_DataUpdated',
  GLOBAL_DISABLE:   'GAS_GlobalDisable',
  GLOBAL_ENABLE:    'GAS_GlobalEnable',
  LLM_REQUEST:      'GAS_LLM_REQUEST',
  LLM_RESPONSE:     'GAS_LLM_RESPONSE',
  LLM_GET_CONFIG:    'GAS_LLM_GET_CONFIG',
  LLM_CONFIG_RESULT: 'GAS_LLM_CONFIG_RESULT',
  LLM_GET_GLOBAL_AI_CONTEXT: 'GAS_LLM_GET_GLOBAL_AI_CONTEXT',
  LLM_SAVE_CONFIG:  'GAS_LLM_SAVE_CONFIG',
};

/**
 * Despacha un CustomEvent con serialización JSON centralizada.
 * Todas las capas deben pasar por aquí para garantizar consistencia.
 * @param {string} eventName - Nombre del evento (usar GAS_EVENTS.*).
 * @param {Object} detail    - Payload (se serializa con JSON.stringify automáticamente).
 * @param {boolean} [useWindow=false] - Si true, usa window en lugar de document.
 */
function dispatchGAS(eventName, detail, useWindow = false) {
  const target = useWindow ? window : document;
  target.dispatchEvent(new CustomEvent(eventName, {
    detail: JSON.stringify(detail),
  }));
}

// ─────────────────────────────────────────────
// DETECCIÓN DE NAVEGACIÓN SPA POR URL
// ─────────────────────────────────────────────

/**
 * Monitorea location.pathname para detectar navegación SPA dentro del IDE.
 * Google Apps Script no emite eventos popstate, por lo que usamos polling.
 * @param {Object} callbacks - { onProjectChange(scriptKey), onLeave() }
 * @returns {Function} stop() para detener el polling.
 */
function createNavigationDetector(callbacks) {
  let lastPath = document.location.pathname;
  let lastKey  = null;
  let interval = null;

  // Arranca tras 1.5s para dejar que la SPA se estabilice al cargar
  const delayId = setTimeout(() => {
    interval = setInterval(() => {
      const path  = document.location.pathname;
      const match = path.match(/\/([^/]+?)\/edit/);
      const key   = match ? match[1] : null;

      // Ignorar si sigue siendo la misma ruta o si aún no hay key (landing / spash)
      if (path === lastPath) return;
      lastPath = path;

      if (key && key !== lastKey) {
        lastKey = key;
        callbacks.onProjectChange?.(key);
      } else if (!key && lastKey) {
        lastKey = null;
        callbacks.onLeave?.();
      }
    }, 300);
  }, 1500);

  return function stop() {
    clearTimeout(delayId);
    if (interval) { clearInterval(interval); interval = null; }
  };
}

// ─────────────────────────────────────────────
// CARGA DE RECURSOS
// ─────────────────────────────────────────────

async function loadResources() {
  const urls = {
    searchButton: 'extension/html/searchButton.html',
    chatButton:   'extension/html/chatButton.html',
  };
  const entries = await Promise.all(
    Object.entries(urls).map(async ([key, path]) => {
      const res = await fetch(chrome.runtime.getURL(path));
      return [key, await res.text()];
    })
  );
  return Object.fromEntries(entries);
}

/**
 * Inyecta los scripts en MAIN de forma SECUENCIAL y garantizada.
 * Usamos async=false para orden de ejecución en el DOM, pero esperamos
 * cada script individualmente antes de insertar el siguiente.
 */
async function injectScripts() {
  const scriptPaths = [
    'extension/js/services/dom-utils.js',
    'extension/js/services/gas-ai-autocomplete.js',
    'extension/js/services/gas-folders.js',
    'extension/js/components/gas-search-panel.js',
    'extension/js/components/gas-chat-panel.js',
    'extension/js/gas-tools.js',
  ];

  // Inyección secuencial: cada script espera al anterior antes de insertarse.
  // Esto garantiza el orden de dependencias sin depender de async=false.
  for (const path of scriptPaths) {
    await new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = chrome.runtime.getURL(path);
      el.addEventListener('load',  () => { el.remove(); resolve(); }, { once: true });
      el.addEventListener('error', (e) => { el.remove(); reject(e);  }, { once: true });
      (document.head || document.documentElement).appendChild(el);
    });
  }
}

// ─────────────────────────────────────────────
// COMUNICACIÓN CON BACKGROUND
// ─────────────────────────────────────────────

/**
 * Envía un mensaje al background de forma segura.
 * Unifica _sendMessage y _safeSendMessage en una sola función.
 *
 * @param {Object} message  - Mensaje a enviar.
 * @param {*}     [fallback] - Valor a retornar si la respuesta es nula.
 * @returns {Promise<*>}
 */
function sendToBackground(message, fallback = null) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || '';
          if (msg.includes('Extension context invalidated')) {
            console.warn('[GASTools] Contexto invalidado. Recarga la página.');
          } else {
            console.warn('[GASTools] Error en sendMessage:', msg);
          }
          resolve(fallback);
          return;
        }
        resolve(response ?? fallback);
      });
    } catch (err) {
      console.error('[GASTools] Error enviando mensaje al background:', err);
      resolve(fallback);
    }
  });
}

const getSavedSettings = () => sendToBackground({ type: 'GET_SETTINGS'    }, {});
const getSavedTheme    = () => sendToBackground({ type: 'GET_ACTIVE_THEME' }, null);
const getSavedSnippets = () => sendToBackground({ type: 'GET_SNIPPETS'     }, []);

// ─────────────────────────────────────────────
// OBSERVADOR DE EDITORES
// ─────────────────────────────────────────────

function watchForEditors(payload) {
  let _editorsWerePresent = false;

  const dispatchEditorData = (el) => {
    if (!el || el.dataset.gasreference) return;
    el.dataset.gasreference = crypto.randomUUID();
    dispatchGAS(GAS_EVENTS.TRANSFER_DATA, {
      ...payload,
      referenceId: el.dataset.gasreference,
    });
  };

  const clearAllReferences = () => {
    document.querySelectorAll('.monaco-editor').forEach(el => {
      delete el.dataset.gasreference;
    });
  };

  // Inicializa editores ya presentes
  document.querySelectorAll('.monaco-editor').forEach(dispatchEditorData);
  _editorsWerePresent = document.querySelectorAll('.monaco-editor').length > 0;

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const el = mutation.target;
        if (mutation.attributeName === 'class' && el.classList?.contains('monaco-editor')) {
          dispatchEditorData(el);
        }
        continue;
      }
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof Element)) return;
          if (node.matches('.monaco-editor')) dispatchEditorData(node);
          node.querySelectorAll?.('.monaco-editor').forEach(dispatchEditorData);
        });
      }
    }
  });

  observer.observe(document.body, {
    attributes:      true,
    attributeFilter: ['class'],
    childList:       true,
    subtree:         true,
  });

  setInterval(() => {
    const editors = document.querySelectorAll('.monaco-editor');
    const present = editors.length > 0;

    if (!present && _editorsWerePresent) {
      console.log('[GASTools] Navegación saliente detectada');
    }
    if (present && !_editorsWerePresent) {
      console.log('[GASTools] Editores reaparecieron, re-inicializando');
      clearAllReferences();
    }

    _editorsWerePresent = present;
    editors.forEach(dispatchEditorData);
  }, 1500);
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

async function init() {
  try {
    const [settings, snippets, activeTheme, resources] = await Promise.all([
      getSavedSettings(),
      getSavedSnippets(),
      getSavedTheme(),
      loadResources(),
    ]);

    if (settings['global-enable'] === false) {
      console.log('[GASTools] Extensión desactivada globalmente.');
      dispatchGAS(GAS_EVENTS.GLOBAL_DISABLE);
      return;
    }

    await injectScripts();

    // Monitoreo de navegación SPA por cambio de URL
    // Cuando cambia de proyecto, reinicializa todo
    createNavigationDetector({
      onProjectChange(scriptKey) {
        console.log('[GASTools] Cambio de proyecto detectado:', scriptKey);
        // Limpiar referencias previas para forzar que el observer/intervalo
        // de watchForEditors (ya corriendo) vuelva a detectarlos
        document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
          delete el.dataset.gasreference;
        });
      },
    });

    watchForEditors({
      searchButton: resources.searchButton,
      chatButton:   resources.chatButton,
      themeUrl:     chrome.runtime.getURL('themes'),
      settings,
      snippets,
      activeTheme,
    });

  } catch (err) {
    console.error('[GASTools] Error en init:', err);
  }
}

// ─────────────────────────────────────────────
// ACTUALIZACIONES EN TIEMPO REAL
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== 'SETTINGS_UPDATED') return;

  const { options, data, updateType } = msg.payload;
  console.log('[GASTools] Actualización recibida:', updateType);

  // Se valida si es una actualización de configuración
  if (updateType === 'settings') {
    // Si se reactiva la extensión y los scripts no están cargados, re-inicializar
    if (options['global-enable'] === true && !document.querySelector('script[src*="gas-tools.js"]')) {
      console.log('[GASTools] Re-inicializando...');
      document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
        delete el.dataset.gasreference;
      });
      dispatchGAS(GAS_EVENTS.GLOBAL_ENABLE);
      await init();
    }
    dispatchGAS(GAS_EVENTS.SETTINGS_UPDATED, options);
  }

  // Se valida si es una actualización de snippets
  if (updateType === 'snippets') {
    const newSnippets = data || await getSavedSnippets();
    dispatchGAS(GAS_EVENTS.DATA_UPDATED, { updateType: 'snippets', data: newSnippets });
  }

  // Se valida si es una actualización de temas
  if (updateType === 'themes') {
    const newTheme = data || await getSavedTheme();
    dispatchGAS(GAS_EVENTS.DATA_UPDATED, { updateType: 'themes', data: newTheme });
  }
});

// ─────────────────────────────────────────────
// BRIDGE LLM — tabla de despacho unificada
// Todos los eventos LLM del mundo MAIN siguen el mismo patrón:
// escuchar evento → parsear detail → enviar al background → despachar respuesta.
// La tabla evita repetir el mismo try/catch y sendToBackground 4 veces.
// ─────────────────────────────────────────────

const G_LLM_BRIDGE = [
  {
    listenEvent:   GAS_EVENTS.LLM_REQUEST,
    responseEvent: GAS_EVENTS.LLM_RESPONSE,
    buildMessage: ({ requestId, ...rest }) => ({ type: 'LLM_CHAT_REQUEST', payload: rest }),
    buildDetail:  (response, requestId) => ({
      requestId,
      ok:      response?.ok ?? false,
      content: response?.ok ? (response.content || '') : null,
      error:   response?.ok ? null : (response?.error || 'Unknown error'),
    }),
  },
  {
    listenEvent:   GAS_EVENTS.LLM_GET_CONFIG,
    responseEvent: GAS_EVENTS.LLM_CONFIG_RESULT,
    buildMessage:  () => ({ type: 'LLM_GET_CONFIG' }),
    buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
  },
  {
    listenEvent:   GAS_EVENTS.LLM_GET_GLOBAL_AI_CONTEXT,
    responseEvent: GAS_EVENTS.LLM_CONFIG_RESULT,
    buildMessage:  () => ({ type: 'GET_GLOBAL_AI_CONTEXT' }),
    buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
  },
  {
    listenEvent:   GAS_EVENTS.LLM_SAVE_CONFIG,
    responseEvent: null,
    buildMessage:  (payload) => ({ type: 'LLM_SAVE_CONFIG', payload }),
    buildDetail:   null,
  },
];

// Se realiza el recurrido para enviar los datos necesarios al background
G_LLM_BRIDGE.forEach(({ listenEvent, responseEvent, buildMessage, buildDetail }) => {
  document.addEventListener(listenEvent, async (e) => {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }

    const { requestId, ...rest } = payload || {};
    const response = await sendToBackground(buildMessage({ requestId, ...rest }));

    if (responseEvent && buildDetail) {
      dispatchGAS(responseEvent, buildDetail(response, requestId));
    }
  });
});

// ─────────────────────────────────────────────
init();