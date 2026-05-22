"use strict";

/**
 * @fileoverview Content script de Gas-Tools que vive en el contexto
 * "isolated" del navegador. Su único trabajo es servir de **bridge**
 * entre dos mundos que no se ven entre sí:
 *
 *   - Background (service worker): habla `chrome.runtime` y tiene
 *     permisos para llamar a API externas.
 *   - Editor en MAIN world (`gas-tools.js` + Web Components): solo puede
 *     comunicarse vía CustomEvents en el DOM.
 *
 * Aquí se hace la traducción:
 *   `chrome.runtime.sendMessage` ↔ `dispatchEvent(new CustomEvent(...))`
 *
 * Además inyecta los scripts de MAIN world (services, components,
 * `gas-tools.js`, `gas-tools-main.js`) en orden, monitorea la navegación
 * SPA de Apps Script para reinicializar al cambiar de proyecto, y
 * propaga los `SETTINGS_UPDATED` / `DATA_UPDATED` recibidos del popup.
 *
 * Las constantes `GAS_EVENTS` se replican a propósito en
 * `gas-tools-main.js` porque ese archivo se ejecuta en MAIN world y no
 * puede importar este módulo.
 */

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
  DOWNLOAD_PROJECT: 'GAS_DownloadProject',
  DOWNLOAD_RESULT:  'GAS_DownloadProjectResult',
  GH_GET_AUTH:        'GAS_GH_GET_AUTH',
  GH_AUTH_RESULT:     'GAS_GH_AUTH_RESULT',
  GH_AUTHENTICATE:    'GAS_GH_AUTHENTICATE',
  GH_AUTH_DONE:       'GAS_GH_AUTH_DONE',
  GH_CANCEL_AUTH:     'GAS_GH_CANCEL_AUTH',
  GH_CANCEL_AUTH_DONE:'GAS_GH_CANCEL_AUTH_DONE',
  GH_DEVICE_CODE:     'GAS_GH_DEVICE_CODE',
  GH_LOGOUT:          'GAS_GH_LOGOUT',
  GH_LOGOUT_DONE:     'GAS_GH_LOGOUT_DONE',
  GH_GET_PROJECT:     'GAS_GH_GET_PROJECT',
  GH_PROJECT_RESULT:  'GAS_GH_PROJECT_RESULT',
  GH_SAVE_PROJECT:    'GAS_GH_SAVE_PROJECT',
  GH_SAVE_DONE:       'GAS_GH_SAVE_DONE',
  GH_API_CALL:        'GAS_GH_API_CALL',
  GH_API_RESULT:      'GAS_GH_API_RESULT',
  GG_GET_AUTH:        'GAS_GG_GET_AUTH',
  GG_AUTH_RESULT:     'GAS_GG_AUTH_RESULT',
  GG_AUTHENTICATE:    'GAS_GG_AUTHENTICATE',
  GG_AUTH_DONE:       'GAS_GG_AUTH_DONE',
  GG_LOGOUT:          'GAS_GG_LOGOUT',
  GG_LOGOUT_DONE:     'GAS_GG_LOGOUT_DONE',
  GG_API_CALL:        'GAS_GG_API_CALL',
  GG_API_RESULT:      'GAS_GG_API_RESULT',
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
 * @param {Object} callbacks - {
 *   onProjectChange(scriptKey),
 *   onLeave(),
 *   onReturnToEditor(scriptKey),
 *   onLeaveEditor(scriptKey)
 * }
 * @returns {Function} stop() para detener el polling.
 */
