"use strict";

// Helper compartido para construir errores HTTP legibles
import { readHttpError } from './http-utils.js';

/**
 * Despacha la llamada al proveedor LLM indicado en `cfg.provider`.
 *
 * @async
 * @param {Object}   cfg                  - Configuración de la llamada.
 * @param {string}   cfg.provider         - Identificador del proveedor ('openai', 'anthropic', etc.).
 * @param {string}   cfg.apiKey           - Clave de API del proveedor.
 * @param {string}   cfg.model            - Modelo a utilizar.
 * @param {Array}    cfg.messages         - Arreglo de mensajes en formato chat.
 * @param {number}  [cfg.temperature=0.3] - Temperatura de muestreo (0-1).
 * @param {number}  [cfg.maxTokens]       - Tope de tokens de salida (el autocompletado usa valores bajos).
 * @param {AbortSignal} [cfg.signal]      - Permite cancelar el fetch (LLM_CANCEL).
 * @param {(text:string) => void} [cfg.onDelta] - Si se pasa, la respuesta se pide en
 *   streaming (SSE) y cada fragmento se entrega aquí. La promesa resuelve igual
 *   con el texto completo.
 * @returns {Promise<string>} Texto de respuesta generado por el modelo.
 * @throws {Error} Si falta apiKey, provider o messages, o si el provider es desconocido.
 */
export async function callLlmProvider(cfg) {
  const { provider, apiKey, model, messages, temperature = 0.3, endpointUrl, signal, onDelta } = cfg;
  const maxTokens = _normalizeMaxTokens_(cfg.maxTokens);

  // Valida que los campos obligatorios estén presentes antes de hacer cualquier llamada
  if (!provider) throw new Error('Provider no especificado.');
  if (provider !== 'custom' && !apiKey) throw new Error('API key vacía.');
  if (!Array.isArray(messages) || !messages.length) throw new Error('No hay mensajes.');

  // Configuración de proveedores compatibles con el formato OpenAI:
  // todos comparten payload `{ model, messages, temperature }` y leen
  // `choices[0].message.content`. Solo cambia URL y headers extra.
  const compatible = OPENAI_COMPATIBLE_PROVIDERS[provider];
  if (compatible) {
    return _callOpenAICompatible({
      ...compatible, apiKey, model, messages, temperature, maxTokens, signal, onDelta,
    });
  }

  // Custom usa la URL provista por el usuario (LM Studio, Ollama, etc.).
  if (provider === 'custom') {
    if (!endpointUrl) throw new Error('Falta el Endpoint URL para el proveedor Custom.');
    if (!/^https?:\/\//i.test(endpointUrl)) throw new Error('El Endpoint URL debe ser http(s).');
    return _callOpenAICompatible({
      url: endpointUrl, apiKey, model, messages, temperature, maxTokens, signal, onDelta,
      // Permitimos apiKey vacía: algunos servidores locales fallan con Authorization vacío.
      allowMissingApiKey: true,
    });
  }

  // Proveedores con contrato propio (no OpenAI-compatible).
  const opts = { apiKey, model, messages, temperature, maxTokens, signal, onDelta };
  const PROVIDERS = {
    anthropic: () => _callAnthropic(opts),
    gemini: () => _callGemini(opts),
  };

  // Busca el handler del proveedor solicitado
  const handler = PROVIDERS[provider];
  // Si el provider no existe en el mapa, lanza un error descriptivo
  if (!handler) throw new Error(`Provider desconocido: ${provider}`);
  return handler();
}

/**
 * Lee el cuerpo de una respuesta HTTP fallida y construye un Error descriptivo.
 *
 * @async
 * @param {Response} res - Objeto `Response` de la Fetch API con status no-ok.
 * @returns {Promise<Error>} Error con el status HTTP y los primeros 240 caracteres del cuerpo.
 */
async function _readErr(res) {
  return readHttpError(res);
}

/**
 * Lee un cuerpo `text/event-stream` y entrega el `data:` de cada evento ya
 * parseado como JSON. Ignora comentarios, líneas vacías y `[DONE]`.
 * Exportado solo para tests.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(data:object) => void} onData
 * @returns {Promise<void>}
 */
export async function readSseStream(body, onData) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushEvent_ = (rawEvent) => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') return;
    let data;
    try { data = JSON.parse(payload); } catch (_) { return; } // fragmento no JSON
    onData(data);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Los eventos SSE se separan por una línea en blanco.
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      flushEvent_(rawEvent);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flushEvent_(buffer);
}

