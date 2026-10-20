// Tests del visor amplio del diff de GitHub (extension/js/services/gas-diff-viewer.js):
// Monaco simulado con y sin createDiffEditor, modelos gas-ghdiff: liberados,
// copiar bloque, Esc, navegación y onResolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Modelo de Monaco mínimo (valor, rangos y ediciones). */
function fakeModel(text, lang, uri) {
  let value = String(text);
  let disposed = false;
  const lines = () => value.split('\n');
  const offset = (line, col) => lines().slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  return {
    uri, lang,
    getValue: () => value,
    setValue: (t) => { value = String(t); },
    dispose: () => { disposed = true; },
    isDisposed: () => disposed,
    getLineCount: () => lines().length,
    getLineMaxColumn: (n) => lines()[n - 1].length + 1,
    getValueInRange: (r) => value.slice(offset(r.startLineNumber, r.startColumn), offset(r.endLineNumber, r.endColumn)),
    pushStackElement() {},
    pushEditOperations(_sel, ops) {
      for (const { range: r, text: t } of ops) {
        value = value.slice(0, offset(r.startLineNumber, r.startColumn)) + t + value.slice(offset(r.endLineNumber, r.endColumn));
      }
      return null;
    },
  };
}

/** Monaco simulado; `diff:false` quita createDiffEditor (respaldo). */
function fakeMonaco({ diff = true, changes = () => [] } = {}) {
  const state = { models: [], editors: [], reveals: [] };
  const sideEditor = (name) => ({
    revealLineInCenter: (n) => state.reveals.push([name, n]),
    setPosition() {}, updateOptions() {}, focus() {},
    getPosition: () => (name === 'modified' && state.cursorLine ? { lineNumber: state.cursorLine, column: 1 } : null),
  });
  const editor = {
    createModel: (text, lang, uri) => { const m = fakeModel(text, lang, uri); state.models.push(m); return m; },
  };
  if (diff) {
    editor.createDiffEditor = (el, opts) => {
      const ed = {
        el, opts: { ...opts }, model: null, disposed: false,
        setModel(m) { this.model = m; },
        updateOptions(o) { Object.assign(this.opts, o); },
        getLineChanges: () => changes(),
        getModifiedEditor: () => mod,
        getOriginalEditor: () => orig,
        onDidUpdateDiff(cb) { this.fireUpdate = cb; return { dispose() {} }; },
        dispose() { this.disposed = true; },
      };
      const mod = sideEditor('modified');
      const orig = sideEditor('original');
      state.editors.push(ed);
      return ed;
    };
  }
  return {
    state,
    monaco: { editor, Uri: { parse: (s) => ({ scheme: s.slice(0, s.indexOf(':')), toString: () => s }) } },
  };
}

/** Contexto con DomUtils, GasUi, GasLineDiff, el mixin de badges y el visor; la UI se simula. */
function loadViewer(monaco) {
  const listeners = { window: [], document: [] };
  const ctx = {
    console, setTimeout, clearTimeout,
    monaco,
    document: {
      activeElement: { focus() { ctx.__refocused = true; } },
      addEventListener: (t, f) => listeners.document.push(['add', t, f]),
      removeEventListener: (t, f) => listeners.document.push(['remove', t, f]),
    },
    addEventListener: (t, f) => listeners.window.push(['add', t, f]),
    removeEventListener: (t, f) => listeners.window.push(['remove', t, f]),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of [
    'extension/js/services/dom-utils.js',
    'extension/js/shared/gas-ui.js',
    'extension/js/shared/line-diff.js',
    'extension/js/components/gas-github-panel-diff.js',
    'extension/js/services/gas-diff-viewer.js',
  ]) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext('globalThis.__V = GasDiffViewer;', ctx);
  const ui = {
    editorEl: { tag: 'editor' }, removed: false, list: '', bar: null, message: null, fallback: null,
    contains: () => true,
    remove() { this.removed = true; },
    focused: [],
    focusFirst() {}, focusFile() {},
    focusAct(act) { this.focused.push(act); },
    onKeyDown() {},
    trapTab() {},
    monacoWidgetOpen() { return !!this.widgetOpen; },
    setList(html) { this.list = html; },
    setMessage(t) { this.message = t; },
    setFallback(h) { this.fallback = h; },
    fallbackChanges: () => [],
    revealFallbackChange() {},
    setBar(st) { this.bar = st; },
  };
  ctx.__V.prototype._buildUi_ = () => ui;
  return { ctx, viewer: ctx.window.gasDiffViewer, ui, listeners };
}

