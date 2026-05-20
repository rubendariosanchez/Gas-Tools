"use strict";
import { DB } from '../src/js/utils/Storage.js';
import { G_PROPERTY_NAME, DEFAULT_SNIPPETS } from '../src/js/utils/Variables.js';
import { getActiveTheme, callLlmProvider } from './js/services/llm-providers.js';
import { callGithubApi, startDeviceFlow, pollDeviceToken, getAuthenticatedUser } from './js/services/github-api.js';

// ─────────────────────────────────────────────
// CLAVES DE STORAGE PARA GITHUB
// ─────────────────────────────────────────────
// Token y perfil del usuario son globales (una sola cuenta por extensión).
// El mapping de proyecto→repo se guarda por scriptId para soportar varios
// proyectos GAS desde la misma sesión sin re-configurar.
const GH_TOKEN_KEY    = 'gasToolsGithubAuth';      // { token, user }
const GH_PROJECTS_KEY = 'gasToolsGithubProjects';  // { [scriptId]: { repo, branch, basePath } }

// Client ID de la OAuth App pública usada por la extensión. Es público
// por diseño (Device Flow no usa client_secret) y va embebido en el
// código para que la autenticación sea click → autorizar → conectado.
const GH_CLIENT_ID = 'Ov23liwkN4OIewqxXF7m';

/** Lee la auth global de GitHub desde chrome.storage.sync. */
function _getGithubAuth() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([GH_TOKEN_KEY], (r) => resolve(r?.[GH_TOKEN_KEY] || null));
  });
}

/** Guarda la auth global de GitHub. */
function _setGithubAuth(value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [GH_TOKEN_KEY]: value || null }, () => resolve(!chrome.runtime.lastError));
  });
}

// ─────────────────────────────────────────────
// DEVICE FLOW STATE
// ─────────────────────────────────────────────
// Mantenemos UNA sola sesión activa de Device Flow: si el usuario hace
// click dos veces, descartamos la anterior. Como el service worker puede
// dormirse, el polling debe usar `chrome.alarms` para sobrevivir; aquí
// usamos setTimeout porque el polling es corto (<= 15 min) y mientras
// haya intervalos activos el SW se mantiene vivo.
let G_DEVICE_FLOW = null;

/**
 * Inicia (o reinicia) un Device Flow. Resuelve cuando el usuario autoriza,
 * o rechaza con un Error si expira o el usuario lo deniega.
 *
 * @param {string} clientId
 * @param {string} scope     Scopes solicitados (ej. 'repo,user').
 * @param {(info:{user_code:string, verification_uri:string, expires_in:number}) => void} onCode
 *   Callback invocado en cuanto GitHub devuelve el user_code (para que el
 *   panel pueda mostrarlo y el background pueda abrir la pestaña).
 * @returns {Promise<{token:string, user:object}>}
 */
async function _runDeviceFlow(clientId, scope, onCode) {
  // 1. Cancelar cualquier flow previo en curso.
  if (G_DEVICE_FLOW?.cancel) G_DEVICE_FLOW.cancel();

  const init = await startDeviceFlow(clientId, scope);

  // Notificamos los códigos al panel inmediatamente.
  try { onCode?.(init); } catch (_) { /* el panel se cerró */ }

  let cancelled = false;
  const session = {
    cancel: () => { cancelled = true; },
    /** windowId del popup de autorización; lo setea el caller. */
    popupWindowId: null,
  };
  G_DEVICE_FLOW = session;

  /** Cierra la ventana popup si sigue abierta. Idempotente. */
  const closePopup = () => {
    const id = session.popupWindowId;
    session.popupWindowId = null;
    if (id != null) {
      chrome.windows.remove(id).catch(() => { /* ya cerrada */ });
    }
  };

  const expiresAt = Date.now() + (init.expires_in * 1000);
  let interval    = (init.interval || 5) * 1000;

  try {
    while (!cancelled) {
      if (Date.now() >= expiresAt) throw new Error('Authorization expired. Please try again.');
      await new Promise((r) => setTimeout(r, interval));
      if (cancelled) throw new Error('Cancelled.');

      let resp;
      try { resp = await pollDeviceToken(clientId, init.device_code); }
      catch (err) { console.warn('[Background] Device poll failed:', err); continue; }

      if (resp.access_token) {
        const user = await getAuthenticatedUser(resp.access_token);
        return { token: resp.access_token, user };
      }

      switch (resp.error) {
        case 'authorization_pending':
          continue;                      // sigue esperando
        case 'slow_down':
          interval += 5000;              // GitHub pide bajar el ritmo
          continue;
        case 'expired_token':
          throw new Error('Authorization expired. Please try again.');
        case 'access_denied':
          throw new Error('Authorization was denied.');
        default:
          throw new Error(resp.error_description || resp.error || 'Unknown OAuth error.');
      }
    }
    throw new Error('Cancelled.');
  } finally {
    // Garantizamos cerrar la popup en TODOS los caminos: éxito, error,
    // expiración, cancelación. El listener onRemoved que se monta más
    // abajo tolera que la ventana ya esté cerrada.
    closePopup();
    if (G_DEVICE_FLOW === session) G_DEVICE_FLOW = null;
  }
}

