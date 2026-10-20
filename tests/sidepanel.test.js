// Tests del Side Panel: bridge LLM compartido (extension/js/shared/llm-bridge.js)
// y adaptador remoto del editor (extension/js/sidepanel/remote-editor.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Carga un script clásico en un contexto vm y devuelve el global indicado. */
function loadClassic(rel, globalName) {
  const src = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const ctx = { CustomEvent, EventTarget, console };
  vm.runInNewContext(`${src}\n;globalThis.${globalName} = ${globalName};`, ctx);
  return ctx[globalName];
}

const GasLlmBridge = loadClassic('extension/js/shared/llm-bridge.js', 'GasLlmBridge');
const GasRemoteEditor = loadClassic('extension/js/sidepanel/remote-editor.js', 'GasRemoteEditor');

/** deepEqual tolerante a objetos de otro realm (vm). */
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Captura los eventos emitidos en un EventTarget. */
function capture(target, eventName) {
  const got = [];
  target.addEventListener(eventName, (e) => got.push(JSON.parse(e.detail)));
  return got;
}
const emit = (target, name, detail) => target.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));

// ── llm-bridge ─────────────────────────────────────────────────────────

test('ruta GET_CONFIG: reenvía al background y responde con el mismo requestId', async () => {
  const target = new EventTarget();
  const sent = [];
  const uninstall = GasLlmBridge.install({
    target,
    sendToBackground: async (msg) => { sent.push(msg); return { provider: 'openai', apiKeysSet: { openai: true } }; },
  });
  const results = capture(target, 'GAS_LLM_CONFIG_RESULT');

  emit(target, 'GAS_LLM_GET_CONFIG', { requestId: 'r1' });
  await tick();
  eq(sent, [{ type: 'LLM_GET_CONFIG' }]);
  eq(results, [{ requestId: 'r1', data: { provider: 'openai', apiKeysSet: { openai: true } } }]);

  uninstall();
  emit(target, 'GAS_LLM_GET_CONFIG', { requestId: 'r2' });
  await tick();
  assert.equal(sent.length, 1, 'tras uninstall no reenvía');
});

test('GAS_LLM_REQUEST descarta apiKey y conserva requestId', async () => {
  const target = new EventTarget();
  const sent = [];
  GasLlmBridge.install({ target, sendToBackground: async (msg) => { sent.push(msg); return { ok: true, content: 'hola' }; } });
  const results = capture(target, 'GAS_LLM_RESPONSE');

  emit(target, 'GAS_LLM_REQUEST', { requestId: 'q1', provider: 'openai', apiKey: 'sk-leak', messages: [] });
  await tick();
  assert.equal(sent[0].type, 'LLM_CHAT_REQUEST');
  assert.equal(sent[0].payload.apiKey, undefined);
  assert.equal(sent[0].payload.requestId, 'q1');
  assert.equal(results[0].content, 'hola');
  assert.equal(results[0].ok, true);
});

test('streaming: deltas, done y cancelación por el mismo requestId', async () => {
  const target = new EventTarget();
  const posted = [];
  const handlers = { message: [], disconnect: [] };
  const port = {
    postMessage: (m) => posted.push(m),
    disconnect() {},
    onMessage: { addListener: (fn) => handlers.message.push(fn) },
    onDisconnect: { addListener: (fn) => handlers.disconnect.push(fn) },
  };
  GasLlmBridge.install({ target, sendToBackground: async () => null, connect: () => port, isContextValid: () => true });
  const events = capture(target, 'GAS_LLM_STREAM_EVENT');

  emit(target, 'GAS_LLM_STREAM_START', { requestId: 's1', provider: 'openai', apiKey: 'x', messages: [] });
  assert.equal(posted[0].type, 'start');
  assert.equal(posted[0].payload.apiKey, undefined);

  handlers.message.forEach((fn) => fn({ type: 'delta', text: 'Ho' }));
  handlers.message.forEach((fn) => fn({ type: 'done', content: 'Hola' }));
  eq(events, [
    { requestId: 's1', type: 'delta', text: 'Ho' },
    { requestId: 's1', type: 'done', content: 'Hola' },
  ]);

  emit(target, 'GAS_LLM_CANCEL', { requestId: 's1' });
  eq(posted.at(-1), { type: 'cancel' });

  handlers.disconnect.forEach((fn) => fn());
  assert.equal(events.length, 2, 'tras done, el cierre del puerto no emite error');
});