// Anthropic exige `max_tokens`; se usa este valor cuando el caller no lo envía.
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const MAX_ALLOWED_TOKENS = 8192;

/**
 * Normaliza `maxTokens` a un entero en [1, MAX_ALLOWED_TOKENS], o `null`
 * si no se envió (en ese caso cada proveedor usa su comportamiento por defecto).
 * @param {*} value
 * @returns {number|null}
 */
function _normalizeMaxTokens_(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_ALLOWED_TOKENS);
}

/**
 * Tabla de proveedores que respetan el contrato OpenAI (`POST /chat/completions`
 * con `{ model, messages, temperature }` y `choices[0].message.content` en la
 * respuesta). Se procesan todos por `_callOpenAICompatible`.
 *
 * @type {Object<string, {
 *   url: string,
 *   extraHeaders?: Object<string, string>,
 *   modelMap?: Object<string, string>,
 *   requireContent?: boolean
 * }>}
 */
const OPENAI_COMPATIBLE_PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    // Los modelos recientes de OpenAI rechazan `max_tokens`.
    maxTokensField: 'max_completion_tokens',
  },
  chatllm: {
    url: 'https://apps.abacus.ai/v1/chat/completions',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    // Headers opcionales que OpenRouter usa para identificación de la app
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/rubendariosanchez/Gas-Tools',
      'X-Title': 'Gas-Tools Extension',
    },
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    // NVIDIA expone alias cortos pero requiere el ID completo en la request
    modelMap: {
      'deepseek-v4-pro':   'deepseek-ai/deepseek-v4-pro',
      'deepseek-v4-flash': 'deepseek-ai/deepseek-v4',
      'deepseek-chat':     'deepseek-ai/deepseek-r1-0528',
      'deepseek-reasoner': 'deepseek-ai/deepseek-r1',
    },
    // NVIDIA a veces responde 200 OK con choices vacío; se trata como error
    requireContent: true,
  },
};

/**
 * Realiza una solicitud a cualquier endpoint compatible con la API de OpenAI.
 * Maneja URL, headers extra, traducción de alias de modelo y validación de
 * contenido para los proveedores listados en `OPENAI_COMPATIBLE_PROVIDERS`.
 *
 * @async
 * @param {Object} cfg
 * @param {string} cfg.url                  - URL completa del endpoint chat/completions.
 * @param {string} cfg.apiKey               - API key (Bearer); puede ser vacía si `allowMissingApiKey`.
 * @param {string} cfg.model                - Identificador del modelo.
 * @param {Array}  cfg.messages             - Historial de mensajes en formato chat.
 * @param {number} cfg.temperature          - Temperatura de muestreo.
 * @param {Object} [cfg.extraHeaders]       - Headers adicionales (ej. HTTP-Referer).
 * @param {Object} [cfg.modelMap]           - Diccionario alias -> modelId real.
 * @param {boolean}[cfg.requireContent]     - Si true, lanza error cuando no haya `content`.
 * @param {boolean}[cfg.allowMissingApiKey] - Permite Authorization vacío (Custom local).
 * @returns {Promise<string>} Texto de la respuesta del modelo.
 */
