"use strict";

/**
 * @fileoverview Tool calling (function calling) para el modo agente del chat.
 *
 * Una sola vuelta, sin streaming: el bucle del agente vive en el Side Panel
 * (ejecuta las herramientas contra el editor y vuelve a llamar).
 *
 * Formato normalizado de mensajes (independiente del proveedor):
 *   { role: 'system'|'user', content }
 *   { role: 'assistant', content, toolCalls?: [{ id, name, args }], providerData? }
 *   { role: 'tool', toolCallId, name, content }
 * Herramientas: [{ name, description, parameters (JSON Schema) }].
 * Resultado: { content, toolCalls: [{ id, name, args }], providerData }.
 *
 * `providerData` guarda lo que el proveedor exige reenviar tal cual en la
 * siguiente vuelta (p. ej. las `parts` de Gemini con `thoughtSignature`).
 */

import {
  fetchLlm_,
  readLlmError_,
  normalizeMaxTokens_,
  OPENAI_COMPATIBLE_PROVIDERS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  geminiAuthHeaders_,
} from './llm-providers.js';

/** Proveedores con tool calling fiable (el resto usa bloques de edición). */
export const TOOL_CAPABLE_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'openrouter']);

/**
 * Llama al proveedor con herramientas disponibles.
 * @param {Object} cfg
 * @param {string} cfg.provider
 * @param {string} cfg.apiKey
 * @param {string} cfg.model
 * @param {Array}  cfg.messages  Mensajes normalizados.
 * @param {Array}  cfg.tools     [{ name, description, parameters }].
 * @param {number} [cfg.temperature]
 * @param {number} [cfg.maxTokens]
 * @param {string} [cfg.endpointUrl]  Solo `custom`.
 * @param {AbortSignal} [cfg.signal]
 * @returns {Promise<{content:string, toolCalls:Array, providerData:Object|null}>}
 */
export async function callLlmWithTools(cfg) {
  const { provider, apiKey, tools } = cfg;
  if (!provider) throw new Error('Provider no especificado.');
  if (provider !== 'custom' && !apiKey) throw new Error('API key vacía.');
  if (!Array.isArray(cfg.messages) || !cfg.messages.length) throw new Error('No hay mensajes.');
  if (!Array.isArray(tools) || !tools.length) throw new Error('No hay herramientas.');

  const opts = {
    ...cfg,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2,
    maxTokens: normalizeMaxTokens_(cfg.maxTokens),
  };

  if (provider === 'anthropic') return _toolsAnthropic_(opts);
  if (provider === 'gemini') return _toolsGemini_(opts);

  const compatible = OPENAI_COMPATIBLE_PROVIDERS[provider];
  if (compatible) return _toolsOpenAI_({ ...compatible, ...opts });
  if (provider === 'custom') {
    if (!/^https?:\/\//i.test(cfg.endpointUrl || '')) throw new Error('El Endpoint URL debe ser http(s).');
    return _toolsOpenAI_({ ...opts, url: cfg.endpointUrl, allowMissingApiKey: true });
  }
  throw new Error(`Provider desconocido: ${provider}`);
}

/** Parsea argumentos JSON de forma tolerante (algunos modelos devuelven texto). */
function _parseArgs_(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch (_) { return { _raw: String(raw ?? '') }; }
}

let G_CALL_SEQ = 0;
const _newCallId_ = () => `call_${Date.now().toString(36)}_${(G_CALL_SEQ++).toString(36)}`;

// ─────────────────────────────────────────────
// OPENAI-COMPATIBLE (OpenAI, OpenRouter, NVIDIA, Abacus, local)
// ─────────────────────────────────────────────

/** @returns {Array} mensajes en formato OpenAI chat/completions. */
export function toOpenAIMessages_(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      };
    }
    return { role: m.role, content: String(m.content ?? '') };
  });
}

async function _toolsOpenAI_(cfg) {
  const {
    url, apiKey, model, messages, tools, temperature, maxTokens, signal,
    extraHeaders, modelMap, allowMissingApiKey, maxTokensField = 'max_tokens',
  } = cfg;

  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (apiKey || !allowMissingApiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model: modelMap?.[model] ?? model,
    messages: toOpenAIMessages_(messages),
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: 'auto',
    temperature,
    stream: false,
  };
  if (maxTokens) body[maxTokensField] = maxTokens;

  const res = await fetchLlm_(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
  if (!res.ok) throw await readLlmError_(res);
  const msg = (await res.json().catch(() => null))?.choices?.[0]?.message || {};

  return {
    content: msg.content || '',
    toolCalls: (msg.tool_calls || [])
      .filter((c) => c?.function?.name)
      .map((c) => ({ id: c.id || _newCallId_(), name: c.function.name, args: _parseArgs_(c.function.arguments) })),
    providerData: null,
  };
}

// ─────────────────────────────────────────────
// ANTHROPIC
// ─────────────────────────────────────────────

/**
 * @returns {{system:string, messages:Array}} formato Messages API. Los
 * resultados de herramientas consecutivos se agrupan en un único turno
 * `user` (Anthropic exige alternancia user/assistant).
 */
export function toAnthropicMessages_(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { system = system ? `${system}\n\n${m.content}` : String(m.content ?? ''); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({ role: m.role, content: String(m.content ?? '') });
  }
  return { system, messages: out };
}

async function _toolsAnthropic_({ apiKey, model, messages, tools, temperature, maxTokens, signal }) {
  const { system, messages: converted } = toAnthropicMessages_(messages);
  const res = await fetchLlm_('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
      temperature,
      system: system || undefined,
      messages: converted,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    }),
  });
  if (!res.ok) throw await readLlmError_(res);
  const blocks = (await res.json())?.content ?? [];
  return {
    content: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id || _newCallId_(), name: b.name, args: b.input ?? {} })),
    providerData: null,
  };
}

// ─────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────

/**
 * @returns {{systemInstruction:string, contents:Array}} formato Gemini. Las
 * `parts` originales del modelo (con `thoughtSignature`) se reenvían tal
 * cual desde `providerData.geminiParts` cuando existen.
 */
export function toGeminiContents_(messages) {
  let systemInstruction = '';
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') { systemInstruction = systemInstruction ? `${systemInstruction}\n\n${m.content}` : String(m.content ?? ''); continue; }
    if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: { content: String(m.content ?? '') } } };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (m.role === 'assistant') {
      const raw = m.providerData?.geminiParts;
      if (Array.isArray(raw) && raw.length) { contents.push({ role: 'model', parts: raw }); continue; }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: String(m.content ?? '') }] });
  }
  return { systemInstruction, contents };
}

async function _toolsGemini_({ apiKey, model, messages, tools, temperature, maxTokens, signal }) {
  const { systemInstruction, contents } = toGeminiContents_(messages);
  const generationConfig = { temperature };
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetchLlm_(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders_(apiKey) },
    body: JSON.stringify({
      contents,
      generationConfig,
      tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
      systemInstruction: systemInstruction ? { role: 'system', parts: [{ text: systemInstruction }] } : undefined,
    }),
  });
  if (!res.ok) throw await readLlmError_(res);
  const parts = (await res.json())?.candidates?.[0]?.content?.parts ?? [];
  const toolCalls = parts
    .filter((p) => p.functionCall?.name)
    .map((p) => ({ id: _newCallId_(), name: p.functionCall.name, args: p.functionCall.args ?? {} }));
  return {
    content: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(''),
    toolCalls,
    // Gemini 2.5+ exige reenviar las parts originales (thoughtSignature).
    providerData: toolCalls.length ? { geminiParts: parts } : null,
  };
}