test('streaming con la extensión recargada emite error sin abrir puerto', () => {
  const target = new EventTarget();
  let opened = false;
  GasLlmBridge.install({ target, sendToBackground: async () => null, connect: () => { opened = true; }, isContextValid: () => false });
  const events = capture(target, 'GAS_LLM_STREAM_EVENT');
  emit(target, 'GAS_LLM_STREAM_START', { requestId: 's2' });
  assert.equal(opened, false);
  assert.equal(events[0].type, 'error');
});

test('lista blanca de rutas (MAIN world): sin guardar config, modelos, contexto global ni streaming', async () => {
  const target = new EventTarget();
  const sent = [];
  let opened = false;
  const E = GasLlmBridge.EVENTS;
  GasLlmBridge.install({
    target,
    sendToBackground: async (msg) => { sent.push(msg); return { ok: true }; },
    connect: () => { opened = true; },
    isContextValid: () => true,
    routes: [E.LLM_REQUEST, E.LLM_CANCEL, E.LLM_GET_CONFIG],
    stream: false,
  });
  emit(target, 'GAS_LLM_SAVE_CONFIG', { provider: 'evil', apiKeyUpdates: { openai: 'sk-evil' } });
  emit(target, 'GAS_LLM_FETCH_MODELS', { requestId: 'f1', provider: 'openai' });
  emit(target, 'GAS_LLM_GET_GLOBAL_AI_CONTEXT', { requestId: 'g1' });
  emit(target, 'GAS_LLM_STREAM_START', { requestId: 's1', provider: 'openai', messages: [] });
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(opened, false);

  emit(target, 'GAS_LLM_REQUEST', { requestId: 'q1', provider: 'openai', messages: [] });
  emit(target, 'GAS_LLM_CANCEL', { requestId: 'q1' });
  emit(target, 'GAS_LLM_GET_CONFIG', { requestId: 'c1' });
  await tick();
  eq(sent.map((m) => m.type), ['LLM_CHAT_REQUEST', 'LLM_CANCEL', 'LLM_GET_CONFIG']);
});

test('main-functions.js instala el bridge con lista blanca y sin streaming', () => {
  const src = fs.readFileSync(new URL('../extension/js/main-functions.js', import.meta.url), 'utf8');
  const call = src.match(/GasLlmBridge\.install\(\{[\s\S]*?\}\);/)?.[0] || '';
  assert.match(call, /routes:\s*\[E\.LLM_REQUEST, E\.LLM_CANCEL, E\.LLM_GET_CONFIG\]/);
  assert.match(call, /stream:\s*false/);
});

// ── remote-editor ──────────────────────────────────────────────────────

function fakeChrome({ url, responder }) {
  const sent = [];
  return {
    sent,
    tabs: {
      query: async () => [{ id: 9, url }],
      sendMessage: async (tabId, msg) => { sent.push({ tabId, msg }); return responder(msg); },
    },
  };
}

test('remote-editor: pestaña que no es GAS → no disponible y sin mensajes', async () => {
  const api = fakeChrome({ url: 'https://example.com/', responder: () => ({ ok: true }) });
  const ed = new GasRemoteEditor(api);
  assert.equal(await ed.isAvailable(), false);
  eq(await ed.getSelection(), { available: false, text: '' });
  eq(await ed.insertAtCursor('x'), { ok: false, error: 'no-editor' });
  assert.equal(api.sent.length, 0);
});

