"use strict";

// Importa el nombre de la propiedad global usada como clave en chrome.storage
import { G_PROPERTY_NAME } from '../../../src/js/utils/Variables.js';
// Importa la lista de temas predefinidos (protegidos)
import { THEME_LIST } from '../../../src/js/utils/Themes.js';
// Importa el helper de IndexedDB para temas personalizados
import { DB } from '../../../src/js/utils/Storage.js';
// Helper compartido para construir errores HTTP legibles
import { readHttpError } from './_http-utils.js';

/**
 * Resuelve el tema activo desde chrome.storage y, si es necesario, desde IndexedDB.
 * Si el tema es protegido y no tiene datos incrustados, los descarga como JSON.
 *
 * @async
 * @returns {Promise<Object|null>} Entrada del tema activo, o `null` si no se encuentra o falla.
 */
export async function getActiveTheme() {
  try {
    // Lee la configuración sincronizada del usuario desde chrome.storage
    const result = await new Promise((resolve) =>
      chrome.storage.sync.get([G_PROPERTY_NAME], resolve)
    );

    // Obtiene el ID del tema activo; usa 'vs-dark' si no hay ninguno configurado
    const activeId = result[G_PROPERTY_NAME]?.themes?.active ?? 'vs-dark';

    // Busca primero en los temas protegidos; si no aparece, consulta IndexedDB
    let themeEntry =
      THEME_LIST.find((t) => t.value === activeId) ??
      (await DB.getAll('themes')).find((t) => t.value === activeId);

    // Si no existe en ninguna fuente, no hay tema que resolver
    if (!themeEntry) return null;

    // Si el tema es protegido pero aún no tiene datos JSON, los descarga
    if (themeEntry.protected && !themeEntry.data) {
      const data = await fetchThemeJson(themeEntry.text);
      // Crea una copia del objeto para no mutar la referencia original
      themeEntry = { ...themeEntry, data };
    }

    return themeEntry;
  } catch (err) {
    console.error('[LLM Providers] Error al resolver el tema activo:', err);
    return null;
  }
}

/**
 * Descarga el archivo JSON de definición de un tema desde la carpeta `/themes`.
 *
 * @async
 * @param {string} themeText - Nombre del tema (sin extensión).
 * @returns {Promise<Object|null>} Objeto JSON del tema, o `null` si falla la descarga.
 */
async function fetchThemeJson(themeText) {
  // Construye la URL absoluta dentro del contexto de la extensión
  const url = chrome.runtime.getURL(`themes/${themeText}.json`);
  try {
    const response = await fetch(url);
    // Lanza un error explícito si el servidor responde con un status no exitoso
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error(`[LLM Providers] No se pudo cargar el JSON del tema "${themeText}":`, err);
    return null;
  }
}

/**
 * Despacha la llamada al proveedor LLM indicado en `cfg.provider`.
 *
 * @async
 * @param {Object}   cfg                  - Configuración de la llamada.
 * @param {string}   cfg.provider         - Identificador del proveedor ('openai', 'anthropic', etc.).
 * @param {string}   cfg.apiKey           - Clave de API del proveedor.
 * @param {string}   cfg.model            - Modelo a utilizar.
 * @param {Array}    cfg.messages         - Arreglo de mensajes en formato chat.
 * @param {number}  [cfg.temperature=0.3] - Temperatura de muestreo (0�1).
 * @returns {Promise<string>} Texto de respuesta generado por el modelo.
 * @throws {Error} Si falta apiKey, provider o messages, o si el provider es desconocido.
 */
export async function callLlmProvider(cfg) {
  const { provider, apiKey, model, messages, temperature = 0.3, endpointUrl } = cfg;

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
      ...compatible,
      apiKey,
      model,
      messages,
      temperature,
    });
  }

  // Custom usa la URL provista por el usuario (LM Studio, Ollama, etc.).
  if (provider === 'custom') {
    if (!endpointUrl) throw new Error('Falta el Endpoint URL para el proveedor Custom.');
    return _callOpenAICompatible({
      url: endpointUrl,
      apiKey,
      model,
      messages,
      temperature,
      // Permitimos apiKey vacía: algunos servidores locales fallan con Authorization vacío.
      allowMissingApiKey: true,
    });
  }

  // Proveedores con contrato propio (no OpenAI-compatible).
  const PROVIDERS = {
    anthropic: () => _callAnthropic(apiKey, model, messages, temperature),
    gemini: () => _callGemini(apiKey, model, messages, temperature),
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
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/chat/completions',
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
 * @param {Object} [cfg.modelMap]           - Diccionario alias� modelId real.
 * @param {boolean}[cfg.requireContent]     - Si true, lanza error cuando no haya `content`.
 * @param {boolean}[cfg.allowMissingApiKey] - Permite Authorization vacío (Custom local).
 * @returns {Promise<string>} Texto de la respuesta del modelo.
 */
async function _callOpenAICompatible(cfg) {
  const {
    url, apiKey, model, messages, temperature,
    extraHeaders, modelMap, requireContent, allowMissingApiKey,
  } = cfg;

  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  // Solo añadimos Authorization si hay apiKey o si no se permite vacía
  if (apiKey || !allowMissingApiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelMap?.[model] ?? model,
      messages,
      // Garantiza un número siempre; 0.3 como fallback seguro
      temperature: typeof temperature === 'number' ? temperature : 0.3,
      stream: false,
    }),
  });

  if (!res.ok) throw await _readErr(res);

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;

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
 * @param {string} apiKey      - Clave de API de Anthropic.
 * @param {string} model       - Identificador del modelo.
 * @param {Array}  messages    - Historial de mensajes (puede incluir role 'system').
 * @param {number} temperature - Temperatura de muestreo.
 * @returns {Promise<string>} Texto concatenado de los bloques de contenido devueltos.
 */
async function _callAnthropic(apiKey, model, messages, temperature) {
  let systemPrompt = '';
  // Separa el mensaje de sistema del resto; Anthropic lo recibe en un campo dedicado
  const userAssistantMsgs = messages.filter((m) => {
    if (m.role === 'system') { systemPrompt = m.content; return false; }
    return true;
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
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
      max_tokens: 4096,
      temperature,
      // Si no hay system prompt, omite el campo para no enviar un string vacío
      system: systemPrompt || undefined,
      messages: userAssistantMsgs,
    }),
  });
  if (!res.ok) throw await _readErr(res);
  // Anthropic puede devolver múltiples bloques de texto; se concatenan todos
  return ((await res.json())?.content ?? []).map((b) => b.text ?? '').join('');
}

/**
 * Realiza una solicitud a la API de Google Gemini (Generative Language).
 * Convierte el rol 'assistant' a 'model' según el formato requerido.
 *
 * @async
 * @param {string} apiKey      - Clave de API de Google.
 * @param {string} model       - Nombre del modelo Gemini.
 * @param {Array}  messages    - Historial de mensajes (puede incluir role 'system').
 * @param {number} temperature - Temperatura de muestreo.
 * @returns {Promise<string>} Texto generado por el modelo.
 */
async function _callGemini(apiKey, model, messages, temperature) {
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

  // La API key y el modelo van codificados directamente en la URL de Gemini
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature },
      // Solo incluye systemInstruction si hay contenido; evita un objeto vacío
      systemInstruction: systemInstruction
        ? { role: 'system', parts: [{ text: systemInstruction }] }
        : undefined,
    }),
  });
  if (!res.ok) throw await _readErr(res);
  // Gemini devuelve partes de texto dentro de candidates; se concatenan todas
  return ((await res.json())?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
}

