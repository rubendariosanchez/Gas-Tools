// Tests del historial de conversaciones (chat-store.js) y de la creación de
// archivos vía Apps Script API (project-files.js), ambos del Side Panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadClassic(rel, globalName, deps = []) {
  const ctx = vm.createContext({ console });
  for (const dep of [...deps, rel]) vm.runInContext(fs.readFileSync(new URL(`../${dep}`, import.meta.url), 'utf8'), ctx);
  vm.runInContext(`globalThis.${globalName} = ${globalName};`, ctx);
  return ctx[globalName];
}
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

const GasChatStore = loadClassic('extension/js/sidepanel/chat-store.js', 'GasChatStore');
const GasProjectFiles = loadClassic('extension/js/sidepanel/project-files.js', 'GasProjectFiles');

function memoryStorage() {
  const data = {};
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, JSON.parse(JSON.stringify(data[k]))])),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

// ── chat-store ─────────────────────────────────────────────────────────

test('guarda por proyecto, título desde el primer mensaje y más reciente primero', async () => {
  const store = new GasChatStore(memoryStorage());
  const a = await store.save('p1', { messages: [{ role: 'user', content: '@file Explica   este archivo' }, { role: 'assistant', content: 'ok' }] });
  await store.save('p1', { messages: [{ role: 'user', content: 'Segunda' }] });
  await store.save('p2', { messages: [{ role: 'user', content: 'Otro proyecto' }] });

  const list = await store.list('p1');
  eq(list.map((c) => c.title), ['Segunda', 'Explica este archivo']);
  assert.equal((await store.list('p2')).length, 1);
  assert.equal((await store.get('p1', a.id)).messages.length, 2);
});

test('actualizar una conversación la mueve arriba sin duplicarla', async () => {
  const store = new GasChatStore(memoryStorage());
  const a = await store.save('p', { messages: [{ role: 'user', content: 'A' }] });
  await store.save('p', { messages: [{ role: 'user', content: 'B' }] });
  await store.save('p', { id: a.id, messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'r' }] });
  eq((await store.list('p')).map((c) => c.title), ['A', 'B']);
});

test('no guarda conversaciones sin mensajes del usuario y respeta el máximo', async () => {
  const store = new GasChatStore(memoryStorage());
  assert.equal(await store.save('p', { messages: [{ role: 'assistant', content: 'hola' }] }), null);
  for (let i = 0; i < GasChatStore.MAX_CONVERSATIONS + 5; i++) await store.save('p', { messages: [{ role: 'user', content: `m${i}` }] });
  assert.equal((await store.list('p')).length, GasChatStore.MAX_CONVERSATIONS);
});

test('recorta textos grandes y quita original/propuesto de los ChangeSets', () => {
  const big = 'x'.repeat(GasChatStore.MAX_MESSAGE_CHARS + 10);
  const msg = GasChatStore.trimMessage({
    role: 'assistant', content: big, _expanded: 'y'.repeat(GasChatStore.MAX_EXPANDED_CHARS + 1),
    _changes: { files: [{ path: 'A.gs', status: 'accepted', original: 'o', proposed: 'p', added: 1 }] },
  });
  assert.ok(msg.content.endsWith('[truncated]'));
  assert.equal(msg._expanded, undefined);
  eq(msg._changes.files[0], { path: 'A.gs', status: 'accepted', added: 1, stale: true });
});

test('remove borra solo esa conversación', async () => {
  const store = new GasChatStore(memoryStorage());
  const a = await store.save('p', { messages: [{ role: 'user', content: 'A' }] });
  await store.save('p', { messages: [{ role: 'user', content: 'B' }] });
  await store.remove('p', a.id);
  eq((await store.list('p')).map((c) => c.title), ['B']);
});

// ── project-files ──────────────────────────────────────────────────────

test('scriptIdFromUrl y toApiFile', () => {
  assert.equal(GasProjectFiles.scriptIdFromUrl('https://script.google.com/u/0/home/projects/1AbC-x_y/edit'), '1AbC-x_y');
  assert.equal(GasProjectFiles.scriptIdFromUrl('https://example.com'), null);
  eq(GasProjectFiles.toApiFile('Utils/Dates.gs'), { name: 'Utils/Dates', type: 'SERVER_JS' });
  eq(GasProjectFiles.toApiFile('ui/Sidebar.html'), { name: 'ui/Sidebar', type: 'HTML' });
  eq(GasProjectFiles.toApiFile('Helpers'), { name: 'Helpers', type: 'SERVER_JS' });
});