test('remote-editor: reenvía acciones a la pestaña de GAS y normaliza respuestas', async () => {
  const api = fakeChrome({
    url: 'https://script.google.com/u/1/home/projects/abc/edit',
    responder: ({ action, payload }) => {
      if (action === 'getFile') return { ok: true, data: { available: true, name: 'Code.gs', text: 'x()' } };
      if (action === 'getProject') return { ok: true, data: { available: true, files: [{ name: 'A', text: 'a' }], omitted: ['B'], max: payload.maxChars } };
      if (action === 'replaceSelection') return { ok: false, error: 'no-selection' };
      if (action === 'insertAtCursor') return { ok: true, data: { ok: true } };
      return { ok: false, error: 'unknown' };
    },
  });
  const ed = new GasRemoteEditor(api);
  assert.equal(await ed.isAvailable(), true);
  eq(await ed.getFile(), { available: true, name: 'Code.gs', text: 'x()' });
  eq(await ed.getProject(80000), { available: true, files: [{ name: 'A', text: 'a' }], omitted: ['B'] });
  eq(api.sent[1].msg, { type: 'EDITOR_REQUEST', action: 'getProject', payload: { maxChars: 80000 } });
  eq(await ed.replaceSelection('y'), { ok: false, error: 'no-selection' });
  eq(await ed.insertAtCursor('y'), { ok: true });
});

test('remote-editor: con tabId fijo usa esa pestaña aunque no sea la activa', async () => {
  const sent = [];
  const api = {
    tabs: {
      get: async (id) => ({ id, url: 'https://script.google.com/home/projects/p/edit' }),
      query: async () => { throw new Error('no debería consultar la pestaña activa'); },
      sendMessage: async (tabId, msg) => { sent.push(tabId); return { ok: true, data: { available: true, fileName: 'A.gs' } }; },
    },
  };
  const ed = new GasRemoteEditor(api, 42);
  eq(await ed.getInfo(), { available: true, fileName: 'A.gs' });
  eq(sent, [42]);
});

test('remote-editor: pestaña cerrada → no disponible', async () => {
  const api = { tabs: { get: async () => { throw new Error('No tab with id'); }, sendMessage: async () => ({}) } };
  eq(await new GasRemoteEditor(api, 5).getInfo(), { available: false, reason: 'not-editor' });
});

test('remote-editor: getInfo distingue "recargar pestaña" y "editor no listo"', async () => {
  const gasTab = { id: 5, url: 'https://script.google.com/home/projects/p/edit' };
  const noContentScript = { tabs: { get: async () => gasTab, sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } } };
  eq(await new GasRemoteEditor(noContentScript, 5).getInfo(), { available: false, reason: 'reload-tab' });

  // Respuesta vacía (p. ej. otro listener respondió `undefined`) → editor no listo.
  const emptyResponse = { tabs: { get: async () => gasTab, sendMessage: async () => undefined } };
  eq(await new GasRemoteEditor(emptyResponse, 5).getInfo(), { available: false, reason: 'not-ready' });
});

test('remote-editor: error de mensajería (pestaña sin content script) no lanza', async () => {
  const api = {
    tabs: {
      query: async () => [{ id: 1, url: 'https://script.google.com/home/projects/x/edit' }],
      sendMessage: async () => { throw new Error('Receiving end does not exist.'); },
    },
  };
  const ed = new GasRemoteEditor(api);
  eq(await ed.getStats(), { available: false, selectionChars: 0, fileChars: 0, projectChars: 0 });
  const res = await ed.insertAtCursor('x');
  assert.equal(res.ok, false);
  assert.match(res.error, /Receiving end/);
});

