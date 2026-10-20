// Tests de propagación de settings en el mundo MAIN: bootstrap de
// gas-tools-main.js (delta, global-enable, cambio de archivo, toggles
// rápidos) y listeners de los servicios (carpetas, Error Lens, búsqueda).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeSettings } from '../src/js/utils/Variables.js';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const plain = (o) => JSON.parse(JSON.stringify(o));
const FULL = normalizeSettings({});

/** Documento mínimo con listeners capturados y `dispatch(tipo, detalle)`. */
function fakeDocument() {
  const listeners = {};
  const cwiz = { getAttribute: () => null };
  return {
    listeners,
    body: {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === 'c-wiz[data-p]' ? [cwiz] : []),
    getElementById: () => null,
    dispatch(type, detail) {
      (listeners[type] || []).forEach((fn) => fn({ detail: JSON.stringify(detail) }));
    },
  };
}

/** Arranca gas-tools-main.js con un GasCustomEditor simulado que registra llamadas. */
function bootMain({ monacoReady = true } = {}) {
  const document = fakeDocument();
  const calls = [];
  const ctxRef = {};
  class FakeEditor {
    constructor(data) { this.options = data; this._settings = { ...data.settings }; calls.push(['new']); ctxRef.__lastInst = this; }
    init() { calls.push(['init']); }
    updateSettings(p) { this._settings = { ...this._settings, ...p }; calls.push(['update', plain(p)]); }
    mergeAndReinit(d) { calls.push(['merge', plain(d.settings)]); }
    disable() { this._settings = {}; calls.push(['disable']); }
    enable() { calls.push(['enable', plain(this.options.settings)]); }
  }
  // Temporizadores sin retener el proceso (el límite de 60 s del polling).
  const unrefTimeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
  const ctx = {
    console, document, setTimeout: unrefTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    GasCustomEditor: FakeEditor,
    jsWireMonacoEditor: monacoReady ? {} : undefined,
    location: { pathname: '/edit' },
  };
  ctx.window = ctx;
  Object.defineProperty(ctxRef, '__lastInst', { set: (v) => { ctx.__lastInst = v; } });
  vm.runInNewContext(read('extension/js/gas-tools-main.js'), ctx);
  return { document, calls, ctx };
}

test('bootstrap: un toggle llega como delta y un payload sin cambios no hace nada', () => {
  const { document, calls } = bootMain();
  document.dispatch('GAS_TransferData', { settings: FULL });
  assert.deepEqual(calls.map((c) => c[0]), ['new', 'init']);
  document.dispatch('GAS_SettingsUpdated', { showMinimap: true });
  assert.deepEqual(calls.at(-1), ['update', { showMinimap: true }]);
  // Reset/migración envía las opciones completas: solo viaja la diferencia real.
  document.dispatch('GAS_SettingsUpdated', { ...FULL, showMinimap: true });
  assert.equal(calls.filter((c) => c[0] === 'update').length, 1);
  document.dispatch('GAS_SettingsUpdated', { ...FULL, fontSize: '16' });
  assert.deepEqual(calls.at(-1), ['update', { showMinimap: false, fontSize: '16' }]);
});

test('bootstrap: global-enable off→on reaplica las opciones completas, incluidas las cambiadas en pausa', () => {
  const { document, calls, ctx } = bootMain();
  document.dispatch('GAS_TransferData', { settings: FULL });
  document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': false });
  assert.deepEqual(calls.at(-1), ['disable']);
  assert.equal(ctx.__gasGloballyDisabled, true);
  // En pausa: el delta no toca el editor, pero se recuerda.
  document.dispatch('GAS_SettingsUpdated', { wordWrap: false });
  assert.equal(calls.filter((c) => c[0] === 'update').length, 0);
  document.dispatch('GAS_SettingsUpdated', { ...FULL, wordWrap: false, 'global-enable': true });
  const last = calls.at(-1);
  assert.equal(last[0], 'enable');
  assert.equal(last[1].wordWrap, false);
  assert.equal(last[1]['gas-folders'], true);
  assert.equal(ctx.__gasGloballyDisabled, false);
});

test('bootstrap: cambiar de archivo pasa por mergeAndReinit y los toggles rápidos no se pierden', () => {
  const { document, calls } = bootMain();
  document.dispatch('GAS_TransferData', { settings: FULL });
  const keys = ['showMinimap', 'rulers', 'renderWhitespace', 'wordWrap', 'folding'];
  keys.forEach((k) => document.dispatch('GAS_SettingsUpdated', { [k]: !FULL[k] }));
  const updates = calls.filter((c) => c[0] === 'update');
  assert.equal(updates.length, keys.length);
  keys.forEach((k, i) => assert.deepEqual(updates[i][1], { [k]: !FULL[k] }));
  // Payload de archivo nuevo con settings viejos del content script.
  document.dispatch('GAS_TransferData', { settings: FULL });
  assert.equal(calls.at(-1)[0], 'merge');
});