async function _callOpenAICompatible(cfg) {
  const {
    url, apiKey, model, messages, temperature, maxTokens, signal, onDelta,
    extraHeaders, modelMap, requireContent, allowMissingApiKey,
    maxTokensField = 'max_tokens',
  } = cfg;

  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  // Solo añadimos Authorization si hay apiKey o si no se permite vacía
  if (apiKey || !allowMissingApiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = {
    model: modelMap?.[model] ?? model,
    messages,
    // Garantiza un número siempre; 0.3 como fallback seguro
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    stream: !!onDelta,
  };
  if (maxTokens) body[maxTokensField] = maxTokens;

  const res = await _fetch_(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await _readErr(res);

  let content;
  if (onDelta && res.body && _isEventStream_(res)) {
    content = '';
    await readSseStream(res.body, (evt) => {
      const piece = evt?.choices?.[0]?.delta?.content;
      if (piece) { content += piece; onDelta(piece); }
    });
  } else {
    // Algunos servidores locales ignoran `stream: true` y responden JSON normal.
    const data = await res.json().catch(() => null);
    content = data?.choices?.[0]?.message?.content;
    if (onDelta && content) onDelta(content);
  }

  if (requireContent && !content) {
    throw new Error('El proveedor respondió sin contenido.');
  }
  return content ?? '';
}

/**
 * Realiza una solicitud a la API de mensajes de Anthropic.
 * Extrae el `system` prompt de la lista de mensajes antes de enviarlos.
 *
 * @async
 * @param {{apiKey:string, model:string, messages:Array, temperature:number, maxTokens:number|null, signal?:AbortSignal}} opts
 * @returns {Promise<string>} Texto concatenado de los bloques de contenido devueltos.
 */
async function _callAnthropic({ apiKey, model, messages, temperature, maxTokens, signal, onDelta }) {
  let systemPrompt = '';
  // Separa el mensaje de sistema del resto; Anthropic lo recibe en un campo dedicado
  const userAssistantMsgs = messages.filter((m) => {
    if (m.role === 'system') { systemPrompt = m.content; return false; }
    return true;
  });

  const res = await _fetch_('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      // Versión del contrato de la API requerida por Anthropic
      'anthropic-version': '2023-06-01',
      // Header necesario para llamadas directas desde el navegador (extensión)
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
      temperature,
      // Si no hay system prompt, omite el campo para no enviar un string vacío
      system: systemPrompt || undefined,
      messages: userAssistantMsgs,
      stream: !!onDelta || undefined,
    }),
  });
  if (!res.ok) throw await _readErr(res);

  if (onDelta && res.body && _isEventStream_(res)) {
    let content = '';
    await readSseStream(res.body, (evt) => {
      if (evt?.type === 'error') throw new Error(evt.error?.message || 'Anthropic stream error');
      const piece = evt?.type === 'content_block_delta' ? evt.delta?.text : null;
      if (piece) { content += piece; onDelta(piece); }
    });
    return content;
  }
  // Anthropic puede devolver múltiples bloques de texto; se concatenan todos
  return ((await res.json())?.content ?? []).map((b) => b.text ?? '').join('');
}

/**
 * Realiza una solicitud a la API de Google Gemini (Generative Language).
 * Convierte el rol 'assistant' a 'model' según el formato requerido.
 *
 * @async
 * @param {{apiKey:string, model:string, messages:Array, temperature:number, maxTokens:number|null, signal?:AbortSignal}} opts
 * @returns {Promise<string>} Texto generado por el modelo.
 */