const ITEMS = () => [
  { path: 'a.gs', status: 'mod', origin: 'local', local: 'x = 2;', remote: 'x = 1;' },
  { path: 'c.gs', status: 'mod', origin: 'conflict', local: 'a\nX\nc', remote: 'a\nB\nc', base: 'a\nb\nc' },
  { path: 'big.gs', status: 'mod', origin: 'unknown', local: 'q', remote: '', unavailable: 'tooLarge' },
];

test('abre un DiffEditor con modelos gas-ghdiff: (izquierda GitHub, derecha GAS) y los libera', () => {
  const { monaco, state } = fakeMonaco();
  const { viewer, ui, listeners } = loadViewer(monaco);
  let closed = 0;
  assert.equal(viewer.open({ items: ITEMS(), activePath: 'a.gs', onClose: () => closed++ }), true);
  assert.equal(viewer.isOpen(), true);
  assert.equal(viewer._s, undefined, 'el estado no es accesible desde la página');
  const ed = state.editors[0];
  assert.equal(ed.el, ui.editorEl, 'el editor va en el contenedor del light DOM');
  assert.equal(ed.opts.renderSideBySide, true);
  assert.equal(ed.opts.readOnly, true);
  const [orig, mod] = state.models;
  assert.equal(orig.uri.scheme, 'gas-ghdiff');
  assert.equal(mod.uri.scheme, 'gas-ghdiff');
  assert.equal(orig.getValue(), 'x = 1;');
  assert.equal(mod.getValue(), 'x = 2;');
  assert.equal(orig.lang, 'plaintext', '.gs como texto: sin ámbito compartido con el worker JS del proyecto');
  assert.equal(ui.bar.left, 'GitHub');
  assert.equal(ui.bar.right, 'GAS');
  assert.match(ui.list, /qc__gh-diffOrigin local/, 'la lista reutiliza los badges del panel');
  assert.match(ui.list, /aria-current="true"/);

  // Cambiar de archivo libera los modelos anteriores.
  viewer._act_('file', '1');
  assert.equal(orig.isDisposed() && mod.isDisposed(), true);
  assert.equal(ed.model.original.getValue(), 'a\nB\nc');

  // Lado a lado ↔ en línea.
  viewer._act_('layout');
  assert.equal(ed.opts.renderSideBySide, false);
  assert.equal(ui.bar.inline, true);

  viewer.close();
  assert.equal(viewer.isOpen(), false);
  assert.ok(state.models.every((m) => m.isDisposed()), 'ningún modelo gas-ghdiff queda vivo');
  assert.equal(ed.disposed, true);
  assert.equal(ui.removed, true);
  assert.equal(closed, 1);
  const removed = listeners.window.filter(([op]) => op === 'remove').map(([, t]) => t);
  assert.deepEqual(removed, ['pagehide'], 'el teclado se escucha en el host, no en window');
  for (const t of ['focusin', 'GAS_HidePanels', 'GAS_GlobalDisable']) {
    assert.ok(listeners.document.some(([op, tt]) => op === 'remove' && tt === t), t);
  }
});

test('sin createDiffEditor usa el respaldo en dos columnas (escapado) y sin modelos', () => {
  const { monaco, state } = fakeMonaco({ diff: false });
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: [{ path: 'x.html', status: 'mod', origin: 'remote', local: '<b>gas</b>', remote: '<i>gh</i>' }] });
  assert.equal(state.models.length, 0);
  assert.match(ui.fallback, /&lt;i&gt;gh&lt;\/i&gt;/);
  assert.match(ui.fallback, /&lt;b&gt;gas&lt;\/b&gt;/);
  assert.ok(!/<b>gas/.test(ui.fallback));
  assert.match(ui.fallback, /dv__del[^>]*>1<\/td>.*dv__add[^>]*>1<\/td>/s, 'GitHub a la izquierda, GAS a la derecha');
  assert.equal(ui.bar.show.layout, false);
  assert.equal(ui.bar.show.edit, false);
  viewer.close();
});