function fakeBackground({ auth = { user: { email: 'a@b.c' } }, files = [], putOk = true } = {}) {
  const sent = [];
  const send = async (msg) => {
    sent.push(msg);
    if (msg.type === 'GOOGLE_GET_AUTH') return auth;
    if (msg.payload?.action === 'GET_CONTENT') return { ok: true, data: { files } };
    if (msg.payload?.action === 'PUT_CONTENT') return putOk ? { ok: true, data: {} } : { ok: false, error: 'HTTP 403' };
    return null;
  };
  return { sent, send };
}

test('createFiles añade los archivos nuevos conservando todos los existentes', async () => {
  const bg = fakeBackground({ files: [{ name: 'Code', type: 'SERVER_JS', source: 'a()' }, { name: 'appsscript', type: 'JSON', source: '{}' }] });
  const res = await GasProjectFiles.createFiles({ scriptId: 'S', files: [{ path: 'Utils/Dates.gs', content: 'x' }], sendToBackground: bg.send });
  eq(res, { ok: true, created: ['Utils/Dates.gs'] });
  const put = bg.sent.find((m) => m.payload?.action === 'PUT_CONTENT');
  eq(put.payload.payload.files, [
    { name: 'Code', type: 'SERVER_JS', source: 'a()' },
    { name: 'appsscript', type: 'JSON', source: '{}' },
    { name: 'Utils/Dates', type: 'SERVER_JS', source: 'x' },
  ]);
});

test('createFiles: sin sesión de Google, archivo existente o error de API', async () => {
  const noAuth = fakeBackground({ auth: null });
  eq(await GasProjectFiles.createFiles({ scriptId: 'S', files: [{ path: 'A.gs', content: '' }], sendToBackground: noAuth.send }), { ok: false, error: 'auth-required' });

  const dup = fakeBackground({ files: [{ name: 'A', type: 'SERVER_JS', source: '' }] });
  eq(await GasProjectFiles.createFiles({ scriptId: 'S', files: [{ path: 'A.gs', content: '' }], sendToBackground: dup.send }), { ok: false, error: 'exists', existing: ['A.gs'] });
  assert.ok(!dup.sent.some((m) => m.payload?.action === 'PUT_CONTENT'), 'no escribe si hay conflicto');

  const fail = fakeBackground({ putOk: false });
  const res = await GasProjectFiles.createFiles({ scriptId: 'S', files: [{ path: 'B.gs', content: '' }], sendToBackground: fail.send });
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 403/);

  eq(await GasProjectFiles.createFiles({ scriptId: null, files: [{ path: 'B.gs' }], sendToBackground: fail.send }), { ok: false, error: 'no-script-id' });
});

// ── agent-tools ────────────────────────────────────────────────────────

const GasAgentTools = loadClassic('extension/js/sidepanel/agent-tools.js', 'GasAgentTools');
const GasEditBlocks = loadClassic('extension/js/shared/edit-blocks.js', 'GasEditBlocks', ['extension/js/shared/edit-applier.js']);
const GasEditApplier = loadClassic('extension/js/shared/edit-applier.js', 'GasEditApplier');
const GasLineDiff = loadClassic('extension/js/shared/line-diff.js', 'GasLineDiff');

function fakeEditor(files) {
  const reads = [];
  return {
    reads,
    listFiles: async () => ({ available: true, files: Object.keys(files).map((name) => ({ name, type: 'gs', lines: files[name].split('\n').length })) }),
    readFile: async (name) => { reads.push(name); return name in files ? { available: true, found: true, name, text: files[name] } : { available: true, found: false }; },
  };
}

test('agent-tools: definiciones con JSON Schema para las 5 herramientas', () => {
  eq(GasAgentTools.DEFINITIONS.map((d) => d.name), ['list_files', 'read_file', 'search_project', 'propose_edit', 'create_file']);
  assert.ok(GasAgentTools.DEFINITIONS.every((d) => d.parameters.type === 'object'));
});

