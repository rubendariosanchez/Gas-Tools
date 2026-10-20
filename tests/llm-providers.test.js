// Tests de extension/js/services/llm-providers.js (módulo ES del background).
// Se mockea `fetch` para inspeccionar los payloads y simular respuestas SSE.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLlmProvider, readSseStream, fetchProviderModels } from '../extension/js/services/llm-providers.js';

const MESSAGES = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hola' },
];

let calls;
const realFetch = globalThis.fetch;

/** Crea un ReadableStream que emite los chunks dados (strings). */
function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(chunks) {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function mockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return responder(call);
  };
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// ── readSseStream ──────────────────────────────────────────────────────

test('readSseStream une eventos partidos entre chunks e ignora [DONE]', async () => {
  const got = [];
  await readSseStream(
    streamOf(['data: {"a":1}\n\nda', 'ta: {"a":2}\r\n\r\n: comentario\n\ndata: [DONE]\n\n']),
    (d) => got.push(d.a)
  );
  assert.deepEqual(got, [1, 2]);
});

test('readSseStream propaga errores lanzados por el callback', async () => {
  await assert.rejects(
    readSseStream(streamOf(['data: {"x":1}\n\n']), () => { throw new Error('boom'); }),
    /boom/
  );
});

// ── Validaciones ───────────────────────────────────────────────────────

test('exige API key salvo en custom', async () => {
  await assert.rejects(callLlmProvider({ provider: 'openai', model: 'm', messages: MESSAGES }), /API key/);
});

test('custom rechaza endpoints que no son http(s)', async () => {
  await assert.rejects(
    callLlmProvider({ provider: 'custom', endpointUrl: 'file:///etc/passwd', model: 'm', messages: MESSAGES }),
    /http\(s\)/
  );
});

// ── Payloads ───────────────────────────────────────────────────────────

test('OpenAI usa max_completion_tokens y no envía límite si no se pide', async () => {
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));

  assert.equal(await callLlmProvider({ provider: 'openai', apiKey: 'k', model: 'm', messages: MESSAGES, maxTokens: 128 }), 'ok');
  assert.equal(calls[0].body.max_completion_tokens, 128);
  assert.equal(calls[0].body.max_tokens, undefined);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');

  await callLlmProvider({ provider: 'openai', apiKey: 'k', model: 'm', messages: MESSAGES });
  assert.equal(calls[1].body.max_completion_tokens, undefined);
});

test('proveedores compatibles usan max_tokens y aplican modelMap', async () => {
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await callLlmProvider({ provider: 'nvidia', apiKey: 'k', model: 'deepseek-chat', messages: MESSAGES, maxTokens: 50 });
  assert.equal(calls[0].body.max_tokens, 50);
  assert.equal(calls[0].body.model, 'deepseek-ai/deepseek-r1-0528');
});

test('maxTokens se limita a 8192', async () => {
  mockFetch(() => jsonResponse({ content: [{ text: 'ok' }] }));
  await callLlmProvider({ provider: 'anthropic', apiKey: 'k', model: 'm', messages: MESSAGES, maxTokens: 999999 });
  assert.equal(calls[0].body.max_tokens, 8192);
});

test('Anthropic separa el system prompt y usa 4096 por defecto', async () => {
  mockFetch(() => jsonResponse({ content: [{ text: 'a' }, { text: 'b' }] }));
  const out = await callLlmProvider({ provider: 'anthropic', apiKey: 'k', model: 'm', messages: MESSAGES });
  assert.equal(out, 'ab');
  assert.equal(calls[0].body.system, 'sys');
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'hola' }]);
});

test('Gemini envía la key por header, no en la URL', async () => {
  mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await callLlmProvider({ provider: 'gemini', apiKey: 'secret', model: 'g', messages: MESSAGES, maxTokens: 64 });
  assert.ok(!calls[0].url.includes('secret'));
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'secret');
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 64);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'sys');
});

// ── Streaming ──────────────────────────────────────────────────────────

test('streaming OpenAI-compatible entrega deltas y devuelve el total', async () => {
  mockFetch(() => sseResponse([
    'data: {"choices":[{"delta":{"content":"Ho"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"la"}}]}\n\ndata: [DONE]\n\n',
  ]));
  const deltas = [];
  const out = await callLlmProvider({
    provider: 'openai', apiKey: 'k', model: 'm', messages: MESSAGES, onDelta: (t) => deltas.push(t),
  });
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(deltas, ['Ho', 'la']);
  assert.equal(out, 'Hola');
});