async function _callGemini({ apiKey, model, messages, temperature, maxTokens, signal, onDelta }) {
  let systemInstruction = '';
  const contents = [];

  for (const m of messages) {
    // Gemini no acepta el rol 'system' dentro de contents; se extrae por separado
    if (m.role === 'system') {
      systemInstruction = m.content;
      continue;
    }
    // Gemini usa 'model' en lugar de 'assistant' para los turnos del asistente
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content ?? '' }],
    });
  }

  // La API key va en header (no en la URL) para no filtrarla en logs/errores.
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
  const url  = onDelta ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
  const generationConfig = { temperature };
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  const res = await _fetch_(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders_(apiKey) },
    body: JSON.stringify({
      contents,
      generationConfig,
      // Solo incluye systemInstruction si hay contenido; evita un objeto vacío
      systemInstruction: systemInstruction
        ? { role: 'system', parts: [{ text: systemInstruction }] }
        : undefined,
    }),
  });
  if (!res.ok) throw await _readErr(res);

  if (onDelta && res.body && _isEventStream_(res)) {
    let content = '';
    await readSseStream(res.body, (evt) => {
      const piece = (evt?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (piece) { content += piece; onDelta(piece); }
    });
    return content;
  }
  // Gemini devuelve partes de texto dentro de candidates; se concatenan todas
  return ((await res.json())?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
}

/**
 * Cabecera de autenticación de Gemini. La key va en cabecera y nunca en la
 * URL (no se filtra en logs/errores).
 * @param {string} apiKey
 * @returns {Object<string,string>}
 */
export function geminiAuthHeaders_(apiKey) {
  return { 'x-goog-api-key': apiKey || '' };
}

/** `true` si la respuesta es Server-Sent Events. */
function _isEventStream_(res) {
  return /text\/event-stream/i.test(res.headers?.get?.('content-type') || '');
}

/**
 * `fetch` con errores de red legibles. "Failed to fetch" no dice nada al
 * usuario: lo traducimos a qué servidor no respondió y qué revisar
 * (servidor local apagado, puerto/URL incorrectos, sin conexión).
 * Los AbortError se propagan tal cual (cancelación).
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function _fetch_(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    let origin = String(url);
    let isLocal = false;
    try {
      const u = new URL(url);
      origin = u.origin;
      isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch (_) { /* URL inválida: se muestra tal cual */ }
    const hint = isLocal
      ? 'Make sure the local server is running (LM Studio: Developer → Start Server; Ollama: ollama serve) and that the endpoint URL and port are correct.'
      : 'Check your internet connection and try again.';
    // Pista en línea aparte: el chat la muestra como sugerencia bajo el error.
    const error = new Error(`Could not connect to ${origin}.\n${hint}`);
    error.cause = err;
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH Y FILTRADO DE MODELOS DISPONIBLES POR PROVEEDOR
// ─────────────────────────────────────────────────────────────────────────────

/** Palabras clave y prefijos excluidos (no aptos para chat o generación de código). */
const EXCLUDED_MODEL_PATTERNS = [
  'embedding', 'whisper', 'tts', 'dall-e', 'moderation', 'realtime',
  'transcription', 'diarization', 'search', 'babbage', 'davinci', 'canary',
  'aqa', 'imagen', 'text-search', 'rerank',
];

function _isExcludedModel_(id) {
  const lower = String(id).toLowerCase();
  return EXCLUDED_MODEL_PATTERNS.some((pat) => lower.includes(pat));
}

/**
 * Consulta la lista de modelos del proveedor y filtra los más adecuados para código/chat.
 * @param {Object} opts
 * @param {string} opts.provider
 * @param {string} [opts.apiKey]
 * @param {string} [opts.endpointUrl]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string[]>}
 */
