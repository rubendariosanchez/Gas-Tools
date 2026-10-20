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
// GUARD DE SCOPE
// La extensión solo opera dentro del IDE de Apps Script
// (`script.google.com/home/...`). Para webapps publicadas
// (`/macros/s/...`, `/macros/u/N/s/...`) y callbacks de OAuth NO
// queremos inyectar nada: no hay Monaco, no hay toolbar, y los scripts
// de MAIN world tirarían errores ruidosos en la consola de la webapp
// del usuario final. Lo redundamos con `exclude_matches` en el
// manifest, pero dejamos el guard también aquí por si alguna URL nueva
// se cuela (Apps Script ha cambiado el patrón varias veces).
// ─────────────────────────────────────────────

const __GAS_TOOLS_IS_WEBAPP_OR_OAUTH__ = (() => {
  const path = location.pathname || '';
  return (
    /^\/macros\/(?:u\/\d+\/)?s\//.test(path) ||
    /^\/macros\/d\/[^/]+\/usercallback/.test(path) ||
    /^\/oauth\//.test(path)
  );
})();

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

/**
 * Diccionario de la UI inyectada para el idioma elegido en el popup
 * (`ui-language`). Con inglés (default) devuelve `null`: los componentes
 * usan sus textos en inglés como fallback y no hay ningún coste extra.
 * Solo se envían las claves `ed*` (las del popup no hacen falta aquí).
 * @param {string} lang
 * @returns {Promise<{lang:string, messages:Object<string,string>}|null>}
 */
async function loadEditorI18n(lang) {
  if (lang !== 'es') return null;
  // El background lee `_locales/`: un fetch desde el content script lo
  // bloquea Chrome (usa el origen de la página).
  const dict = await sendToBackground({ type: 'GET_EDITOR_I18N', payload: { lang } }, null);
  if (!dict?.messages) console.warn('[GASTools] No se pudo cargar el idioma del editor; se usa inglés.');
  return dict?.messages ? dict : null;
}

