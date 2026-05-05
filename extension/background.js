"use strict";

// Importa el helper de IndexedDB para leer ajustes y snippets del usuario
import { DB } from '../src/js/utils/Storage.js';
// Importa la clave global de storage y los snippets predeterminados de la extensión
import { G_PROPERTY_NAME, DEFAULT_SNIPPETS } from '../src/js/utils/Variables.js';
// Importa las funciones de tema activo y despacho LLM desde el módulo de proveedores
import { getActiveTheme, callLlmProvider } from './js/llmProviders.js';

// ─────────────────────────────────────────────
// MANEJADORES DE MENSAJES
// ─────────────────────────────────────────────

/**
 * Escucha y despacha los mensajes entrantes desde el popup y los content scripts.
 * Cada bloque maneja un tipo de mensaje distinto y responde de forma asíncrona.
 *
 * @listens chrome.runtime.onMessage
 * @param {Object}   msg          - Mensaje recibido con al menos la propiedad `type`.
 * @param {Object}   sender       - Información del remitente (tab, frame, extensión).
 * @param {Function} sendResponse - Callback para enviar la respuesta al remitente.
 * @returns {true} Retorna `true` en todos los casos para mantener el canal abierto de forma asíncrona.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── GET_SETTINGS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SETTINGS') {
    // Lee los ajustes del usuario desde IndexedDB y los devuelve al solicitante
    DB.get('settings', G_PROPERTY_NAME)
      .then(data => sendResponse(data?.options ?? {}))
      // Si falla la lectura, responde con un objeto vacío para no romper el receptor
      .catch(() => sendResponse({}));
    return true;
  }

  // ── GET_SNIPPETS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SNIPPETS') {
    (async () => {
      try {
        // Obtiene todos los snippets guardados por el usuario en IndexedDB
        const userSnippets = await DB.getAll('snippets') || [];
        // Lee la configuración para saber si los snippets por defecto están habilitados
        const settingsData = await DB.get('settings', G_PROPERTY_NAME);
        const isDefaultEnabled = settingsData?.options?.['load-snippets'] === true;
        // Prepende los snippets predeterminados solo si el toggle está activado
        const finalSnippets = isDefaultEnabled
          ? [...DEFAULT_SNIPPETS, ...userSnippets]
          : [...userSnippets];
        sendResponse(finalSnippets);
      } catch (err) {
        console.error('[BG] Error al obtener snippets:', err);
        // Responde con arreglo vacío para que el receptor no quede sin datos
        sendResponse([]);
      }
    })();
    return true;
  }

  // ── GET_ACTIVE_THEME ──────────────────────────────────────────────
  if (msg.type === 'GET_ACTIVE_THEME') {
    // Resuelve el tema activo (lista protegida o IndexedDB) y lo devuelve completo
    getActiveTheme()
      .then(themeData => sendResponse(themeData))
      // Si no se puede resolver el tema, responde con null de forma segura
      .catch(() => sendResponse(null));
    return true;
  }

  // ── NOTIFY_UPDATE ─────────────────────────────────────────────────
  if (msg.type === 'NOTIFY_UPDATE') {
    // Identifica qué recurso cambió: 'settings', 'snippets' o 'themes'
    const updateType = msg.updateType;
    console.log('[Background] NOTIFY_UPDATE recibido, tipo:', updateType);

    /**
     * Envía un payload a todos los tabs del editor de Google Apps Script abiertos.
     *
     * @param {Object} payload - Datos actualizados a reenviar a los content scripts.
     */
    const sendToTabs = (payload) => {
      // Filtra solo las pestañas que coinciden con la URL del editor de GAS
      chrome.tabs.query({ url: 'https://script.google.com/home/projects/*/edit*' }, (tabs) => {
        console.log('[Background] Tabs encontrados:', tabs.length);
        tabs.forEach(tab => {
          // Envía el mensaje a cada tab; ignora errores si el content script no está listo
          chrome.tabs.sendMessage(tab.id, {
            type: 'SETTINGS_UPDATED',
            payload: { ...payload, updateType },
          }).catch(err => {
            console.log('[Background] No se pudo enviar al tab:', tab.id, err.message);
          });
        });
      });
    };

    if (updateType === 'settings') {
      // Lee los ajustes actualizados y los reenvía a los tabs del editor
      DB.get('settings', G_PROPERTY_NAME).then(settingsData => {
        console.log('[Background] Enviando settings');
        sendToTabs({ options: settingsData?.options ?? {} });
      });

    } else if (updateType === 'snippets') {
      (async () => {
        try {
          // Reconstruye la lista final de snippets con la misma lógica que GET_SNIPPETS
          const userSnippets = await DB.getAll('snippets') || [];
          const settingsData = await DB.get('settings', G_PROPERTY_NAME);
          const isDefaultEnabled = settingsData?.options?.['load-snippets'] === true;
          const finalSnippets = isDefaultEnabled
            ? [...DEFAULT_SNIPPETS, ...userSnippets]
            : [...userSnippets];
          console.log('[Background] Enviando snippets, cantidad:', finalSnippets.length);
          sendToTabs({ data: finalSnippets });
        } catch (err) {
          console.error('[Background] Error al obtener snippets:', err);
          // En caso de error, reenvía un arreglo vacío para limpiar el estado en los tabs
          sendToTabs({ data: [] });
        }
      })();

    } else if (updateType === 'themes') {
      // Resuelve el tema activo y lo propaga a todos los tabs del editor
      getActiveTheme().then(themeData => {
        console.log('[Background] Enviando tema:', themeData?.text);
        sendToTabs({ data: themeData });
      });
    }

    // Confirma al popup que el mensaje fue recibido y procesado
    sendResponse({ ok: true });
    return true;
  }

  // ── LLM_GET_CONFIG ────────────────────────────────────────────────
  if (msg.type === 'LLM_GET_CONFIG') {
    // Lee la configuración LLM (proveedor, modelo, API key, system prompt) desde chrome.storage.sync
    chrome.storage.sync.get(['gasToolsLlmConfig'], (result) => {
      // Devuelve null si aún no hay configuración guardada
      sendResponse(result?.gasToolsLlmConfig || null);
    });
    return true;
  }

  // ── LLM_SAVE_CONFIG ───────────────────────────────────────────────
  if (msg.type === 'LLM_SAVE_CONFIG') {
    // Persiste el payload de configuración LLM en chrome.storage.sync
    chrome.storage.sync.set({ gasToolsLlmConfig: msg.payload || {} }, () => {
      // Informa si el guardado fue exitoso comprobando lastError
      sendResponse({ ok: !chrome.runtime.lastError });
    });
    return true;
  }

  // ── GET_GLOBAL_AI_CONTEXT ─────────────────────────────────────────
  if (msg.type === 'GET_GLOBAL_AI_CONTEXT') {
    // Recupera el contexto global de IA (instrucciones compartidas entre chats)
    chrome.storage.sync.get(['gasToolsAiContext'], (result) => {
      // Devuelve null si todavía no se ha definido ningún contexto
      sendResponse(result['gasToolsAiContext'] || null);
    });
    return true;
  }

  // ── LLM_CHAT_REQUEST ──────────────────────────────────────────────
  if (msg.type === 'LLM_CHAT_REQUEST') {
    // El background ejecuta el fetch al proveedor LLM para evitar restricciones CORS
    // y para que las API keys nunca queden expuestas en el contexto MAIN de la página
    callLlmProvider(msg.payload || {})
      .then((content) => sendResponse({ ok: true, content }))
      // Serializa el error a string para que sea transferible como mensaje
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

});

// ─────────────────────────────────────────────
// REGLA DE PAGE ACTION
// ─────────────────────────────────────────────

/**
 * Registra la regla declarativa que activa el ícono de la extensión
 * solo cuando el tab activo es el editor de Google Apps Script.
 * Se ejecuta una sola vez al instalar o actualizar la extensión.
 *
 * @listens chrome.runtime.onInstalled
 */
chrome.runtime.onInstalled.addListener(() => {
  // Elimina cualquier regla anterior para evitar duplicados tras una actualización
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [
        // Activa el page action solo en URLs que coincidan con el editor de GAS
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: { urlContains: 'https://script.google.com/home/projects/*/edit*' },
        }),
      ],
      // Muestra el ícono de la extensión en la barra del navegador al cumplirse la condición
      actions: [new chrome.declarativeContent.ShowPageAction()],
    }]);
  });
});