test('resolver: Quedarme con GAS / Traer de GitHub llaman a onResolve', () => {
  const { monaco } = fakeMonaco();
  const { viewer, ui } = loadViewer(monaco);
  const got = [];
  viewer.open({ items: ITEMS(), activePath: 'a.gs', onResolve: (p, r) => got.push([p, r]) });
  viewer._act_('keep-local');
  viewer._act_('take-remote');
  const snap = { local: 'x = 2;', remote: 'x = 1;' };
  assert.deepEqual(plain(got), [['a.gs', { action: 'keep-local', ...snap }], ['a.gs', { action: 'take-remote', ...snap }]],
    'cada decisión lleva la instantánea que se mostró');
  assert.equal(ui.bar.pressed['take-remote'], true);
  assert.match(ui.list, /Take GitHub/);
  assert.equal(ui.bar.show.edit, false, 'Editar resultado solo en conflictos');
  viewer.close();
});

test('conflicto: editar resultado, copiar bloque (cursor o navegación) y guardar como merged', () => {
  let changes = [{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }];
  const { monaco, state } = fakeMonaco({ changes: () => changes });
  const { viewer, ui } = loadViewer(monaco);
  const got = [];
  viewer.open({ items: ITEMS(), activePath: 'c.gs', onResolve: (p, r) => { got.push([p, r]); return true; } });
  const ed = state.editors[0];
  assert.equal(ui.bar.show.edit, true);
  assert.equal(viewer.copyBlockFromGithub(), false, 'fuera de la edición no se copia');
  viewer._act_('edit');
  assert.equal(ed.opts.readOnly, false);
  assert.equal(ui.bar.right, 'Result (editable)');
  assert.equal(ui.bar.mode, 'edit');
  assert.equal(ui.bar.copyLabel, 'Copy block from GitHub');
  assert.equal(viewer.copyBlockFromGithub(), true);
  const modified = ed.model.modified;
  assert.equal(modified.getValue(), 'a\nB\nc');
  assert.equal(viewer.copyBlockFromGithub(), false, 'hasta que Monaco recalcule el diff no se vuelve a copiar');
  assert.equal(ui.bar.disabled['copy-block'], true);
  ed.fireUpdate();
  assert.equal(ui.bar.disabled['copy-block'], false);

  // Bloque solo en GAS (se quita) y solo en GitHub (se inserta).
  modified.setValue('a\nB\nextra\nc');
  changes = [{ originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 3 }];
  viewer.copyBlockFromGithub();
  assert.equal(modified.getValue(), 'a\nB\nc');
  ed.fireUpdate();
  modified.setValue('a\nc');
  changes = [{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 }];
  viewer.copyBlockFromGithub();
  assert.equal(modified.getValue(), 'a\nB\nc');
  ed.fireUpdate();

  // Con el cursor en el segundo bloque se copia ese, no el de la navegación.
  modified.setValue('1\nX\n3\nY\n5');
  ed.model.original.setValue('1\nA\n3\nB\n5');
  changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 4, originalEndLineNumber: 4, modifiedStartLineNumber: 4, modifiedEndLineNumber: 4 },
  ];
  state.cursorLine = 4;
  viewer.copyBlockFromGithub();
  assert.equal(modified.getValue(), '1\nX\n3\nB\n5');
  state.cursorLine = 0;
  ed.fireUpdate();
  modified.setValue('a\nB\nc');
  ed.model.original.setValue('a\nB\nc');

  // Ver la base en el lado izquierdo (modelo gas-ghdiff también); la copia lo indica.
  viewer._act_('base');
  assert.equal(ed.model.original.getValue(), 'a\nb\nc');
  assert.equal(ui.bar.left, 'Base (last sync)');
  assert.equal(ui.bar.copyLabel, 'Copy block from base');
  assert.equal(ui.bar.pressed.base, true);

  viewer._act_('save-merge');
  assert.deepEqual(plain(got), [['c.gs', { action: 'merged', content: 'a\nB\nc', local: 'a\nX\nc', remote: 'a\nB\nc' }]]);
  assert.equal(ed.opts.readOnly, true);
  viewer.close();
  assert.ok(state.models.every((m) => m.isDisposed()), 'también el modelo de la base');
});

test('decisión rechazada por el panel (diff cambiado): no se marca y se avisa', () => {
  const { monaco } = fakeMonaco();
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: ITEMS(), activePath: 'a.gs', onResolve: () => false });
  viewer._act_('take-remote');
  assert.equal(ui.bar.pressed['take-remote'], false);
  assert.match(ui.bar.state, /comparison changed/);
  viewer.close();
});