function createNavigationDetector(callbacks) {
  // Regex unificado de subrutas conocidas dentro de un proyecto. Lo
  // reutilizamos en la inicialización y en el polling para no dejar
  // ninguna ruta fuera (omitirlas hace que `lastKey` quede `null` y la
  // siguiente transición se interprete como cambio de proyecto).
  const SUBROUTE_RE =
    /\/([^/]+?)\/(?:edit|executions|deployments|libraries|services|metrics|triggers|settings|versions|history|projecthistory)/;

  let lastPath  = document.location.pathname;
  // Inicializamos `lastKey` desde la URL actual para que la primera
  // navegación dentro del mismo proyecto se detecte como `onLeaveEditor`
  // y no como `onProjectChange`.
  const initMatch = lastPath.match(SUBROUTE_RE);
  let lastKey      = initMatch ? initMatch[1] : null;
  // Última subruta dentro del proyecto: 'edit', 'executions', 'deployments', etc.
  let lastInEditor = /\/edit(\/|$)/.test(lastPath);
  let interval  = null;

  // Arranca tras 1.5s para dejar que la SPA se estabilice al cargar
  const delayId = setTimeout(() => {
    // Refrescar el estado inicial: durante el delay el usuario puede haber
    // navegado, y queremos comparar contra la URL real al iniciar el polling.
    lastPath = document.location.pathname;
    const m  = lastPath.match(SUBROUTE_RE);
    lastKey  = m ? m[1] : null;
    lastInEditor = /\/edit(\/|$)/.test(lastPath);

    interval = setInterval(() => {
      const path  = document.location.pathname;
      const match = path.match(SUBROUTE_RE);
      const key   = match ? match[1] : null;
      const inEditor = /\/edit(\/|$)/.test(path);

      // Ignorar si sigue siendo la misma ruta exacta
      if (path === lastPath) return;
      lastPath = path;

      // Cambio real de proyecto (clave nueva distinta a una previa).
      if (key && lastKey && key !== lastKey) {
        lastKey = key;
        lastInEditor = inEditor;
        callbacks.onProjectChange?.(key);
        return;
      }

      // Salida total del proyecto (sin clave ni subruta conocida).
      if (!key && lastKey) {
        lastKey = null;
        lastInEditor = false;
        callbacks.onLeave?.();
        return;
      }

      // Mismo proyecto (o primera vez que reconocemos una clave) y se
      // entra a `/edit`. Cubrimos también el caso en que `lastKey` era
      // `null` porque la ruta previa no estaba en `SUBROUTE_RE` (p. ej.
      // un alias/legacy que no hayamos contemplado).
      if (key && inEditor && !lastInEditor) {
        lastKey = key;
        lastInEditor = true;
        callbacks.onReturnToEditor?.(key);
        return;
      }

      // Mismo proyecto pero saliendo del editor (a Ejecuciones, Despliegues, etc.).
      if (key && key === lastKey && !inEditor && lastInEditor) {
        lastInEditor = false;
        callbacks.onLeaveEditor?.(key);
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
    fileButton:   'extension/html/currentFileButton.html',
    actionsButton:'extension/html/actionsButton.html',
    githubButton: 'extension/html/githubButton.html',
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
    'extension/js/services/gas-file-map.js',
    'extension/js/services/gas-ai-autocomplete.js',
    'extension/js/services/gas-folders.js',
    'extension/js/services/gas-error-lens.js',
    'src/vendor/diff/diff.min.js',
    'src/vendor/diff2html/diff2html-ui.min.js',
    'extension/js/components/gas-search-panel.js',
    'extension/js/components/gas-chat-panel.js',
    'extension/js/components/gas-current-file.js',
    'extension/js/components/gas-actions-panel.js',
    'extension/js/components/gas-github-panel.js',
    'extension/js/gas-tools.js',
    'extension/js/gas-tools-main.js',
  ];

  // Inyección secuencial: cada script espera al anterior antes de insertarse.
  // Esto garantiza el orden de dependencias sin depender de async=false.
  // Tras cargar, todos se eliminan del DOM excepto el último: dejamos un
  // marcador para que el listener de SETTINGS_UPDATED pueda saber que el
  // bootstrap ya corrió y no necesita reinyectar todo en cada cambio.
  for (let i = 0; i < scriptPaths.length; i++) {
    const path  = scriptPaths[i];
    const isLast = i === scriptPaths.length - 1;
    await new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = chrome.runtime.getURL(path);
      el.addEventListener('load',  () => {
        if (isLast) {
          el.dataset.gasToolsLoaded = '1';
        } else {
          el.remove();
        }
        resolve();
      }, { once: true });
      el.addEventListener('error', (e) => { el.remove(); reject(e); }, { once: true });
      (document.head || document.documentElement).appendChild(el);
    });
  }
}

// ─────────────────────────────────────────────
// COMUNICACIÓN CON BACKGROUND
// ─────────────────────────────────────────────

// Bandera única para no spamear la consola cuando la extensión fue
// recargada/reinstalada y este content script quedó huérfano: cada
// sendMessage tirará "Extension context invalidated", solo avisamos
// una vez y descartamos los siguientes.
let G_CONTEXT_INVALIDATED = false;

/**
 * Detecta si el contexto de la extensión sigue activo. Tras recargar la
 * extensión desde chrome://extensions, el content script previo queda
 * inerte y `chrome.runtime.id` pasa a ser `undefined`.
 * @returns {boolean}
 */
function isExtensionContextValid() {
  try { return Boolean(chrome?.runtime?.id); }
  catch { return false; }
}

/**
 * Envía un mensaje al background de forma segura. Si el contexto fue
 * invalidado (extensión recargada), resuelve con `fallback` sin disparar
 * `chrome.runtime.sendMessage` y avisa una sola vez al usuario.
 *
 * @param {Object} message  Mensaje a enviar.
 * @param {*}      [fallback=null] Valor de respaldo si no hay respuesta.
 * @returns {Promise<*>}
 */
function sendToBackground(message, fallback = null) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) {
      if (!G_CONTEXT_INVALIDATED) {
        G_CONTEXT_INVALIDATED = true;
        console.warn('[GASTools] Contexto de la extensión invalidado. Recarga la página para reactivarla.');
      }
      resolve(fallback);
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastErr = chrome.runtime.lastError?.message || '';
        if (lastErr) {
          if (lastErr.includes('Extension context invalidated') ||
              lastErr.includes('Receiving end does not exist')) {
            if (!G_CONTEXT_INVALIDATED) {
              G_CONTEXT_INVALIDATED = true;
              console.warn('[GASTools] Contexto de la extensión invalidado. Recarga la página para reactivarla.');
            }
          }
          resolve(fallback);
          return;
        }
        resolve(response ?? fallback);
      });
    } catch (err) {
      // sendMessage puede tirar sincrónicamente si el contexto se invalidó
      // entre la verificación inicial y la llamada.
      const msg = err?.message || String(err);
      if (msg.includes('Extension context invalidated') && !G_CONTEXT_INVALIDATED) {
        G_CONTEXT_INVALIDATED = true;
        console.warn('[GASTools] Contexto de la extensión invalidado. Recarga la página para reactivarla.');
      }
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

    if (present && !_editorsWerePresent) {
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
      dispatchGAS(GAS_EVENTS.GLOBAL_DISABLE);
      return;
    }

    // Cargamos las librerias a usar
    await injectScripts();

    // Monitoreo de navegación SPA por cambio de URL
    // Cuando cambia de proyecto, reinicializa todo
    createNavigationDetector({
      onProjectChange(scriptKey) {
        // Cambio a otro proyecto: cerramos paneles y limpiamos refs.
        dispatchGAS('GAS_HidePanels');
        document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
          delete el.dataset.gasreference;
        });
      },
      onReturnToEditor(scriptKey) {
        // Volver al editor desde /executions, /deployments, etc.
        // Limpiamos refs para que watchForEditors reemita GAS_TransferData
        // y la UI se reinyecte en la toolbar nueva.
        document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
          delete el.dataset.gasreference;
        });
        // Notificamos al world MAIN para que `gas-tools.js` recapture el
        // modelo principal y refresque el mapa de archivos.
        dispatchGAS('GAS_ReturnToEditor', { scriptKey });
      },
      onLeaveEditor(scriptKey) {
        // Salir del editor a otra subruta del mismo proyecto: ocultar paneles.
        dispatchGAS('GAS_HidePanels');
      },
      onLeave() {
        // Salir del proyecto por completo: ocultar paneles.
        dispatchGAS('GAS_HidePanels');
      },
    });

    watchForEditors({
      searchButton:  resources.searchButton,
      chatButton:    resources.chatButton,
      fileButton:    resources.fileButton,
      actionsButton: resources.actionsButton,
      githubButton:  resources.githubButton,
      themeUrl:      chrome.runtime.getURL('themes'),
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
  // Push del device flow desde el background → MAIN world.
  if (msg.type === 'GITHUB_DEVICE_CODE') {
    dispatchGAS(GAS_EVENTS.GH_DEVICE_CODE, msg.payload || {});
    return;
  }

  if (msg.type !== 'SETTINGS_UPDATED') return;

  const { options, data, updateType } = msg.payload;

  // Se valida si es una actualización de configuración
  if (updateType === 'settings') {
    // Si se reactiva la extensión y los scripts aún no se inyectaron en el
    // mundo MAIN, hacemos init() completo. La presencia del flag
    // `__gasToolsInit` (que persiste aunque los <script> se hayan removido)
    // indica que el bootstrap ya se ejecutó al menos una vez.
    const alreadyBooted = !!document.querySelector('script[data-gas-tools-loaded]');
    if (options['global-enable'] === true && !alreadyBooted) {
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
  {
    listenEvent:   GAS_EVENTS.DOWNLOAD_PROJECT,
    responseEvent: GAS_EVENTS.DOWNLOAD_RESULT,
    buildMessage:  ({ scriptId }) => ({ type: 'DOWNLOAD_GAS_PROJECT', scriptId }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      data:  response?.ok ? (response.data || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
    }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_GET_AUTH,
    responseEvent: GAS_EVENTS.GH_AUTH_RESULT,
    buildMessage:  () => ({ type: 'GITHUB_GET_AUTH' }),
    buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_AUTHENTICATE,
    responseEvent: GAS_EVENTS.GH_AUTH_DONE,
    buildMessage:  () => ({ type: 'GITHUB_AUTHENTICATE' }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      user:  response?.ok ? (response.user || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
    }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_CANCEL_AUTH,
    responseEvent: GAS_EVENTS.GH_CANCEL_AUTH_DONE,
    buildMessage:  () => ({ type: 'GITHUB_CANCEL_AUTH' }),
    buildDetail:   (response, requestId) => ({ requestId, ok: response?.ok ?? false }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_LOGOUT,
    responseEvent: GAS_EVENTS.GH_LOGOUT_DONE,
    buildMessage:  () => ({ type: 'GITHUB_LOGOUT' }),
    buildDetail:   (response, requestId) => ({ requestId, ok: response?.ok ?? false }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_GET_PROJECT,
    responseEvent: GAS_EVENTS.GH_PROJECT_RESULT,
    buildMessage:  ({ scriptId }) => ({ type: 'GITHUB_GET_PROJECT_CONFIG', payload: { scriptId } }),
    buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_SAVE_PROJECT,
    responseEvent: GAS_EVENTS.GH_SAVE_DONE,
    buildMessage:  ({ scriptId, config }) => ({
      type:    'GITHUB_SAVE_PROJECT_CONFIG',
      payload: { scriptId, config },
    }),
    buildDetail:   (response, requestId) => ({ requestId, ok: response?.ok ?? false }),
  },
  {
    listenEvent:   GAS_EVENTS.GH_API_CALL,
    responseEvent: GAS_EVENTS.GH_API_RESULT,
    buildMessage:  ({ action, payload }) => ({
      type:    'GITHUB_API_CALL',
      payload: { action, payload },
    }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      data:  response?.ok ? (response.data || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
    }),
  },
  {
    listenEvent:   GAS_EVENTS.GG_GET_AUTH,
    responseEvent: GAS_EVENTS.GG_AUTH_RESULT,
    buildMessage:  () => ({ type: 'GOOGLE_GET_AUTH' }),
    buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
  },
  {
    listenEvent:   GAS_EVENTS.GG_AUTHENTICATE,
    responseEvent: GAS_EVENTS.GG_AUTH_DONE,
    buildMessage:  () => ({ type: 'GOOGLE_AUTHENTICATE' }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      user:  response?.ok ? (response.user || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
    }),
  },
  {
    listenEvent:   GAS_EVENTS.GG_LOGOUT,
    responseEvent: GAS_EVENTS.GG_LOGOUT_DONE,
    buildMessage:  () => ({ type: 'GOOGLE_LOGOUT' }),
    buildDetail:   (response, requestId) => ({ requestId, ok: response?.ok ?? false }),
  },
  {
    listenEvent:   GAS_EVENTS.GG_API_CALL,
    responseEvent: GAS_EVENTS.GG_API_RESULT,
    buildMessage:  ({ action, payload }) => ({
      type:    'GOOGLE_API_CALL',
      payload: { action, payload },
    }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      data:  response?.ok ? (response.data || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
    }),
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