async function loadResources() {
  const urls = {
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
 * URL base de los recursos web-accesibles para el MAIN world (que no tiene
 * `chrome.runtime`). Con `use_dynamic_url`, `getURL('')` devuelve el id
 * estático (bloqueado para la página): se deriva del id dinámico de un
 * recurso web-accesible.
 * @returns {string} `chrome-extension://<id-dinámico>/`.
 */
function assetsBaseUrl_() {
  const probe = 'extension/js/gas-tools-main.js';
  return chrome.runtime.getURL(probe).slice(0, -probe.length);
}

/**
 * Inyecta los scripts en MAIN de forma SECUENCIAL y garantizada.
 * Usamos async=false para orden de ejecución en el DOM, pero esperamos
 * cada script individualmente antes de insertar el siguiente.
 */
async function injectScripts() {
  const scriptPaths = [
    'extension/js/services/dom-utils.js',
    'extension/js/shared/gas-ui.js',
    'extension/js/services/gas-file-map.js',
    'extension/js/services/gas-ai-autocomplete.js',
    'extension/js/services/gas-folders.js',
    'extension/js/services/gas-file-tabs.js',
    'extension/js/services/gas-error-lens.js',
    'extension/js/services/gas-native-search.js',
    'src/vendor/diff/diff.min.js',
    'extension/js/components/gas-current-file.js',
    'extension/js/components/gas-actions-panel.js',
    'extension/js/components/gas-github-panel-styles.js',
    'extension/js/components/gas-github-panel-auth.js',
    'extension/js/components/gas-github-panel-sync.js',
    'extension/js/components/gas-github-panel-diff.js',
    'extension/js/components/gas-github-panel-modals.js',
    'extension/js/components/gas-github-panel-progress.js',
    'extension/js/components/gas-github-panel.js',
    'extension/js/shared/line-diff.js',
    'extension/js/shared/edit-applier.js',
    'extension/js/services/gas-diff-preview.js',
    'extension/js/services/gas-diff-viewer.js',
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

/**
 * Observa la aparición de editores Monaco y emite `GAS_TransferData` una
 * vez por instancia. Devuelve `stop()` para liberar observer e intervalo.
 * @param {Object} payload
 * @returns {Function}
 */
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

  // Solo childList: observar `class` en todo el body se disparaba con cada
  // parpadeo del cursor de Monaco. Los nodos insertados DENTRO de un editor
  // existente (líneas, decoraciones) se descartan sin consultar el DOM.
  // El intervalo de abajo cubre el caso raro de un nodo que recibe la
  // clase `monaco-editor` después de insertarse.
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.parentElement?.closest('.monaco-editor')) continue;
        if (node.matches('.monaco-editor')) dispatchEditorData(node);
        else node.querySelectorAll('.monaco-editor').forEach(dispatchEditorData);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const intervalId = setInterval(() => {
    const editors = document.querySelectorAll('.monaco-editor');
    const present = editors.length > 0;

    if (present && !_editorsWerePresent) {
      clearAllReferences();
    }

    _editorsWerePresent = present;
    editors.forEach(dispatchEditorData);
  }, 1500);

  return function stop() {
    observer.disconnect();
    clearInterval(intervalId);
  };
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

// Handles de teardown del bootstrap; evitan duplicar observers/intervalos
// si init() se ejecuta más de una vez (p. ej. re-enable global).
let G_STOP_NAVIGATION = null;
let G_STOP_EDITOR_WATCH = null;
let G_INIT_RUNNING = false;

async function init() {
  if (G_INIT_RUNNING) return;
  G_INIT_RUNNING = true;
  try {
    const settings = await getSavedSettings();

    if (settings['global-enable'] === false) {
      dispatchGAS(GAS_EVENTS.GLOBAL_DISABLE);
      return;
    }

    const [snippets, activeTheme, resources, i18n] = await Promise.all([
      getSavedSnippets(),
      getSavedTheme(),
      loadResources(),
      loadEditorI18n(settings['ui-language']),
    ]);

    // Cargamos las librerias a usar (solo una vez por página)
    if (!document.querySelector('script[data-gas-tools-loaded]')) {
      await injectScripts();
    }

    G_STOP_NAVIGATION?.();
    G_STOP_EDITOR_WATCH?.();

    // Monitoreo de navegación SPA por cambio de URL
    // Cuando cambia de proyecto, reinicializa todo
    G_STOP_NAVIGATION = createNavigationDetector({
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

    G_STOP_EDITOR_WATCH = watchForEditors({
      chatButton:    resources.chatButton,
      fileButton:    resources.fileButton,
      actionsButton: resources.actionsButton,
      githubButton:  resources.githubButton,
      assetsBaseUrl: assetsBaseUrl_(),
      settings,
      snippets,
      activeTheme,
      i18n,
    });

  } catch (err) {
    console.error('[GASTools] Error en init:', err);
  } finally {
    G_INIT_RUNNING = false;
  }
}

// ─────────────────────────────────────────────
// ACTUALIZACIONES EN TIEMPO REAL
// Los listeners solo se registran en el IDE. En una webapp publicada
// no tiene sentido escuchar SETTINGS_UPDATED ni device codes.
// ─────────────────────────────────────────────

if (!__GAS_TOOLS_IS_WEBAPP_OR_OAUTH__) {
  // IMPORTANTE: el listener NO puede ser `async`. Chrome trata la Promise
  // devuelta como respuesta del mensaje: respondería `undefined` al instante
  // y se adelantaría a otros listeners (p. ej. EDITOR_REQUEST del Side
  // Panel, que entonces veía "sin editor"). Se procesa en segundo plano y
  // se devuelve `false` (este listener nunca responde).
  chrome.runtime.onMessage.addListener((msg) => {
    handlePushMessage_(msg).catch((err) => console.warn('[GASTools] Error procesando mensaje:', err));
    return false;
  });
}

/** Mensajes "push" del background hacia el MAIN world (sin respuesta). */
async function handlePushMessage_(msg) {
  if (!msg || typeof msg.type !== 'string') return;

  // Push del device flow desde el background → MAIN world.
  if (msg.type === 'GITHUB_DEVICE_CODE') {
    dispatchGAS(GAS_EVENTS.GH_DEVICE_CODE, msg.payload || {});
    return;
  }

  // Eventos de progreso del push: el background los emite por cada
  // blob subido y por cada cambio de fase.
  if (msg.type === 'GH_PUSH_PROGRESS') {
    dispatchGAS('GAS_GH_PUSH_PROGRESS', msg.payload || {});
    return;
  }

  // Config LLM guardada (p. ej. desde el Side Panel): el autocompletado
  // del MAIN world recarga su copia.
  if (msg.type === 'LLM_CONFIG_UPDATED') {
    dispatchGAS('GAS_LLM_CONFIG_UPDATED', {});
    return;
  }

  if (msg.type !== 'SETTINGS_UPDATED') return;

  const { options, changed, data, updateType } = msg.payload || {};

  // Se valida si es una actualización de configuración
  if (updateType === 'settings') {
    // Con `changed` solo viaja el delta. Sin él (reset, migración) o si cambia
    // `global-enable`, va todo: los servicios se reactivan con su estado real.
    const hasDelta = !!changed && typeof changed === 'object' && !('global-enable' in changed);
    const delta = hasDelta ? changed : { ...(options || {}), ...(changed || {}) };
    // Si se reactiva la extensión y los scripts aún no se inyectaron en el
    // mundo MAIN, hacemos init() completo. La presencia del flag
    // `__gasToolsInit` (que persiste aunque los <script> se hayan removido)
    // indica que el bootstrap ya se ejecutó al menos una vez.
    const alreadyBooted = !!document.querySelector('script[data-gas-tools-loaded]');
    if (delta['global-enable'] === true && !alreadyBooted) {
      document.querySelectorAll('.monaco-editor[data-gasreference]').forEach(el => {
        delete el.dataset.gasreference;
      });
      dispatchGAS(GAS_EVENTS.GLOBAL_ENABLE);
      await init();
    }
    dispatchGAS(GAS_EVENTS.SETTINGS_UPDATED, delta);
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
}

// ─────────────────────────────────────────────
// BRIDGE MAIN ↔ BACKGROUND — tabla de despacho unificada
// Las rutas LLM (petición, streaming, config) viven en
// `extension/js/shared/llm-bridge.js` (compartido con el Side Panel) y se
// instalan más abajo con `GasLlmBridge.install`.
// Todos los eventos del mundo MAIN siguen el mismo patrón:
// escuchar evento → parsear detail → enviar al background → despachar respuesta.
//
// Seguridad: ninguna respuesta incluye secretos. El background inyecta
// API keys y tokens del lado del service worker; aquí solo viajan
// `apiKeysSet` (booleanos) y el perfil público del usuario.
// ─────────────────────────────────────────────

const G_BRIDGE_ROUTES = [
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
    buildMessage:  ({ requestId, action, payload }) => ({
      type:    'GITHUB_API_CALL',
      payload: { requestId, action, payload },
    }),
    buildDetail:   (response, requestId) => ({
      requestId,
      ok:    response?.ok ?? false,
      data:  response?.ok ? (response.data || null) : null,
      error: response?.ok ? null : (response?.error || 'Unknown error'),
      uploadedBlobs: response?.uploadedBlobs || null,
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

// Se realiza el recurrido para enviar los datos necesarios al background.
// Como el bridge solo tiene sentido cuando los componentes del editor
// están vivos en MAIN world, lo registramos únicamente en el IDE.
if (!__GAS_TOOLS_IS_WEBAPP_OR_OAUTH__) {
  G_BRIDGE_ROUTES.forEach(({ listenEvent, responseEvent, buildMessage, buildDetail }) => {
    document.addEventListener(listenEvent, async (e) => {
      let payload;
      try { payload = JSON.parse(e.detail); } catch (_) { return; }

      const { requestId, ...rest } = payload || {};
      const response = await sendToBackground(buildMessage({ ...rest, requestId }));

      if (responseEvent && buildDetail) {
        dispatchGAS(responseEvent, buildDetail(response, requestId));
      }
    });
  });
}

// ─────────────────────────────────────────────
// BRIDGE LLM (compartido con el Side Panel)
// ─────────────────────────────────────────────

// Menor privilegio: la página (MAIN world) solo usa el autocompletado, que
// pide completions, cancela y lee la config. Guardar config, listar modelos,
// el contexto global y el streaming quedan solo para el Side Panel.
if (!__GAS_TOOLS_IS_WEBAPP_OR_OAUTH__) {
  const E = GasLlmBridge.EVENTS;
  GasLlmBridge.install({
    sendToBackground,
    isContextValid: isExtensionContextValid,
    routes: [E.LLM_REQUEST, E.LLM_CANCEL, E.LLM_GET_CONFIG],
    stream: false,
  });
}

// ─────────────────────────────────────────────
// SIDE PANEL: apertura y canal de editor
// ─────────────────────────────────────────────

const EDITOR_REQUEST_TIMEOUT_MS = 5000;
// Acciones lentas (guardado, aplicar varios archivos). Una respuesta tardía
// tras el timeout se descarta: reintentar applyChangeSet es idempotente.
const EDITOR_REQUEST_TIMEOUTS_MS = Object.freeze({ saveProject: 15000, applyChangeSet: 15000 });

/**
 * Reenvía una petición del Side Panel al MAIN world (`gas-tools.js`) y
 * espera `GAS_EDITOR_RESPONSE` con el mismo requestId.
 * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
 */
function relayEditorRequest_(action, payload) {
  return new Promise((resolve) => {
    const requestId = `ed_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    let timerId = 0;
    const onResponse = (e) => {
      let detail;
      try { detail = JSON.parse(e.detail); } catch (_) { return; }
      if (detail?.requestId !== requestId) return;
      clearTimeout(timerId);
      document.removeEventListener('GAS_EDITOR_RESPONSE', onResponse);
      resolve({ ok: !!detail.ok, data: detail.data, error: detail.error });
    };
    document.addEventListener('GAS_EDITOR_RESPONSE', onResponse);
    timerId = setTimeout(() => {
      document.removeEventListener('GAS_EDITOR_RESPONSE', onResponse);
      resolve({ ok: false, error: 'timeout' });
    }, Object.hasOwn(EDITOR_REQUEST_TIMEOUTS_MS, action) ? EDITOR_REQUEST_TIMEOUTS_MS[action] : EDITOR_REQUEST_TIMEOUT_MS);
    dispatchGAS('GAS_EDITOR_REQUEST', { requestId, action, payload: payload || {} });
  });
}

if (!__GAS_TOOLS_IS_WEBAPP_OR_OAUTH__) {
  // Peticiones de contexto/edición desde el Side Panel. Solo se aceptan
  // de páginas de la propia extensión (sin `sender.tab`).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'EDITOR_REQUEST') return false;
    if (sender?.id !== chrome.runtime.id || sender.tab) return false;
    relayEditorRequest_(msg.action, msg.payload).then(sendResponse);
    return true;
  });

  // Eventos del editor (vista previa de cambios: aceptar/rechazar/navegar/cerrar)
  // → páginas de la extensión (Side Panel). Sin receptor no es un error.
  document.addEventListener('GAS_EDITOR_EVENT', (e) => {
    let event;
    try { event = JSON.parse(e.detail); } catch (_) { return; }
    if (!event?.type || !isExtensionContextValid()) return;
    try {
      chrome.runtime.sendMessage({ type: 'EDITOR_EVENT', event }).catch(() => {});
    } catch (_) { /* contexto invalidado entre la comprobación y el envío */ }
  });

  // Botón IA / atajos del editor → abrir el Side Panel de esta ventana.
  document.addEventListener('GAS_OPEN_SIDE_PANEL', async () => {
    const res = await sendToBackground({ type: 'OPEN_SIDE_PANEL' }, { ok: false, error: 'no-response' });
    if (!res?.ok) dispatchGAS('GAS_OPEN_SIDE_PANEL_RESULT', { ok: false, error: res?.error || 'unknown' });
  });
}

// ─────────────────────────────────────────────
// Solo arrancamos en el IDE. En webapps y callbacks salimos sin ruido.
if (!__GAS_TOOLS_IS_WEBAPP_OR_OAUTH__) {
  init();
}