test('GasCustomEditor.mergeAndReinit conserva los settings en memoria frente a datos desactualizados', () => {
  const window = {};
  const ctx = vm.createContext({ console, window, document: { addEventListener() {}, removeEventListener() {} } });
  for (const rel of ['extension/js/shared/line-diff.js', 'extension/js/shared/edit-applier.js', 'extension/js/gas-tools.js']) {
    vm.runInContext(read(rel), ctx);
  }
  vm.runInContext('globalThis.__E = GasCustomEditor;', ctx);
  const inst = Object.create(ctx.__E.prototype);
  inst.options = { settings: { ...FULL } };
  inst._settings = { ...FULL };
  inst._snippets = [];
  inst._activeTheme = null;
  inst.editor = null;
  inst.applySettings = () => {};
  inst._refreshRootParent_ = () => {};
  let inited = 0;
  inst.init = () => { inited++; };
  inst.updateSettings({ showMinimap: true, fontSize: '18' });
  inst.mergeAndReinit({ referenceId: 'x', settings: { ...FULL }, snippets: [{ id: 's' }] });
  assert.equal(inst.options.settings.showMinimap, true);
  assert.equal(inst.options.settings.fontSize, '18');
  assert.equal(inst.options.snippets.length, 1);
  assert.equal(inited, 1);
});

// Carrera de arranque: los deltas previos a Monaco viajan en G_LAST_SETTINGS.
test('bootstrap: un toggle antes de que Monaco esté listo no se pierde', async () => {
  const { document, calls, ctx } = bootMain({ monacoReady: false });
  document.dispatch('GAS_TransferData', { settings: FULL });
  assert.equal(calls.length, 0, 'sin Monaco no se crea la instancia');
  document.dispatch('GAS_SettingsUpdated', { showMinimap: true });
  ctx.jsWireMonacoEditor = {};
  await new Promise((r) => setTimeout(r, 400));   // polling de 300 ms
  clearInterval(ctx._gasSpaPollInterval);
  const created = calls.find((c) => c[0] === 'new');
  assert.ok(created, 'instancia creada');
  const inst = ctx.__lastInst;
  assert.equal(inst.options.settings.showMinimap, true);
});

/** Carga un servicio real y espía enable/disable del singleton expuesto. */
function bootService(rel, globalName) {
  const document = fakeDocument();
  const ctx = { console, document, setTimeout, clearTimeout, setInterval, clearInterval,
    MutationObserver: class { observe() {} disconnect() {} } };
  ctx.window = ctx;
  vm.runInNewContext(read(rel), ctx);
  const svc = ctx[globalName];
  const state = { enabled: false, log: [] };
  svc.enable = () => { state.enabled = true; state.log.push('enable'); };
  svc.disable = () => { state.enabled = false; state.log.push('disable'); };
  svc.setColor = () => {};
  svc.setFileColors = () => {};
  svc.setCustomRulesEnabled = () => {};
  return { document, state };
}

for (const [rel, name, key] of [
  ['extension/js/services/gas-folders.js', 'gasFolders', 'gas-folders'],
  ['extension/js/services/gas-error-lens.js', 'gasErrorLens', 'gas-error-lens'],
]) {
  test(`${name}: global-enable off→on con opciones completas lo reactiva`, () => {
    const { document, state } = bootService(rel, name);
    document.dispatch('GAS_TransferData', { settings: FULL });
    assert.equal(state.enabled, true);
    document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': false });
    assert.equal(state.enabled, false);
    document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': true });
    assert.equal(state.enabled, true);
  });

  // En pausa, el delta `{ [key]: true }` no lleva `global-enable` y no debe activarlo.
  test(`${name}: un delta de su toggle en pausa no debe activarlo`, () => {
    const { document, state } = bootService(rel, name);
    document.dispatch('GAS_TransferData', { settings: FULL });
    document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': false, [key]: false });
    document.dispatch('GAS_SettingsUpdated', { [key]: true });
    assert.equal(state.enabled, false);
  });
}

test('gasNativeSearch: global-enable off→on lo reactiva y los deltas ajenos no lo tocan', () => {
  const { document, state } = bootService('extension/js/services/gas-native-search.js', 'gasNativeSearch');
  document.dispatch('GAS_TransferData', { settings: FULL });
  assert.equal(state.enabled, true);
  document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': false });
  assert.equal(state.enabled, false);
  document.dispatch('GAS_SettingsUpdated', { showMinimap: true });
  assert.equal(state.enabled, false);
  document.dispatch('GAS_SettingsUpdated', { ...FULL, 'global-enable': true });
  assert.equal(state.enabled, true);
});