test('remote-editor: acciones del modo agente (listFiles/readFile/preview/apply)', async () => {
  const api = fakeChrome({
    url: 'https://script.google.com/home/projects/abc/edit',
    responder: ({ action, payload }) => {
      if (action === 'listFiles') return { ok: true, data: { available: true, files: [{ name: 'Code', type: 'gs', lines: 10 }] } };
      if (action === 'readFile') {
        return payload.name === 'Code'
          ? { ok: true, data: { available: true, found: true, name: 'Code', text: 'a()' } }
          : { ok: true, data: { available: true, found: false, name: payload.name } };
      }
      if (action === 'applyFileEdits') {
        return payload.name === 'Code' ? { ok: true, data: { ok: true } } : { ok: true, data: { ok: false, error: 'not-found' } };
      }
      if (['previewChanges', 'navigatePreview', 'closePreview', 'replaceFile', 'saveProject', 'reloadPage'].includes(action)) {
        return { ok: true, data: { ok: true } };
      }
      return { ok: false, error: 'unknown' };
    },
  });
  const ed = new GasRemoteEditor(api);
  eq(await ed.listFiles(), { available: true, files: [{ name: 'Code', type: 'gs', lines: 10 }] });
  eq(await ed.readFile('Code'), { available: true, found: true, name: 'Code', text: 'a()' });
  eq(await ed.readFile('Nope'), { available: true, found: false, name: 'Nope', text: '' });
  eq(await ed.applyFileEdits('Code', 'b()'), { ok: true });
  eq(await ed.applyFileEdits('Nope', 'b()'), { ok: false, error: 'not-found' });
  eq(await ed.previewChanges([{ name: 'Code', kind: 'edit', proposed: 'b()' }], 0), { ok: true });
  eq(await ed.navigatePreview(1), { ok: true });
  eq(await ed.closePreview(), { ok: true });
  eq(await ed.replaceFile('x'), { ok: true });
  eq(await ed.saveProject(), { ok: true });
  eq(await ed.reloadPage(), { ok: true });

  const msgs = api.sent.map((s) => s.msg);
  eq(msgs.find((m) => m.action === 'previewChanges').payload, { files: [{ name: 'Code', kind: 'edit', proposed: 'b()' }], index: 0 });
  eq(msgs.find((m) => m.action === 'applyFileEdits').payload, { name: 'Code', proposed: 'b()' });
  eq(msgs.find((m) => m.action === 'navigatePreview').payload, { index: 1 });
  eq(msgs.find((m) => m.action === 'replaceFile').payload, { text: 'x' });
});

test('remote-editor: acciones del modo agente sin editor no lanzan', async () => {
  const api = fakeChrome({ url: 'https://example.com/', responder: () => ({ ok: true }) });
  const ed = new GasRemoteEditor(api);
  eq(await ed.listFiles(), { available: false, files: [] });
  eq(await ed.readFile('Code'), { available: false, found: false, name: 'Code', text: '' });
  eq(await ed.previewChanges([], 0), { ok: false, error: 'no-editor' });
  eq(await ed.applyFileEdits('Code', 'x'), { ok: false, error: 'no-editor' });
  eq(await ed.replaceFile('x'), { ok: false, error: 'no-editor' });
  eq(await ed.closePreview(), { ok: false, error: 'no-editor' });
  assert.equal(api.sent.length, 0);

  // Respuesta malformada (sin data) → editor no disponible, sin lanzar.
  const bad = fakeChrome({ url: 'https://script.google.com/home/projects/abc/edit', responder: () => undefined });
  const ed2 = new GasRemoteEditor(bad);
  eq(await ed2.listFiles(), { available: false, files: [] });
  eq(await ed2.saveProject(), { ok: false, error: 'no-response' });
});

test('remote-editor: applyChangeSet normaliza resultados, conflictos y errores', async () => {
  let reply = null;
  const api = fakeChrome({ url: 'https://script.google.com/home/projects/abc/edit', responder: () => reply });
  const ed = new GasRemoteEditor(api);
  const files = [{ name: 'Code', mode: 'hunks', batches: [[{ search: 'a', replace: 'b' }]], proposed: 'b', key: 'k' }];

  reply = { ok: true, data: { ok: true, results: [{ name: 'Code', status: 'applied', model: { leak: true } }] } };
  eq(await ed.applyChangeSet(files), { ok: true, results: [{ name: 'Code', status: 'applied' }] });
  eq(api.sent[0].msg, { type: 'EDITOR_REQUEST', action: 'applyChangeSet', payload: { files } });

  reply = { ok: true, data: { ok: false, error: 'conflict', results: [
    { name: 'Code', status: 'conflict', reason: 'hunks', failed: [{ index: 0, search: 'a', reason: 'not-found' }] },
    { name: 'Util', status: 'ready', fuzzy: 2 },
  ] } };
  eq(await ed.applyChangeSet(files), { ok: false, error: 'conflict', results: [
    { name: 'Code', status: 'conflict', reason: 'hunks', failed: [{ index: 0, search: 'a', reason: 'not-found' }] },
    { name: 'Util', status: 'ready', fuzzy: 2 },
  ] });

  reply = { ok: false, error: 'timeout' };
  eq(await ed.applyChangeSet(files), { ok: false, error: 'timeout', results: [] });
  reply = undefined;
  eq(await ed.applyChangeSet('no-array'), { ok: false, error: 'no-response', results: [] });
  eq(api.sent[api.sent.length - 1].msg.payload, { files: [] });
});

