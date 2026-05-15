"use strict";
import { DB } from '../src/js/utils/Storage.js';
import { G_PROPERTY_NAME, DEFAULT_SNIPPETS } from '../src/js/utils/Variables.js';
import { getActiveTheme, callLlmProvider } from './js/services/llm-providers.js';

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
    console.log('[Background] Tabs encontrados:', tabs.length);
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        payload,
      }).catch(err => {
        console.log('[Background] No se pudo enviar al tab:', tab.id, err.message);
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
    console.log('[Background] NOTIFY_UPDATE recibido, tipo:', updateType);

    (async () => {
      try {
        if (updateType === 'settings') {
          const settingsData = await DB.get('settings', G_PROPERTY_NAME);
          _sendToTabs({ options: settingsData?.options ?? {}, updateType });

        } else if (updateType === 'snippets') {
          const finalSnippets = await _buildSnippets();
          console.log('[Background] Enviando snippets, cantidad:', finalSnippets.length);
          _sendToTabs({ data: finalSnippets, updateType });

        } else if (updateType === 'themes') {
          const themeData = await getActiveTheme();
          console.log('[Background] Enviando tema:', themeData?.text);
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