test('streaming con servidor que ignora stream:true cae a JSON', async () => {
  mockFetch(() => jsonResponse({ choices: [{ message: { content: 'todo junto' } }] }));
  const deltas = [];
  const out = await callLlmProvider({
    provider: 'custom', endpointUrl: 'http://localhost:1234/v1/chat/completions',
    model: 'm', messages: MESSAGES, onDelta: (t) => deltas.push(t),
  });
  assert.equal(out, 'todo junto');
  assert.deepEqual(deltas, ['todo junto']);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('streaming Anthropic solo toma content_block_delta', async () => {
  mockFetch(() => sseResponse([
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]));
  const deltas = [];
  const out = await callLlmProvider({
    provider: 'anthropic', apiKey: 'k', model: 'm', messages: MESSAGES, onDelta: (t) => deltas.push(t),
  });
  assert.equal(calls[0].body.stream, true);
  assert.equal(out, 'Hi');
  assert.deepEqual(deltas, ['Hi']);
});

test('streaming Anthropic propaga eventos de error', async () => {
  mockFetch(() => sseResponse(['data: {"type":"error","error":{"message":"overloaded"}}\n\n']));
  await assert.rejects(
    callLlmProvider({ provider: 'anthropic', apiKey: 'k', model: 'm', messages: MESSAGES, onDelta: () => {} }),
    /overloaded/
  );
});

test('streaming Gemini usa streamGenerateContent con alt=sse', async () => {
  mockFetch(() => sseResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}]}\n\n',
  ]));
  const out = await callLlmProvider({ provider: 'gemini', apiKey: 'k', model: 'g', messages: MESSAGES, onDelta: () => {} });
  assert.match(calls[0].url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(out, 'AB');
});

test('una señal abortada cancela la petición', async () => {
  mockFetch(() => jsonResponse({}));
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    callLlmProvider({ provider: 'openai', apiKey: 'k', model: 'm', messages: MESSAGES, signal: ctrl.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('un error de red hacia un servidor local explica qué revisar', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    callLlmProvider({ provider: 'custom', endpointUrl: 'http://localhost:1234/v1/chat/completions', model: 'm', messages: MESSAGES }),
    (err) => /Could not connect to http:\/\/localhost:1234/.test(err.message) && /LM Studio/.test(err.message)
  );
});

test('un error de red hacia un proveedor remoto sugiere revisar la conexión', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    callLlmProvider({ provider: 'openai', apiKey: 'k', model: 'm', messages: MESSAGES }),
    /Could not connect to https:\/\/api\.openai\.com\.\nCheck your internet connection/
  );
});

// ── fetchProviderModels ────────────────────────────────────────────────

test('fetchProviderModels para OpenAI filtra solo modelos de código/chat', async () => {
  mockFetch(() => jsonResponse({
    data: [
      { id: 'gpt-4o' },
      { id: 'o1-preview' },
      { id: 'text-embedding-3-small' },
      { id: 'dall-e-3' },
      { id: 'whisper-1' },
      { id: 'gpt-4o-realtime-preview' },
      { id: 'gpt-4.1' },
    ],
  }));

  const models = await fetchProviderModels({ provider: 'openai', apiKey: 'sk-test' });
  assert.deepEqual(models, ['gpt-4o', 'o1-preview', 'gpt-4.1']);
});

test('fetchProviderModels para Gemini filtra generateContent y remueve prefijo models/', async () => {
  mockFetch(() => jsonResponse({
    models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
    ],
  }));

  const models = await fetchProviderModels({ provider: 'gemini', apiKey: 'AIza-test' });
  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
});

test('fetchProviderModels para Anthropic filtra modelos claude', async () => {
  mockFetch(() => jsonResponse({
    data: [
      { id: 'claude-3-7-sonnet-20250219' },
      { id: 'claude-3-5-haiku-20241022' },
      { id: 'other-model' },
    ],
  }));

  const models = await fetchProviderModels({ provider: 'anthropic', apiKey: 'sk-ant-test' });
  assert.deepEqual(models, ['claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']);
});

