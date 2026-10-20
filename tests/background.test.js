// Tests del service worker (extension/background.js) con un mock mínimo de
// la API `chrome`. Cubren los contratos de seguridad: los secretos nunca
// salen del background, migraciones de storage, permisos opcionales e
// inyección del idioma de respuesta.
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const EXT_ID = 'test-extension-id';
const IDE_SENDER = { id: EXT_ID, tab: { id: 7 }, url: 'https://script.google.com/home/projects/abc/edit' };
const SIDE_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/extension/html/sidepanel.html` };

// ── Mock de chrome ──────────────────────────────────────────────────────

function createArea() {
  let data = {};
  return {
    _dump: () => structuredClone(data),
    _reset: (init = {}) => { data = structuredClone(init); },
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]); },
  };
}

const listeners = { message: null, connect: null, installed: null };
const tabQueries = [];
const EDITOR_MATCHES = [
  'https://script.google.com/home/projects/*/edit',
  'https://script.google.com/u/*/home/projects/*/edit',
];
const runtimeBroadcasts = [];
const tabMessages = [];
let sidePanelOpenImpl = async () => {};
const sidePanelOptions = [];
let grantedOrigins = new Set();

const event = (setter) => ({ addListener: setter, removeListener() {} });

globalThis.chrome = {
  runtime: {
    id: EXT_ID,
    lastError: null,
    onMessage: event((fn) => { listeners.message = fn; }),
    onConnect: event((fn) => { listeners.connect = fn; }),
    onInstalled: event((fn) => { listeners.installed = fn; }),
    getManifest: () => ({ content_scripts: [{ matches: EDITOR_MATCHES }] }),
    getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    sendMessage: async (m) => { runtimeBroadcasts.push(m); },
  },
  storage: { sync: createArea(), local: createArea() },
  permissions: {
    // Como Chrome: un patrón concedido sin puerto cubre cualquier puerto.
    contains: async ({ origins }) => origins.every((o) => grantedOrigins.has(o) || grantedOrigins.has(o.replace(/:\d+\/\*$/, '/*'))),
  },
  windows: { onRemoved: event(() => {}), create: async () => ({ id: 1 }), remove: async () => {} },
  alarms: { onAlarm: event(() => {}), create() {}, clear: async () => {} },
  tabs: {
    query: (q, cb) => { tabQueries.push(q); cb([{ id: 7 }]); },
    sendMessage: async (tabId, m) => { tabMessages.push({ tabId, m }); },
  },
  declarativeContent: { onPageChanged: { removeRules() {}, addRules() {} } },
  sidePanel: {
    setPanelBehavior: async () => {},
    setOptions: async (opts) => { sidePanelOptions.push(opts); },
    open: (opts) => sidePanelOpenImpl(opts),
  },
  identity: {},
};

/** Envía un mensaje al listener de onMessage y espera la respuesta. */
function send(msg, sender = IDE_SENDER) {
  return new Promise((resolve) => {
    const keepAlive = listeners.message(msg, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

let fetchCalls = [];
const realFetch = globalThis.fetch;

before(async () => {
  await import('../extension/background.js');
  assert.ok(listeners.message, 'background registra onMessage');
  assert.ok(listeners.connect, 'background registra onConnect');
});

beforeEach(() => {
  chrome.storage.sync._reset();
  chrome.storage.local._reset();
  grantedOrigins = new Set();
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'respuesta' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
});

afterEach(() => { globalThis.fetch = realFetch; });

// ── Remitentes ─────────────────────────────────────────────────────────

test('rechaza mensajes de pestañas fuera de script.google.com', async () => {
  const res = await send({ type: 'GITHUB_GET_AUTH' }, { id: EXT_ID, tab: { id: 1 }, url: 'https://evil.example/' });
  assert.equal(res, undefined);
});

test('rechaza mensajes de otra extensión', async () => {
  const res = await send({ type: 'LLM_GET_CONFIG' }, { id: 'otra', url: 'chrome-extension://otra/' });
  assert.equal(res, undefined);
});

// ── GitHub ─────────────────────────────────────────────────────────────

test('GITHUB_GET_AUTH nunca devuelve el token y migra sync → local', async () => {
  chrome.storage.sync._reset({ gasToolsGithubAuth: { token: 'ghp_secret', user: { login: 'ruben' } } });
  const res = await send({ type: 'GITHUB_GET_AUTH' });
  assert.deepEqual(res, { user: { login: 'ruben' } });
  assert.equal(chrome.storage.sync._dump().gasToolsGithubAuth, undefined);
  assert.equal(chrome.storage.local._dump().gasToolsGithubAuth.token, 'ghp_secret');
});

const S1 = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-ab';
const S2 = '2aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-ab';

test('el mapping repo↔scriptId migra a una clave por proyecto', async () => {
  chrome.storage.sync._reset({ gasToolsGithubProjects: { [S1]: { repo: 'a/b' }, [S2]: { repo: 'c/d' } } });
  assert.deepEqual(await send({ type: 'GITHUB_GET_PROJECT_CONFIG', payload: { scriptId: S2 } }), { repo: 'c/d' });
  const sync = chrome.storage.sync._dump();
  assert.equal(sync.gasToolsGithubProjects, undefined);
  assert.deepEqual(sync[`gasToolsGhProject:${S1}`], { repo: 'a/b' });

  await send({ type: 'GITHUB_SAVE_PROJECT_CONFIG', payload: { scriptId: S1, config: null } });
  assert.equal(chrome.storage.sync._dump()[`gasToolsGhProject:${S1}`], undefined);
});

test('la config del proyecto es una lista blanca validada y baseSha solo si es un SHA válido', async () => {
  chrome.storage.sync._reset({});
  const save = (scriptId, config) => send({ type: 'GITHUB_SAVE_PROJECT_CONFIG', payload: { scriptId, config } });
  const baseSha = 'ab'.repeat(20);
  assert.equal((await save(S1, { repo: 'a/b', branch: 'main', basePath: 'src', baseSha, extra: '<x>' })).ok, true);
  assert.deepEqual(await send({ type: 'GITHUB_GET_PROJECT_CONFIG', payload: { scriptId: S1 } }),
    { repo: 'a/b', branch: 'main', basePath: 'src', baseSha });

  await save(S1, { repo: 'a/b', branch: 'main', baseSha: '<img>' });
  assert.deepEqual(chrome.storage.sync._dump()[`gasToolsGhProject:${S1}`], { repo: 'a/b', branch: 'main', basePath: '' });

  for (const bad of [
    { repo: '../x', branch: 'main' },
    { repo: 'a/..', branch: 'main' },
    { repo: 'a/b/c', branch: 'main' },
    { repo: 'a/b', branch: 'a..b' },
    { repo: 'a/b', branch: 'has space' },
    { repo: 'a/b', branch: 'main', basePath: '../up' },
    { repo: 'a/b', branch: 'main', basePath: 'a\b' },
    { repo: 'a/b', branch: 'main', basePath: 'a' },
  ]) {
    assert.equal((await save(S2, bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(chrome.storage.sync._dump()[`gasToolsGhProject:${S2}`], undefined);
  assert.equal((await save('short', { repo: 'a/b', branch: 'main' })).ok, false, 'scriptId inválido');
  assert.equal((await save('../../x_yyyyyyyyyyyyyyyyyyyy', { repo: 'a/b', branch: 'main' })).ok, false);
});

test('los errores de GITHUB_API_CALL no devuelven el token', async () => {
  chrome.storage.local._reset({ gasToolsGithubAuth: { token: 'ghp_SECRETtoken123', user: { login: 'r' } } });
  globalThis.fetch = async () => new Response('{"message":"bad ghp_SECRETtoken123"}', { status: 400 });
  const res = await send({ type: 'GITHUB_API_CALL', payload: { action: 'LIST_REPOS', payload: {} } });
  assert.equal(res.ok, false);
  assert.ok(!res.error.includes('ghp_SECRETtoken123'), res.error);
});

// ── Config LLM ─────────────────────────────────────────────────────────

test('LLM_GET_CONFIG migra las keys legacy y solo expone apiKeysSet', async () => {
  chrome.storage.sync._reset({ gasToolsLlmConfig: { provider: 'openai', apiKeys: { openai: 'sk-1', gemini: '' } } });
  const cfg = await send({ type: 'LLM_GET_CONFIG' });
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.apiKeys, undefined);
  assert.deepEqual(cfg.apiKeysSet, { openai: true });
  assert.equal(JSON.stringify(cfg).includes('sk-1'), false);
  assert.equal(chrome.storage.sync._dump().gasToolsLlmConfig.apiKeys, undefined);
  assert.equal(chrome.storage.local._dump().gasToolsLlmSecrets.openai, 'sk-1');
});

test('LLM_SAVE_CONFIG aplica apiKeyUpdates (set / borrar / conservar)', async () => {
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'old', anthropic: 'keep' } });
  await send({
    type: 'LLM_SAVE_CONFIG',
    payload: { provider: 'gemini', apiKeysSet: { x: true }, apiKeyUpdates: { openai: null, gemini: ' g-key ' } },
  }, SIDE_SENDER);
  assert.deepEqual(chrome.storage.local._dump().gasToolsLlmSecrets, { anthropic: 'keep', gemini: 'g-key' });
  const publicCfg = chrome.storage.sync._dump().gasToolsLlmConfig;
  assert.equal(publicCfg.provider, 'gemini');
  assert.equal(publicCfg.apiKeyUpdates, undefined);
  assert.equal(publicCfg.apiKeysSet, undefined);
});

// ── Peticiones LLM ─────────────────────────────────────────────────────

const CHAT = {
  provider: 'openai', model: 'm', requestId: 'r1',
  messages: [{ role: 'system', content: 'base' }, { role: 'user', content: 'hola' }],
};

test('sin permiso del host devuelve permissionOrigin y no hace fetch', async () => {
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  const res = await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
  assert.equal(res.ok, false);
  assert.equal(res.permissionOrigin, 'https://api.openai.com/*');
  assert.equal(fetchCalls.length, 0);
});

test('inyecta la key del storage e ignora la del payload', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk-real' } });
  const res = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, apiKey: 'sk-fake' } });
  assert.deepEqual(res.ok, true);
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer sk-real');
});

test('aplica el idioma de respuesta configurado al mensaje system', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  chrome.storage.sync._reset({ gasToolsAiLanguage: 'es' });
  await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
  const system = fetchCalls[0].body.messages[0].content;
  assert.match(system, /^base/);
  assert.match(system, /Spanish/);

  chrome.storage.sync._reset({ gasToolsAiLanguage: 'auto' });
  await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
  assert.equal(fetchCalls[1].body.messages[0].content, 'base');
});

test('idioma Auto sigue la interfaz: UI en español → respuestas en español', async () => {
  const { DB } = await import('../src/js/utils/Storage.js');
  const realGet = DB.get;
  DB.get = async () => ({ options: { 'ui-language': 'es' } });
  try {
    grantedOrigins.add('https://api.openai.com/*');
    chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
    chrome.storage.sync._reset({ gasToolsAiLanguage: 'auto' });
    await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
    assert.match(fetchCalls[0].body.messages[0].content, /Spanish/);

    // Con un idioma elegido explícitamente, manda ese (no la interfaz).
    chrome.storage.sync._reset({ gasToolsAiLanguage: 'en' });
    await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
    assert.match(fetchCalls[1].body.messages[0].content, /English/);
  } finally {
    DB.get = realGet;
  }
});

const CUSTOM_URL = 'http://localhost:11434/v1/chat/completions';
const saveCustomEndpoint = (url = CUSTOM_URL) =>
  chrome.storage.sync._reset({ gasToolsLlmConfig: { provider: 'custom', providerSettings: { custom: { endpointUrl: url } } } });

test('custom deriva el origen (con puerto) del endpoint guardado', async () => {
  saveCustomEndpoint();
  const payload = { ...CHAT, provider: 'custom', endpointUrl: CUSTOM_URL };
  const denied = await send({ type: 'LLM_CHAT_REQUEST', payload });
  assert.equal(denied.permissionOrigin, 'http://localhost:11434/*');

  grantedOrigins.add('http://localhost/*');
  const ok = await send({ type: 'LLM_CHAT_REQUEST', payload });
  assert.equal(ok.ok, true);
  assert.equal(fetchCalls[0].url, CUSTOM_URL);
  assert.equal(fetchCalls[0].init.headers.Authorization, undefined);
});

test('custom usa el endpoint guardado y rechaza uno distinto en el payload', async () => {
  grantedOrigins.add('http://localhost/*');
  grantedOrigins.add('http://127.0.0.1/*');
  saveCustomEndpoint();
  // Sin endpoint en el payload: se usa el guardado.
  const ok = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, provider: 'custom' } });
  assert.equal(ok.ok, true);
  assert.equal(fetchCalls[0].url, CUSTOM_URL);
  // Distinto al guardado: no hay fetch.
  const bad = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, provider: 'custom', endpointUrl: 'http://127.0.0.1:9/v1/chat/completions' } });
  assert.equal(bad.ok, false);
  assert.equal(fetchCalls.length, 1);
  // Sin endpoint guardado: error, sin fetch.
  chrome.storage.sync._reset();
  const none = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, provider: 'custom', endpointUrl: CUSTOM_URL } });
  assert.equal(none.ok, false);
  assert.equal(fetchCalls.length, 1);
});

test('un proveedor desconocido falla en cerrado (sin fetch)', async () => {
  chrome.storage.local._reset({ gasToolsLlmSecrets: { kimi: 'sk' } });
  const res = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, provider: 'kimi' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown AI provider/);
  assert.equal(fetchCalls.length, 0);
});

test('los errores del proveedor no exponen la API key ni el Bearer', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk-very-secret-123' } });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'Invalid key sk-very-secret-123 (Authorization: Bearer sk-very-secret-123)' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
  const res = await send({ type: 'LLM_CHAT_REQUEST', payload: CHAT });
  assert.equal(res.ok, false);
  assert.equal(res.error.includes('sk-very-secret-123'), false);
  assert.match(res.error, /\*\*\*/);
});

test('LLM_SAVE_CONFIG y LLM_FETCH_MODELS se rechazan desde una pestaña', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  const saved = await send({ type: 'LLM_SAVE_CONFIG', payload: { provider: 'anthropic', apiKeyUpdates: { openai: 'sk-evil' } } });
  assert.equal(saved.ok, false);
  assert.equal(chrome.storage.local._dump().gasToolsLlmSecrets.openai, 'sk');
  assert.equal(chrome.storage.sync._dump().gasToolsLlmConfig, undefined);
  const models = await send({ type: 'LLM_FETCH_MODELS', payload: { provider: 'openai' } });
  assert.equal(models.ok, false);
  assert.equal(fetchCalls.length, 0);
});

test('el Side Panel (sin sender.tab) guarda la config y lista modelos', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  const SIDE = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/extension/html/sidepanel.html` };
  const saved = await send({ type: 'LLM_SAVE_CONFIG', payload: { provider: 'openai', apiKeyUpdates: { openai: 'sk-side' } } }, SIDE);
  assert.equal(saved.ok, true);
  assert.equal(chrome.storage.local._dump().gasToolsLlmSecrets.openai, 'sk-side');
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = await send({ type: 'LLM_FETCH_MODELS', payload: { provider: 'openai' } }, SIDE);
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, ['gpt-4o']);
});