test('Esc: en edición nunca descarta (lleva el foco a Guardar); con widget de Monaco no actúa', () => {
  const changes = [{ originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 }];
  const { monaco, state } = fakeMonaco({ changes: () => changes });
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: ITEMS(), activePath: 'c.gs' });
  viewer._act_('edit');
  state.editors[0].model.modified.setValue('tocado');
  let stopped = 0;
  const esc = () => ({ key: 'Escape', defaultPrevented: false, preventDefault() {}, stopPropagation() { stopped++; } });

  ui.widgetOpen = true;
  viewer._onKeyDown_(esc());
  assert.equal(stopped, 0, 'el suggest/find de Monaco se cierra solo');
  ui.widgetOpen = false;

  viewer._onKeyDown_(esc());
  assert.equal(viewer.isOpen(), true);
  assert.equal(state.editors[0].model.modified.getValue(), 'tocado', 'no se descarta');
  assert.deepEqual(ui.focused, ['save-merge']);
  assert.equal(stopped, 1, 'Escape no llega al panel ni a GAS');

  // Cerrar con cambios guarda un borrador que se recupera al volver a editar.
  viewer._act_('close');
  assert.equal(viewer.hasDraft('c.gs'), true);
  viewer.open({ items: ITEMS(), activePath: 'c.gs' });
  viewer._act_('edit');
  assert.equal(state.editors[1].model.modified.getValue(), 'tocado');
  assert.match(ui.bar.state, /restored/);
  viewer._act_('cancel-edit');
  assert.equal(viewer.hasDraft('c.gs'), false);
  viewer._onKeyDown_(esc());
  assert.equal(viewer.isOpen(), false, 'fuera de la edición, Esc cierra');
});

test('cierre forzado con GAS_HidePanels y GAS_GlobalDisable', () => {
  const { monaco } = fakeMonaco();
  const { viewer, listeners } = loadViewer(monaco);
  for (const evt of ['GAS_HidePanels', 'GAS_GlobalDisable']) {
    viewer.open({ items: ITEMS() });
    const handler = [...listeners.document].reverse().find(([op, t]) => op === 'add' && t === evt)[2];
    handler();
    assert.equal(viewer.isOpen(), false, evt);
  }
});

test('las decisiones solo se ofrecen donde tienen efecto', () => {
  const { monaco } = fakeMonaco();
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: [
    { path: 'g.gs', status: 'del', origin: 'remote', local: '', remote: 'R' },
    { path: 'h.gs', status: 'add', origin: 'remote', local: 'H', remote: '' },
  ] });
  assert.equal(ui.bar.show['keep-local'], false, 'solo en GitHub: el push no lo borra');
  assert.equal(ui.bar.show['take-remote'], true);
  viewer._act_('file', '1');
  assert.equal(ui.bar.show['keep-local'], true);
  assert.equal(ui.bar.show['take-remote'], false, 'solo en GAS: el pull no lo borra');
  viewer.close();
});

test('navegación entre cambios: Alt+↓/↑ y botones centran la línea en ambos lados', () => {
  const changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 9, originalEndLineNumber: 9, modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 },
  ];
  const { monaco, state } = fakeMonaco({ changes: () => changes });
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: ITEMS(), activePath: 'c.gs' });
  viewer._act_('next');
  viewer._onKeyDown_({ key: 'ArrowDown', altKey: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(state.reveals.filter(([s]) => s === 'modified').map(([, n]) => n), [2, 10]);
  assert.equal(ui.bar.count, 'Change 2 of 2');
  viewer._act_('prev');
  assert.equal(ui.bar.count, 'Change 1 of 2');
  viewer.close();
});

test('archivo no disponible: aviso y sin acciones de resolución', () => {
  const { monaco } = fakeMonaco();
  const { viewer, ui } = loadViewer(monaco);
  viewer.open({ items: ITEMS(), activePath: 'big.gs' });
  assert.match(ui.message, /not available/);
  assert.equal(ui.bar.show['keep-local'], false);
  assert.equal(viewer.open({ items: [] }), false, 'sin cambios no abre');
  assert.equal(viewer.isOpen(), true, 'y no cierra el actual');
  viewer.close();
});