test('agent-tools: list, read (con caché) y search', async () => {
  const editor = fakeEditor({ 'Code.gs': 'function a() {\n  SpreadsheetApp.flush();\n}', 'Util.gs': 'const x = 1;' });
  const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff });
  assert.match((await exec.execute({ name: 'list_files', args: {} })).content, /Code\.gs \(gs, 3 lines\)/);
  assert.match((await exec.execute({ name: 'read_file', args: { path: 'Code.gs' } })).content, /SpreadsheetApp/);
  await exec.execute({ name: 'read_file', args: { path: 'Code.gs' } });
  eq(editor.reads, ['Code.gs'], 'lee una sola vez');
  assert.match((await exec.execute({ name: 'read_file', args: { path: 'Nope.gs' } })).content, /not found/);
  assert.equal((await exec.execute({ name: 'search_project', args: { query: 'spreadsheetapp' } })).content, 'Code.gs:2: SpreadsheetApp.flush();');
});

test('agent-tools: propose_edit acumula en el ChangeSet sin escribir y encadena ediciones', async () => {
  const editor = fakeEditor({ 'Code.gs': 'function a() {\n  return 1;\n}' });
  const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff });
  const r1 = await exec.execute({ name: 'propose_edit', args: { path: 'Code.gs', edits: [{ search: '  return 1;', replace: '  return 2;' }] } });
  assert.match(r1.content, /Applied 1 of 1/);
  await exec.execute({ name: 'propose_edit', args: { path: 'Code.gs', edits: [{ search: 'function a()', replace: 'function b()' }] } });
  const [file] = exec.changeSet().files;
  assert.equal(file.original, 'function a() {\n  return 1;\n}');
  assert.equal(file.proposed, 'function b() {\n  return 2;\n}');
  assert.equal(file.status, 'pending');
  assert.equal(file.added, 2);
  assert.equal(file.removed, 2);
});

test('agent-tools: edición fallida devuelve feedback al modelo; create_file y errores', async () => {
  const editor = fakeEditor({ 'Code.gs': 'a();' });
  const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff });
  const bad = await exec.execute({ name: 'propose_edit', args: { path: 'Code.gs', edits: [{ search: 'zzz();', replace: 'y();' }] } });
  assert.match(bad.content, /Applied 0 of 1/);
  assert.equal(bad.step.failed, 1);

  const created = await exec.execute({ name: 'create_file', args: { path: 'Utils/Dates.gs', content: 'function d() {}' } });
  assert.match(created.content, /Proposed new file/);
  assert.match((await exec.execute({ name: 'create_file', args: { path: 'Code.gs', content: '' } })).content, /already exists/);
  assert.match((await exec.execute({ name: 'nope', args: {} })).content, /unknown tool/);
  eq(exec.changeSet().files.map((f) => [f.path, f.kind]), [['Code.gs', 'edit'], ['Utils/Dates.gs', 'create']]);
});

test('agent-tools: con GasEditApplier guarda lotes de hunks aplicados y versionId para el rebase', async () => {
  const editor = fakeEditor({ 'Code.gs': 'function a() {\n  return 1;\n}' });
  editor.readFile = async (name) => ({ available: true, found: true, name, text: 'function a() {\n  return 1;\n}', versionId: 9 });
  const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff, applier: GasEditApplier });
  await exec.execute({ name: 'propose_edit', args: { path: 'Code.gs', edits: [{ search: '  return 1;', replace: '  return 2;' }, { search: 'nope', replace: 'x' }] } });
  await exec.execute({ name: 'propose_edit', args: { path: 'Code.gs', edits: [{ search: 'function a()', replace: 'function b()' }] } });
  const [file] = exec.changeSet().files;
  assert.equal(file.mode, 'hunks');
  assert.equal(file.baseVersionId, 9);
  eq(file.batches, [[{ search: '  return 1;', replace: '  return 2;' }], [{ search: 'function a()', replace: 'function b()' }]]);
  assert.equal(file.batches.flat().some((h) => h.search === 'nope'), false, 'el hunk fallido no se guarda');
  // El rebase de los lotes reproduce el propuesto
  eq(GasEditApplier.rebase(file.original, file, 9), { proposed: file.proposed, edits: null, fuzzy: 0 });
});

test('agent-tools: search_project usa getProject en un solo viaje', async () => {
  const editor = fakeEditor({});
  let calls = 0;
  editor.getProject = async () => { calls++; return { available: true, files: [{ name: 'A.gs', text: 'x\nfoo()' }, { name: 'B.gs', text: 'FOO' }] }; };
  const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff, applier: GasEditApplier });
  assert.equal((await exec.execute({ name: 'search_project', args: { query: 'foo' } })).content, 'A.gs:2: foo()\nB.gs:1: FOO');
  assert.equal(calls, 1);
  eq(editor.reads, []);
});