test('LLM_FETCH_MODELS resuelve modelos usando la key guardada', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk-model-key' } });
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await send({ type: 'LLM_FETCH_MODELS', payload: { provider: 'openai' } }, SIDE_SENDER);
  assert.equal(res.ok, true);
  assert.deepEqual(res.models, ['gpt-4o']);
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer sk-model-key');
});

test('LLM_CHAT_REQUEST con tools devuelve toolCalls (modo agente)', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'x', function: { name: 'list_files', arguments: '{}' } }] } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const tools = [{ name: 'list_files', description: 'List', parameters: { type: 'object', properties: {} } }];
  const res = await send({ type: 'LLM_CHAT_REQUEST', payload: { ...CHAT, tools } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.toolCalls, [{ id: 'x', name: 'list_files', args: {} }]);
  assert.equal(fetchCalls[0].body.tools[0].function.name, 'list_files');
});

// ── Side Panel ─────────────────────────────────────────────────────────

test('OPEN_SIDE_PANEL habilita y abre un panel solo para esa pestaña', async () => {
  const calls = [];
  sidePanelOptions.length = 0;
  sidePanelOpenImpl = async (opts) => { calls.push(opts); };
  const res = await send({ type: 'OPEN_SIDE_PANEL' }, { ...IDE_SENDER, tab: { id: 7, windowId: 3 } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [{ tabId: 7 }]);
  assert.deepEqual(sidePanelOptions, [{ tabId: 7, path: 'extension/html/sidepanel.html?tabId=7', enabled: true }]);
});

test('OPEN_SIDE_PANEL devuelve el error si Chrome lo rechaza (sin gesto)', async () => {
  sidePanelOpenImpl = async () => { throw new Error('sidePanel.open() may only be called in response to a user gesture.'); };
  const res = await send({ type: 'OPEN_SIDE_PANEL' }, { ...IDE_SENDER, tab: { id: 7, windowId: 3 } });
  assert.equal(res.ok, false);
  assert.match(res.error, /user gesture/);
});

test('LLM_SAVE_CONFIG difunde LLM_CONFIG_UPDATED a pestañas y páginas', async () => {
  runtimeBroadcasts.length = 0;
  tabMessages.length = 0;
  await send({ type: 'LLM_SAVE_CONFIG', payload: { provider: 'openai' } }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/extension/html/sidepanel.html` });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(runtimeBroadcasts.some((m) => m.type === 'LLM_CONFIG_UPDATED'));
  assert.ok(tabMessages.some(({ m }) => m.type === 'LLM_CONFIG_UPDATED'));
});

// ── i18n del editor ────────────────────────────────────────────────────

test('GET_EDITOR_I18N devuelve solo claves ed* en español y null en inglés', async () => {
  const fs = await import('node:fs');
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(`chrome-extension://${EXT_ID}/`, '');
    const body = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  assert.equal(await send({ type: 'GET_EDITOR_I18N', payload: { lang: 'en' } }), null);

  const dict = await send({ type: 'GET_EDITOR_I18N', payload: { lang: 'es' } });
  assert.equal(dict.lang, 'es');
  const keys = Object.keys(dict.messages);
  assert.ok(keys.length > 100);
  assert.ok(keys.every((k) => k.startsWith('ed')));
  assert.equal(dict.messages.edToolbarActionsLabel, 'Acciones');
});

// ── Streaming por Port ─────────────────────────────────────────────────

function createPort(sender = IDE_SENDER) {
  const received = [];
  const handlers = { message: [], disconnect: [] };
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const port = {
    name: 'llm-stream',
    sender,
    postMessage: (m) => { received.push(m); if (m.type === 'done' || m.type === 'error') resolveDone(); },
    disconnect: () => {},
    onMessage: event((fn) => handlers.message.push(fn)),
    onDisconnect: event((fn) => handlers.disconnect.push(fn)),
  };
  return {
    port, received, done,
    emit: (m) => handlers.message.forEach((fn) => fn(m)),
    close: () => handlers.disconnect.forEach((fn) => fn()),
  };
}

test('el puerto llm-stream reenvía deltas y el contenido final', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"Ho"}}]}\n\ndata: {"choices":[{"delta":{"content":"la"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );

  const p = createPort();
  listeners.connect(p.port);
  p.emit({ type: 'start', payload: CHAT });
  await p.done;
  assert.deepEqual(p.received, [
    { type: 'delta', text: 'Ho' },
    { type: 'delta', text: 'la' },
    { type: 'done', content: 'Hola' },
  ]);
});

test('cerrar el puerto aborta el fetch en curso', async () => {
  grantedOrigins.add('https://api.openai.com/*');
  chrome.storage.local._reset({ gasToolsLlmSecrets: { openai: 'sk' } });
  let aborted = false;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
  });

  const p = createPort();
  listeners.connect(p.port);
  p.emit({ type: 'start', payload: CHAT });
  await new Promise((r) => setTimeout(r, 10));
  p.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(aborted, true);
});

