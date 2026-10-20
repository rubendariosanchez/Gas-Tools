// Tests de tool calling (extension/js/services/llm-tools.js): traducción de
// mensajes/herramientas por proveedor y parseo de las llamadas devueltas.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callLlmWithTools, toOpenAIMessages_, toAnthropicMessages_, toGeminiContents_,
} from '../extension/js/services/llm-tools.js';

const TOOLS = [{
  name: 'read_file',
  description: 'Read a project file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

// Conversación con una vuelta de herramienta completa.
const HISTORY = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'Fix Code.gs' },
  { role: 'assistant', content: 'Reading it', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'Code.gs' } }] },
  { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'function a() {}' },
];

let calls;
const realFetch = globalThis.fetch;
const mockJson = (body) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// ── Traducción de mensajes ─────────────────────────────────────────────

test('OpenAI: tool_calls con argumentos JSON y mensajes role=tool', () => {
  const out = toOpenAIMessages_(HISTORY);
  assert.equal(out[2].tool_calls[0].function.arguments, '{"path":"Code.gs"}');
  assert.equal(out[2].tool_calls[0].type, 'function');
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c1', content: 'function a() {}' });
});

test('Anthropic: system aparte, tool_use y tool_result agrupados en un turno user', () => {
  const twoResults = [...HISTORY, { role: 'tool', toolCallId: 'c2', name: 'read_file', content: 'x' }];
  const { system, messages } = toAnthropicMessages_(twoResults);
  assert.equal(system, 'sys');
  assert.deepEqual(messages[1].content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(messages[2].role, 'user');
  assert.deepEqual(messages[2].content.map((b) => b.tool_use_id), ['c1', 'c2']);
});

test('Gemini: functionCall/functionResponse y reenvío de parts originales', () => {
  const { systemInstruction, contents } = toGeminiContents_(HISTORY);
  assert.equal(systemInstruction, 'sys');
  assert.equal(contents[1].role, 'model');
  assert.deepEqual(contents[1].parts[1], { functionCall: { name: 'read_file', args: { path: 'Code.gs' } } });
  assert.equal(contents[2].parts[0].functionResponse.name, 'read_file');

  const raw = [{ functionCall: { name: 'read_file', args: {} }, thoughtSignature: 'sig' }];
  const withRaw = toGeminiContents_([{ role: 'user', content: 'u' }, { role: 'assistant', content: '', toolCalls: [], providerData: { geminiParts: raw } }]);
  assert.deepEqual(withRaw.contents[1].parts, raw);
});

// ── Llamadas completas ─────────────────────────────────────────────────

test('OpenAI: envía tools y devuelve toolCalls con args parseados', async () => {
  mockJson({ choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"A.gs"}' } }] } }] });
  const out = await callLlmWithTools({ provider: 'openai', apiKey: 'k', model: 'm', messages: HISTORY, tools: TOOLS });
  assert.equal(calls[0].body.tools[0].function.name, 'read_file');
  assert.equal(calls[0].body.stream, false);
  assert.deepEqual(out.toolCalls, [{ id: 't1', name: 'read_file', args: { path: 'A.gs' } }]);
  assert.equal(out.content, '');
});

test('OpenAI: argumentos no JSON no rompen (se devuelven en _raw)', async () => {
  mockJson({ choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: 'path=A.gs' } }] } }] });
  const out = await callLlmWithTools({ provider: 'openrouter', apiKey: 'k', model: 'm', messages: HISTORY, tools: TOOLS });
  assert.deepEqual(out.toolCalls[0].args, { _raw: 'path=A.gs' });
});

test('Anthropic: input_schema en tools y tool_use → toolCalls', async () => {
  mockJson({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'B.gs' } }] });
  const out = await callLlmWithTools({ provider: 'anthropic', apiKey: 'k', model: 'm', messages: HISTORY, tools: TOOLS });
  assert.ok(calls[0].body.tools[0].input_schema);
  assert.equal(out.content, 'ok');
  assert.deepEqual(out.toolCalls, [{ id: 'tu1', name: 'read_file', args: { path: 'B.gs' } }]);
});

test('Gemini: functionDeclarations y providerData con las parts originales', async () => {
  const parts = [{ text: 'thinking', thought: true }, { functionCall: { name: 'read_file', args: { path: 'C.gs' } }, thoughtSignature: 's' }];
  mockJson({ candidates: [{ content: { parts } }] });
  const out = await callLlmWithTools({ provider: 'gemini', apiKey: 'k', model: 'g', messages: HISTORY, tools: TOOLS });
  assert.equal(calls[0].body.tools[0].functionDeclarations[0].name, 'read_file');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'k');
  assert.equal(out.content, '', 'los pensamientos no se mezclan con el texto');
  assert.equal(out.toolCalls[0].name, 'read_file');
  assert.deepEqual(out.providerData.geminiParts, parts);
});

test('valida herramientas y API key', async () => {
  await assert.rejects(callLlmWithTools({ provider: 'openai', apiKey: '', model: 'm', messages: HISTORY, tools: TOOLS }), /API key/);
  await assert.rejects(callLlmWithTools({ provider: 'openai', apiKey: 'k', model: 'm', messages: HISTORY, tools: [] }), /herramientas/);
});
