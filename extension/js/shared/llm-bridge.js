"use strict";

/**
 * @fileoverview Bridge LLM compartido (script clásico).
 *
 * Traduce los CustomEvents `GAS_LLM_*` de un documento a mensajes
 * `chrome.runtime` hacia el background y de vuelta. Lo usan:
 *  - El content script del IDE (`main-functions.js`), para el
 *    autocompletado que vive en el MAIN world de la página.
 *  - La página del Side Panel (`extension/html/sidepanel.html`), para el
 *    chat de IA.
 *
 * Seguridad: ninguna respuesta incluye secretos; el background inyecta las
 * API keys (aquí solo viajan `apiKeysSet` booleanos).
 *
 * Contrato (sin cambios respecto al bridge original):
 *  - Petición/respuesta: `GAS_LLM_REQUEST`→`GAS_LLM_RESPONSE`,
 *    `GAS_LLM_GET_CONFIG`/`GAS_LLM_GET_GLOBAL_AI_CONTEXT`→`GAS_LLM_CONFIG_RESULT`,
 *    `GAS_LLM_SAVE_CONFIG` y `GAS_LLM_CANCEL` (sin respuesta).
 *  - Streaming: `GAS_LLM_STREAM_START` abre un Port 'llm-stream'; cada
 *    mensaje se reemite como `GAS_LLM_STREAM_EVENT`. `GAS_LLM_CANCEL` con el
 *    mismo requestId cancela el stream.
 */