test('el puerto rechaza remitentes no confiables', () => {
  let disconnected = false;
  const p = createPort({ id: EXT_ID, tab: { id: 2 }, url: 'https://evil.example/' });
  p.port.disconnect = () => { disconnected = true; };
  listeners.connect(p.port);
  assert.equal(disconnected, true);
});

// ── Settings: normalización y propagación ─────────────────────────────

/** Sustituye DB.get/DB.set durante `fn` y los restaura al terminar. */
async function withFakeDb(record, fn) {
  const { DB } = await import('../src/js/utils/Storage.js');
  const real = { get: DB.get, set: DB.set };
  const calls = { get: 0, set: [] };
  DB.get = async () => { calls.get++; return structuredClone(record); };
  DB.set = async (_store, data) => { calls.set.push(structuredClone(data)); return true; };
  try { await fn(calls); } finally { Object.assign(DB, real); }
}

/** Espera a que terminen las tareas async lanzadas por el listener. */
const flush = () => new Promise((r) => setTimeout(r, 0));
const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/html/index.html` };

test('GET_SETTINGS devuelve settings normalizados (textos heredados → booleanos)', async () => {
  await withFakeDb({ options: { lineNumbers: 'off', rulers: '', 'load-snippets': true, custom: 1 } }, async () => {
    const res = await send({ type: 'GET_SETTINGS' });
    assert.equal(res.lineNumbers, false);
    assert.equal(res.rulers, false);
    assert.equal(res.renderLineHighlight, true);
    assert.equal(res['load-snippets'], undefined);
    assert.equal(res.custom, 1);
    assert.equal(res.schemaVersion, 2);
  });
});

test('NOTIFY_UPDATE con changed reenvía el delta sin leer IndexedDB y solo a pestañas del editor', async () => {
  await withFakeDb(null, async (calls) => {
    runtimeBroadcasts.length = 0;
    tabMessages.length = 0;
    tabQueries.length = 0;
    const options = { fontSize: 15, 'global-enable': true };
    await send({ type: 'NOTIFY_UPDATE', updateType: 'settings', changed: { fontSize: 15 }, options }, POPUP_SENDER);
    await flush();
    assert.equal(calls.get, 0);
    assert.deepEqual(tabQueries.at(-1).url, EDITOR_MATCHES);
    const pushed = tabMessages.at(-1).m;
    assert.equal(pushed.type, 'SETTINGS_UPDATED');
    assert.deepEqual(pushed.payload.changed, { fontSize: 15 });
    assert.equal(pushed.payload.options.fontSize, 15);
    // El Side Panel sigue recibiendo `options` completos.
    const toPages = runtimeBroadcasts.find((m) => m.type === 'SETTINGS_UPDATED');
    assert.equal(toPages.payload.options.lineNumbers, true);
  });
});

test('NOTIFY_UPDATE desde una pestaña ignora changed/options y relee IndexedDB', async () => {
  await withFakeDb({ options: { fontSize: 13 } }, async (calls) => {
    tabMessages.length = 0;
    await send({ type: 'NOTIFY_UPDATE', updateType: 'settings', changed: { fontSize: 99 }, options: { fontSize: 99 } });
    await flush();
    assert.equal(calls.get, 1);
    const { payload } = tabMessages.at(-1).m;
    assert.equal(payload.changed, undefined);
    assert.equal(payload.options.fontSize, 13);
  });
});

test('onInstalled(update) migra los settings una sola vez', async () => {
  await withFakeDb({ id: 'QualityCode', options: { lineNumbers: 'on', 'load-snippets': true } }, async (calls) => {
    listeners.installed({ reason: 'update' });
    await flush();
    assert.equal(calls.set.length, 1);
    assert.equal(calls.set[0].options.lineNumbers, true);
    assert.equal(calls.set[0].options['load-snippets'], undefined);
  });
  await withFakeDb({ id: 'QualityCode', options: { schemaVersion: 2 } }, async (calls) => {
    listeners.installed({ reason: 'update' });
    await flush();
    assert.equal(calls.set.length, 0);
  });
});
