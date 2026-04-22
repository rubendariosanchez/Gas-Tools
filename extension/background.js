"use strict";
import { DB } from '../src/js/utils/Storage.js';
import { G_PROPERTY_NAME, DEFAULT_SNIPPETS } from '../src/js/utils/Variables.js';
import { THEME_LIST } from '../src/js/utils/Themes.js';

// ─────────────────────────────────────────────
// MESSAGE HANDLERS
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // El content script solicita la configuración actual (toggles del popup).
  if (msg.type === 'GET_SETTINGS') {
    DB.get('settings', G_PROPERTY_NAME)
      .then(data => sendResponse(data?.options ?? {}))
      .catch(() => sendResponse({}));
    return true;
  }

  // El script inyectado solicita todos los snippets personalizados del usuario.
  if (msg.type === 'GET_SNIPPETS') {
    (async () => {
      try {
        // 1. Obtenemos los snippets del usuario de la DB
        const userSnippets = await DB.getAll('snippets') || [];
        
        // 2. Obtenemos la configuración para ver si "load-snippets" está activo
        const settingsData = await DB.get('settings', G_PROPERTY_NAME);
        const isDefaultEnabled = settingsData?.options?.['load-snippets'] === true;

        // 3. Combinamos si es necesario
        let finalSnippets = [...userSnippets];
        
        if (isDefaultEnabled) {
          // DEFAULT_SNIPPETS debe ser un array definido en tus constantes
          // Usamos un Map o Filter para evitar duplicados por prefijo si lo deseas
          finalSnippets = [...DEFAULT_SNIPPETS, ...userSnippets];
        }

        sendResponse(finalSnippets);
      } catch (error) {
        console.error("[BG] Error fetching snippets:", error);
        sendResponse([]);
      }
    })();
    return true;
  }

  // El script inyectado solicita el tema activo completo (incluyendo colores y reglas).
  if (msg.type === 'GET_ACTIVE_THEME') {
    _resolveActiveTheme()
      .then(themeData => sendResponse(themeData))
      .catch(() => sendResponse(null));
    return true;
  }

  // El popup avisa que hubo un cambio — reenviamos al tab activo.
  if (msg.type === 'NOTIFY_UPDATE') {
    DB.get('settings', G_PROPERTY_NAME).then(settingsData => {
      const options = settingsData?.options ?? {};
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'SETTINGS_UPDATED',
          payload: { options, updateType: msg.updateType }
        });
      });
    });
    sendResponse({ ok: true });
    return true;
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Resuelve el tema activo completo:
 *  1. Lee el ID del tema activo desde chrome.storage.sync
 *  2. Busca primero en THEME_LIST (protegidos)
 *  3. Si no, busca en IndexedDB (personalizados)
 *  4. Si es protegido y no tiene JSON, lo carga desde /themes/*.json
 *
 * @returns {Promise<Object|null>}
 */
async function _resolveActiveTheme() {
  try {
    // 1. Obtener el ID activo
    const result = await new Promise(res =>
      chrome.storage.sync.get([G_PROPERTY_NAME], res)
    );
    const activeId = result[G_PROPERTY_NAME]?.themes?.active || 'vs-dark';

    // 2. Buscar en temas del sistema
    let themeEntry = THEME_LIST.find(t => t.value === activeId);

    // 3. Si no está, buscar en IndexedDB
    if (!themeEntry) {
      const customThemes = await DB.getAll('themes');
      themeEntry = customThemes.find(t => t.value === activeId);
    }

    if (!themeEntry) return null;

    // 4. Si es protegido y no tiene JSON incrustado, cargarlo desde el archivo
    if (themeEntry.protected && !themeEntry.data) {
      themeEntry = {
        ...themeEntry,
        data: await _fetchThemeJson(themeEntry.text)
      };
    }

    return themeEntry;
  } catch (err) {
    console.error('[Background] Error resolving active theme:', err);
    return null;
  }
}

/**
 * Carga el JSON de definición de un tema desde la carpeta /themes.
 * @param {string} themeText - Nombre legible del tema (ej: "Monokai")
 * @returns {Promise<Object|null>}
 */
async function _fetchThemeJson(themeText) {
  const fileName = themeText.replace(/\s+/g, '');
  const url = chrome.runtime.getURL(`themes/${fileName}.json`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error(`[Background] Could not load theme JSON for "${themeText}":`, err);
    return null;
  }
}

// ─────────────────────────────────────────────
// PAGE ACTION RULE
// ─────────────────────────────────────────────

/**
 * Muestra el icono de la extensión solo en el editor de Google Apps Script.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: { urlContains: 'https://script.google.com/home/projects/*/edit*' }
        })
      ],
      actions: [new chrome.declarativeContent.ShowPageAction()]
    }]);
  });
});