const GasLlmBridge = (() => {
  const EVENTS = Object.freeze({
    LLM_REQUEST:               'GAS_LLM_REQUEST',
    LLM_RESPONSE:              'GAS_LLM_RESPONSE',
    LLM_CANCEL:                'GAS_LLM_CANCEL',
    LLM_STREAM_START:          'GAS_LLM_STREAM_START',
    LLM_STREAM_EVENT:          'GAS_LLM_STREAM_EVENT',
    LLM_GET_CONFIG:            'GAS_LLM_GET_CONFIG',
    LLM_GET_GLOBAL_AI_CONTEXT: 'GAS_LLM_GET_GLOBAL_AI_CONTEXT',
    LLM_CONFIG_RESULT:         'GAS_LLM_CONFIG_RESULT',
    LLM_SAVE_CONFIG:           'GAS_LLM_SAVE_CONFIG',
    LLM_CONFIG_UPDATED:        'GAS_LLM_CONFIG_UPDATED',
    LLM_FETCH_MODELS:          'GAS_LLM_FETCH_MODELS',
    LLM_FETCH_MODELS_RESULT:   'GAS_LLM_FETCH_MODELS_RESULT',
  });

  /** Rutas petición → mensaje al background → evento de respuesta. */
  const ROUTES = Object.freeze([
    {
      listenEvent:   EVENTS.LLM_REQUEST,
      responseEvent: EVENTS.LLM_RESPONSE,
      // `requestId` viaja al background para poder cancelar con LLM_CANCEL.
      // `apiKey` se descarta por si un caller legacy aún lo envía.
      buildMessage: ({ apiKey: _ignored, ...rest }) => ({ type: 'LLM_CHAT_REQUEST', payload: rest }),
      buildDetail:  (response, requestId) => ({
        requestId,
        ok:      response?.ok ?? false,
        aborted: response?.aborted ?? false,
        permissionOrigin: response?.permissionOrigin || null,
        content: response?.ok ? (response.content || '') : null,
        // Modo agente (tool calling): llamadas pedidas por el modelo.
        toolCalls:    response?.ok ? (response.toolCalls || []) : [],
        providerData: response?.ok ? (response.providerData || null) : null,
        error:   response?.ok ? null : (response?.error || 'Unknown error'),
      }),
    },
    {
      listenEvent:   EVENTS.LLM_CANCEL,
      responseEvent: null,
      buildMessage:  ({ requestId }) => ({ type: 'LLM_CANCEL', payload: { requestId } }),
      buildDetail:   null,
    },
    {
      listenEvent:   EVENTS.LLM_GET_CONFIG,
      responseEvent: EVENTS.LLM_CONFIG_RESULT,
      buildMessage:  () => ({ type: 'LLM_GET_CONFIG' }),
      buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
    },
    {
      listenEvent:   EVENTS.LLM_GET_GLOBAL_AI_CONTEXT,
      responseEvent: EVENTS.LLM_CONFIG_RESULT,
      buildMessage:  () => ({ type: 'GET_GLOBAL_AI_CONTEXT' }),
      buildDetail:   (data, requestId) => ({ requestId, data: data || null }),
    },
    {
      listenEvent:   EVENTS.LLM_FETCH_MODELS,
      responseEvent: EVENTS.LLM_FETCH_MODELS_RESULT,
      buildMessage:  (payload) => ({ type: 'LLM_FETCH_MODELS', payload }),
      buildDetail:   (response, requestId) => ({
        requestId,
        ok:      response?.ok ?? false,
        models:  response?.models || [],
        error:   response?.error || null,
        permissionOrigin: response?.permissionOrigin || null,
      }),
    },
    {
      listenEvent:   EVENTS.LLM_SAVE_CONFIG,
      responseEvent: null,
      buildMessage:  ({ apiKeys, ...payload }) => ({
        type: 'LLM_SAVE_CONFIG',
        // `apiKeys` legacy se reenvía solo si trae valores (el background lo migra).
        payload: apiKeys ? { ...payload, apiKeys } : payload,
      }),
      buildDetail:   null,
    },
  ]);

  /**
   * Registra rutas y streaming sobre `target`.
   * @param {Object} opts
   * @param {(message:Object, fallback?:*) => Promise<*>} opts.sendToBackground
   * @param {EventTarget} [opts.target=document]
   * @param {() => chrome.runtime.Port} [opts.connect] Abre el Port de streaming.
   * @param {() => boolean} [opts.isContextValid] `false` si la extensión se recargó.
   * @param {string[]} [opts.routes] Lista blanca de `listenEvent` (por defecto, todas).
   * @param {boolean} [opts.stream=true] Registra el streaming por Port.
   * @returns {() => void} Función que desregistra todos los listeners.
   */
  function install({
    sendToBackground,
    target = document,
    connect = () => chrome.runtime.connect({ name: 'llm-stream' }),
    isContextValid = () => { try { return Boolean(chrome?.runtime?.id); } catch (_) { return false; } },
    routes = null,
    stream = true,
  }) {
    const allowed = routes ? new Set(routes) : null;
    const listeners = [];
    const streams = new Map();   // requestId → Port

    const dispatch_ = (eventName, detail) => {
      target.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(detail) }));
    };
    const listen_ = (eventName, handler) => {
      const wrapped = (e) => {
        let payload;
        try { payload = JSON.parse(e.detail); } catch (_) { return; }
        handler(payload || {});
      };
      target.addEventListener(eventName, wrapped);
      listeners.push([eventName, wrapped]);
    };

    // ── Rutas petición/respuesta ──
    for (const { listenEvent, responseEvent, buildMessage, buildDetail } of ROUTES) {
      if (allowed && !allowed.has(listenEvent)) continue;
      listen_(listenEvent, async (payload) => {
        const { requestId, ...rest } = payload;
        const response = await sendToBackground(buildMessage({ ...rest, requestId }));
        if (responseEvent && buildDetail) dispatch_(responseEvent, buildDetail(response, requestId));
      });
    }

    // ── Streaming ──
    const startStream_ = (payload) => {
      const { requestId, apiKey: _ignored, ...rest } = payload;
      if (!requestId) return;
      const emit_ = (detail) => dispatch_(EVENTS.LLM_STREAM_EVENT, { requestId, ...detail });

      if (!isContextValid()) {
        emit_({ type: 'error', error: 'Extension was reloaded. Reload the page.', aborted: false });
        return;
      }

      let port;
      try {
        port = connect();
      } catch (err) {
        emit_({ type: 'error', error: String(err?.message || err), aborted: false });
        return;
      }
      streams.set(requestId, port);

      let finished = false;
      port.onMessage.addListener((msg) => {
        if (msg?.type === 'delta') emit_({ type: 'delta', text: msg.text || '' });
        if (msg?.type === 'done' || msg?.type === 'error') {
          finished = true;
          const { type, ...data } = msg;
          emit_({ type, ...data });
        }
      });
      port.onDisconnect.addListener(() => {
        streams.delete(requestId);
        // Si el SW murió o la extensión se recargó sin respuesta final.
        if (!finished) emit_({ type: 'error', error: 'Connection closed.', aborted: false });
      });
      port.postMessage({ type: 'start', payload: { ...rest, requestId } });
    };

    if (stream) {
      listen_(EVENTS.LLM_STREAM_START, startStream_);
      listen_(EVENTS.LLM_CANCEL, ({ requestId }) => {
        const port = streams.get(requestId);
        if (!port) return;
        try { port.postMessage({ type: 'cancel' }); } catch (_) { /* ya cerrado */ }
      });
    }

    return function uninstall() {
      for (const [eventName, fn] of listeners) target.removeEventListener(eventName, fn);
      listeners.length = 0;
      for (const port of streams.values()) { try { port.disconnect(); } catch (_) { /* noop */ } }
      streams.clear();
    };
  }

  return Object.freeze({ EVENTS, ROUTES, install });
})();

// Export para tests en Node (en el navegador `module` no existe).
if (typeof module !== 'undefined' && module.exports) module.exports = { GasLlmBridge };