/**
 * Cuando el usuario cierra la ventana popup manualmente, cancelamos el
 * flow para que la promesa resuelva con error en vez de quedar colgada
 * hasta `expires_in` (15 minutos).
 */
chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (G_DEVICE_FLOW?.popupWindowId === closedWindowId) {
    G_DEVICE_FLOW.popupWindowId = null;
    G_DEVICE_FLOW.cancel?.();
  }
});

// ─────────────────────────────────────────────
// UTILIDADES INTERNAS
// ─────────────────────────────────────────────

/** Obtiene los snippets finales (predeterminados + usuario) desde IndexedDB. */
async function _buildSnippets() {
  const userSnippets = await DB.getAll('snippets') || [];
  return [...DEFAULT_SNIPPETS, ...userSnippets];
}

/**
 * Envía un payload a todos los tabs del editor GAS abiertos.
 * @param {Object} payload
 */
function _sendToTabs(payload) {
  chrome.tabs.query({ url: 'https://script.google.com/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        payload,
      }).catch(err => {
        console.error('[Background] No se pudo enviar al tab:', tab.id, err.message);
      });
    });
  });
}

// ─────────────────────────────────────────────
// MANEJADORES DE MENSAJES
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── GET_SETTINGS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SETTINGS') {
    DB.get('settings', G_PROPERTY_NAME)
      .then(data => sendResponse(data?.options ?? {}))
      .catch(() => sendResponse({}));
    return true;
  }

  // ── GET_SNIPPETS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SNIPPETS') {
    _buildSnippets()
      .then(snippets => sendResponse(snippets))
      .catch(err => { console.error('[BG] Error al obtener snippets:', err); sendResponse([]); });
    return true;
  }

  // ── GET_ACTIVE_THEME ──────────────────────────────────────────────
  if (msg.type === 'GET_ACTIVE_THEME') {
    getActiveTheme()
      .then(themeData => sendResponse(themeData))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── NOTIFY_UPDATE ─────────────────────────────────────────────────
  if (msg.type === 'NOTIFY_UPDATE') {
    const { updateType } = msg;

    (async () => {
      try {
        if (updateType === 'settings') {
          const settingsData = await DB.get('settings', G_PROPERTY_NAME);
          _sendToTabs({ options: settingsData?.options ?? {}, updateType });

        } else if (updateType === 'snippets') {
          const finalSnippets = await _buildSnippets();
          _sendToTabs({ data: finalSnippets, updateType });

        } else if (updateType === 'themes') {
          const themeData = await getActiveTheme();
          _sendToTabs({ data: themeData, updateType });
        }
      } catch (err) {
        console.error('[Background] Error en NOTIFY_UPDATE:', err);
      }
    })();

    sendResponse({ ok: true });
    return true;
  }

  // ── LLM_GET_CONFIG ────────────────────────────────────────────────
  if (msg.type === 'LLM_GET_CONFIG') {
    chrome.storage.sync.get(['gasToolsLlmConfig'], (result) => {
      sendResponse(result?.gasToolsLlmConfig || null);
    });
    return true;
  }

  // ── LLM_SAVE_CONFIG ───────────────────────────────────────────────
  if (msg.type === 'LLM_SAVE_CONFIG') {
    chrome.storage.sync.set({ gasToolsLlmConfig: msg.payload || {} }, () => {
      sendResponse({ ok: !chrome.runtime.lastError });
    });
    return true;
  }

  // ── GET_GLOBAL_AI_CONTEXT ─────────────────────────────────────────
  if (msg.type === 'GET_GLOBAL_AI_CONTEXT') {
    chrome.storage.sync.get(['gasToolsAiContext'], (result) => {
      sendResponse(result['gasToolsAiContext'] || null);
    });
    return true;
  }

  // ── LLM_CHAT_REQUEST ──────────────────────────────────────────────
  if (msg.type === 'LLM_CHAT_REQUEST') {
    callLlmProvider(msg.payload || {})
      .then(content => sendResponse({ ok: true, content }))
      .catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // ── GITHUB_GET_AUTH ───────────────────────────────────────────────
  // Devuelve `{ token, user }` o `null` si aún no se ha autenticado.
  if (msg.type === 'GITHUB_GET_AUTH') {
    _getGithubAuth().then((auth) => sendResponse(auth));
    return true;
  }

  // ── GITHUB_AUTHENTICATE ───────────────────────────────────────────
  // Inicia el Device Flow:
  //   1. POST /login/device/code → user_code, verification_uri
  //   2. chrome.tabs.create(verification_uri) en una pestaña nueva
  //   3. Avisa al panel con GITHUB_DEVICE_CODE_READY (con user_code)
  //   4. Polling al endpoint de token hasta éxito/error/expiración
  //   5. GET /user con el token y persistencia
  if (msg.type === 'GITHUB_AUTHENTICATE') {
    (async () => {
      try {
        const result = await _runDeviceFlow(GH_CLIENT_ID, 'repo,user', (info) => {
          // Abrimos github.com/login/device en una VENTANA popup (sin barra
          // de direcciones, sin tabs), igual que el flujo de Google OAuth.
          // Adjuntamos `user_code` en el query para que GitHub lo pre-rellene.
          const verifyUrl = info.verification_uri_complete
                         || `${info.verification_uri}?user_code=${encodeURIComponent(info.user_code)}`;

          // Dimensiones tipo modal de OAuth: lo suficientemente cómodo para
          // ver el formulario de "Authorize" sin sentirse encajonado.
          chrome.windows.create({
            url:    verifyUrl,
            type:   'popup',
            width:  560,
            height: 720,
            focused: true,
          }).then((win) => {
            // Guardamos el windowId en la sesión activa para poder cerrarla
            // automáticamente cuando el flow termine (éxito o error).
            if (G_DEVICE_FLOW) G_DEVICE_FLOW.popupWindowId = win.id;
          }).catch((err) => {
            console.warn('[Background] No se pudo abrir popup OAuth:', err);
          });

          // Notificamos a los content scripts conectados con los datos
          // del código para que el panel los muestre como respaldo.
          chrome.tabs.query({ url: 'https://script.google.com/*' }, (tabs) => {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, {
                type:    'GITHUB_DEVICE_CODE',
                payload: {
                  user_code:        info.user_code,
                  verification_uri: info.verification_uri,
                  expires_in:       info.expires_in,
                },
              }).catch(() => { /* tab cerrada */ });
            });
          });
        });

        await _setGithubAuth({ token: result.token, user: result.user });
        sendResponse({ ok: true, user: result.user });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── GITHUB_CANCEL_AUTH ────────────────────────────────────────────
  if (msg.type === 'GITHUB_CANCEL_AUTH') {
    G_DEVICE_FLOW?.cancel?.();
    sendResponse({ ok: true });
    return true;
  }

  // ── GITHUB_LOGOUT ─────────────────────────────────────────────────
  if (msg.type === 'GITHUB_LOGOUT') {
    _setGithubAuth(null).then((ok) => sendResponse({ ok }));
    return true;
  }

  // ── GITHUB_GET_PROJECT_CONFIG ─────────────────────────────────────
  // Devuelve la config del proyecto identificado por scriptId, o null.
  if (msg.type === 'GITHUB_GET_PROJECT_CONFIG') {
    const scriptId = msg.payload?.scriptId;
    chrome.storage.sync.get([GH_PROJECTS_KEY], (r) => {
      const map = r?.[GH_PROJECTS_KEY] || {};
      sendResponse(scriptId ? (map[scriptId] || null) : null);
    });
    return true;
  }

  // ── GITHUB_SAVE_PROJECT_CONFIG ────────────────────────────────────
  if (msg.type === 'GITHUB_SAVE_PROJECT_CONFIG') {
    const { scriptId, config } = msg.payload || {};
    if (!scriptId) { sendResponse({ ok: false, error: 'scriptId requerido' }); return true; }
    chrome.storage.sync.get([GH_PROJECTS_KEY], (r) => {
      const map = { ...(r?.[GH_PROJECTS_KEY] || {}) };
      if (config) map[scriptId] = config;
      else        delete map[scriptId];
      chrome.storage.sync.set({ [GH_PROJECTS_KEY]: map }, () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      });
    });
    return true;
  }

  // ── GITHUB_API_CALL ───────────────────────────────────────────────
  // Despacho genérico para todas las llamadas autenticadas (list repos,
  // create, branches, push, fetch). El token se inyecta aquí desde
  // storage para que NUNCA viaje al MAIN world.
  if (msg.type === 'GITHUB_API_CALL') {
    const { action, payload } = msg.payload || {};
    (async () => {
      try {
        const auth = await _getGithubAuth();
        if (!auth?.token) throw new Error('Not authenticated.');
        const data = await callGithubApi(action, auth.token, payload || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── DOWNLOAD_GAS_PROJECT ──────────────────────────────────────────
  // Pide al endpoint same-origin de GAS el proyecto en formato ZIP usando
  // las cookies de sesión del usuario (host_permissions para
  // script.google.com lo permite). Devuelve el ZIP como ArrayBuffer
  // serializado para que el content/MAIN script lo convierta en blob y
  // dispare la descarga.
  if (msg.type === 'DOWNLOAD_GAS_PROJECT') {
    const scriptId = msg.scriptId;
    if (!scriptId) {
      sendResponse({ ok: false, error: 'Missing scriptId' });
      return true;
    }
    const url = `https://script.google.com/feeds/download/export?id=${encodeURIComponent(scriptId)}&format=json`;

    // Se realiza la petición
    fetch(url, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Google devuelve JSON, no ZIP
      const json = await res.json();
      sendResponse({ ok: true, data: json });
    })
    .catch((err) => {
      console.error('[Background] DOWNLOAD_GAS_PROJECT falló:', err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }
});

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: { hostEquals: 'script.google.com', pathContains: '/edit' },
        }),
      ],
      actions: [new chrome.declarativeContent.ShowAction()],
    }]);
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});