export async function fetchProviderModels({ provider, apiKey, endpointUrl, signal }) {
  if (!provider) throw new Error('Provider no especificado.');
  if (provider !== 'custom' && provider !== 'openrouter' && !apiKey) {
    throw new Error('API key requerida para consultar modelos.');
  }

  switch (provider) {
    case 'openai': {
      const res = await _fetch_('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal,
      });
      if (!res.ok) await readHttpError(res, 'OpenAI');
      const data = await res.json();
      const list = (data?.data || []).map((m) => m.id);
      return list.filter((id) => {
        if (_isExcludedModel_(id)) return false;
        const lower = id.toLowerCase();
        return lower.startsWith('gpt-4') || lower.startsWith('gpt-5') || lower.startsWith('o1') ||
               lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('chatgpt-') ||
               lower.includes('code');
      });
    }

    case 'gemini': {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
      const res = await _fetch_(url, { signal, headers: geminiAuthHeaders_(apiKey) });
      if (!res.ok) await readHttpError(res, 'Gemini');
      const data = await res.json();
      return (data?.models || [])
        .filter((m) => {
          const id = (m.name || '').replace(/^models\//, '');
          if (_isExcludedModel_(id)) return false;
          const methods = m.supportedGenerationMethods || [];
          return methods.includes('generateContent') && id.toLowerCase().includes('gemini');
        })
        .map((m) => (m.name || '').replace(/^models\//, ''));
    }

    case 'anthropic': {
      const res = await _fetch_('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal,
      });
      if (!res.ok) await readHttpError(res, 'Anthropic');
      const data = await res.json();
      return (data?.data || [])
        .map((m) => m.id)
        .filter((id) => id.toLowerCase().includes('claude') && !_isExcludedModel_(id));
    }

    case 'openrouter': {
      const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
      const res = await _fetch_('https://openrouter.ai/api/v1/models', { headers, signal });
      if (!res.ok) await readHttpError(res, 'OpenRouter');
      const data = await res.json();
      const all = data?.data || [];
      const relevant = all.filter((m) => {
        const id = (m.id || '').toLowerCase();
        if (_isExcludedModel_(id)) return false;
        const desc = (m.description || '').toLowerCase();
        return id.includes('coder') || id.includes('code') || desc.includes('code') ||
               id.startsWith('anthropic/claude-') || id.startsWith('openai/gpt-') ||
               id.startsWith('openai/o') || id.startsWith('google/gemini-') ||
               id.startsWith('deepseek/deepseek-') || id.startsWith('qwen/qwen') ||
               id.startsWith('meta-llama/llama-3') || id.startsWith('mistralai/');
      });
      return relevant.slice(0, 35).map((m) => m.id);
    }

    case 'custom': {
      if (!endpointUrl) throw new Error('Falta el Endpoint URL para el proveedor Custom.');
      let baseUrl = endpointUrl;
      let origin = '';
      try {
        const u = new URL(endpointUrl);
        origin = u.origin;
        baseUrl = u.origin + (u.pathname.includes('/v1') ? u.pathname.replace(/\/chat\/completions\/?$/, '') : '');
      } catch (_) { /* si falla parsing, se usa tal cual */ }

      // 1. Intentar endpoint compatible OpenAI /v1/models
      try {
        const targetUrl = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/models`;
        const headers = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
        const res = await _fetch_(targetUrl, { headers, signal });
        if (res.ok) {
          const data = await res.json();
          const list = (data?.data || []).map((m) => m.id).filter(Boolean);
          if (list.length) return list;
        }
      } catch (_) {}

      // 2. Si es Ollama (/api/tags)
      if (origin) {
        try {
          const res = await _fetch_(`${origin}/api/tags`, { signal });
          if (res.ok) {
            const data = await res.json();
            const list = (data?.models || []).map((m) => m.name).filter(Boolean);
            if (list.length) return list;
          }
        } catch (_) {}
      }

      throw new Error(`No se pudieron obtener modelos desde ${endpointUrl}. Verifica que el servidor esté activo.`);
    }

    case 'nvidia': {
      const res = await _fetch_('https://integrate.api.nvidia.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal,
      });
      if (!res.ok) await readHttpError(res, 'NVIDIA');
      const data = await res.json();
      return (data?.data || [])
        .map((m) => m.id)
        .filter((id) => !_isExcludedModel_(id));
    }

    default:
      throw new Error(`Proveedor ${provider} no soporta listar modelos automáticamente.`);
  }
}

// Helpers compartidos con `llm-tools.js` (tool calling). Se exportan con
// otro nombre para dejar claro que son internos del módulo de proveedores.
export {
  _fetch_ as fetchLlm_,
  _readErr as readLlmError_,
  _normalizeMaxTokens_ as normalizeMaxTokens_,
  OPENAI_COMPATIBLE_PROVIDERS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
};