test('remote-editor: readFiles en un solo viaje y versionId en readFile/getFile', async () => {
  const api = fakeChrome({
    url: 'https://script.google.com/home/projects/abc/edit',
    responder: ({ action }) => {
      if (action === 'readFiles') return { ok: true, data: { available: true, files: [{ found: true, name: 'Code.gs', text: 'a', versionId: 3 }, { found: false, name: 'X' }] } };
      if (action === 'readFile') return { ok: true, data: { available: true, found: true, name: 'Code.gs', text: 'a', versionId: 3 } };
      if (action === 'getFile') return { ok: true, data: { available: true, name: 'Code.gs', text: 'a', versionId: 4 } };
      return { ok: false };
    },
  });
  const ed = new GasRemoteEditor(api);
  eq(await ed.readFiles(['Code', 'X']), { available: true, files: [
    { found: true, name: 'Code.gs', text: 'a', versionId: 3 },
    { found: false, name: 'X', text: '' },
  ] });
  assert.equal(api.sent.filter((s) => s.msg.action === 'readFiles').length, 1);
  assert.equal((await ed.readFile('Code')).versionId, 3);
  assert.equal((await ed.getFile()).versionId, 4);
  const none = new GasRemoteEditor(fakeChrome({ url: 'https://example.com/', responder: () => null }));
  eq(await none.readFiles(['A']), { available: false, files: [{ found: false, name: 'A', text: '' }] });
});

test('remote-editor: previewChanges devuelve los archivos en conflicto', async () => {
  let reply = { ok: true, data: { ok: true, conflicts: [{ name: 'B', reason: 'changed' }] } };
  const api = fakeChrome({ url: 'https://script.google.com/home/projects/abc/edit', responder: () => reply });
  const ed = new GasRemoteEditor(api);
  eq(await ed.previewChanges([{ name: 'A' }, { name: 'B' }], 0), { ok: true, conflicts: [{ name: 'B', reason: 'changed' }] });
  reply = { ok: true, data: { ok: false, error: 'conflict', conflicts: [{ name: 'A', reason: 'hunks' }] } };
  eq(await ed.previewChanges([{ name: 'A' }], 0), { ok: false, error: 'conflict', conflicts: [{ name: 'A', reason: 'hunks' }] });
});

test('remote-editor: cachea la pestaña fija y la invalida con onRemoved/onUpdated', async () => {
  const listeners = { removed: [], updated: [] };
  let gets = 0;
  const api = {
    tabs: {
      get: async (id) => { gets++; return { id, url: 'https://script.google.com/home/projects/p/edit' }; },
      sendMessage: async () => ({ ok: true, data: { available: true, fileName: 'A.gs' } }),
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
  };
  const ed = new GasRemoteEditor(api, 7);
  await ed.getInfo();
  await ed.getInfo();
  assert.equal(gets, 1, 'un solo tabs.get');
  listeners.updated.forEach((fn) => fn(8, { url: 'https://x/' }));
  await ed.getInfo();
  assert.equal(gets, 1, 'otra pestaña no invalida');
  listeners.updated.forEach((fn) => fn(7, { url: 'https://script.google.com/home/projects/q/edit' }));
  await ed.getInfo();
  assert.equal(gets, 2);
  listeners.removed.forEach((fn) => fn(7));
  await ed.getInfo();
  assert.equal(gets, 3);
});
