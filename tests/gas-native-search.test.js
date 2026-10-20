// Tests de la búsqueda multiarchivo (gas-native-search.js): cálculo de
// coincidencias, agrupación, navegación entre archivos y refresco del badge.
// Los casos `BUG:` reproducen fallos ya corregidos (regresiones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '..', 'extension', 'js', 'services', 'gas-native-search.js'),
  'utf8'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DOM mínimo ──────────────────────────────────────────────────────────────

/** Crea un DOM falso con registro por id (suficiente para el módulo). */
function makeDom_() {
  const registry = new Map();
  const docListeners = [];

  class FakeEl {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this._id = '';
      this.className = '';
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.children = [];
      this.parent = null;
      this.listeners = {};
      this.textContent = '';
      this.title = '';
      this._html = '';
      this._sub = {};
      this.rect = { left: 100, right: 122, top: 50, bottom: 72, width: 22, height: 22 };
      this.offsetWidth = 0;
      this.offsetHeight = 0;
      const cls = new Set();
      this.classList = {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { const v = on ?? !cls.has(c); v ? cls.add(c) : cls.delete(c); return v; },
      };
    }
    get id() { return this._id; }
    set id(v) { this._id = v; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    dispatch(t, ev = {}) {
      for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, stopPropagation() {}, target: this, ...ev });
    }
    click() { this.dispatch('click'); }
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      if (child.id) registry.set(child.id, child);
      return child;
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      if (registry.get(this.id) === this) registry.delete(this.id);
      this.parent = null;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
    focus() {}
    getBoundingClientRect() { return this.rect; }
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const el = registry.get(sel.slice(1));
        return el || (this._sub[sel] ||= new FakeEl('input'));
      }
      return (this._sub[sel] ||= new FakeEl('span'));
    }
    /** Devuelve botones a partir del HTML pintado con `data-idx`. */
    querySelectorAll(sel) {
      if (this._lastHtml === this._html && this._lastSel === sel) return this._lastButtons;
      const cls = sel.replace(/^\./, '');
      const out = [];
      const re = /<button class="([^"]*)"\s+data-idx="(\d+)"/g;
      let m;
      while ((m = re.exec(this._html))) {
        if (!m[1].split(/\s+/).includes(cls)) continue;
        const b = new FakeEl('button');
        b.dataset.idx = m[2];
        b.className = m[1];
        out.push(b);
      }
      this._lastButtons = out;
      this._lastHtml = this._html;
      this._lastSel = sel;
      return out;
    }
  }

  const head = new FakeEl('head');
  const body = new FakeEl('body');
  const document = {
    head, body,
    createElement: (t) => new FakeEl(t),
    getElementById: (id) => registry.get(id) || null,
    addEventListener: (t, fn, cap) => docListeners.push({ t, fn, cap }),
    removeEventListener: (t, fn) => {
      const i = docListeners.findIndex((l) => l.t === t && l.fn === fn);
      if (i >= 0) docListeners.splice(i, 1);
    },
  };
  return { FakeEl, document, registry, docListeners };
}

// ── Monaco mínimo ──────────────────────────────────────────────────────────

let uriSeq = 0;
/** Modelo falso con `findMatches` línea a línea (mismas firmas que Monaco). */
function makeModel_(text, { scheme = 'inmemory', id } = {}) {
  const n = id ?? ++uriSeq;
  const uri = { scheme, path: `/${n}`, toString: () => `${scheme}://model/${n}` };
  let lines = text.split('\n');
  let disposed = false;
  const contentSubs = [];
  return {
    uri,
    isDisposed: () => disposed,
    dispose() { disposed = true; },
    setValue(t) { lines = t.split('\n'); contentSubs.forEach((f) => f({})); },
    onDidChangeContent(fn) { contentSubs.push(fn); return { dispose() {} }; },
    getLineContent: (ln) => lines[ln - 1],
    findMatches(search, _onlyEditable, isRegex, matchCase, wordSep) {
      if (disposed) throw new Error('Model is disposed!');
      let re;
      try {
        const src = isRegex ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(src, 'g' + (matchCase ? '' : 'i'));
      } catch (_) { return []; } // Monaco devuelve [] con regex inválida
      const out = [];
      lines.forEach((line, i) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const s = m.index; const e = s + m[0].length;
          if (wordSep) {
            const isSep = (ch) => ch === undefined || /\s/.test(ch) || wordSep.includes(ch);
            if (!isSep(line[s - 1]) || !isSep(line[e])) continue;
          }
          out.push({ range: { startLineNumber: i + 1, startColumn: s + 1, endLineNumber: i + 1, endColumn: e + 1 } });
        }
      });
      return out;
    },
  };
}

/** Editor + findController falsos que registran las llamadas. */
function makeEditor_(dom, model) {
  const stateSubs = [];
  const state = { searchString: '', isRegex: false, matchCase: false, wholeWord: false, isRevealed: true };
  const root = new dom.FakeEl('div');
  const replacePart = new dom.FakeEl('div');
  const toggle = new dom.FakeEl('div');
  root._sub['.replace-part'] = replacePart;
  root._sub['.button.toggle.left'] = toggle;
  const controller = {
    getState: () => ({ ...state, onFindReplaceStateChange: (fn) => { stateSubs.push(fn); return { dispose() { stateSubs.splice(stateSubs.indexOf(fn), 1); } }; } }),
    _widget: { _domNode: root },
  };
  const subs = { model: [], content: [], dispose: [] };
  const calls = [];
  let current = model;
  const editor = {
    calls, state, stateSubs, root, toggle, subs,
    getContribution: (id) => (id === 'editor.contrib.findController' ? controller : null),
    getModel: () => current,
    setModel(m) { calls.push(['setModel', m]); current = m; subs.model.forEach((f) => f()); },
    setPosition: (p) => calls.push(['setPosition', p]),
    revealRangeInCenter: (r) => calls.push(['reveal', r]),
    setSelection: (r) => calls.push(['setSelection', r]),
    focus: () => {},
    trigger: (src, id) => calls.push(['trigger', id]),
    addAction: (a) => { calls.push(['addAction', a.id]); return { dispose: () => calls.push(['disposeAction', a.id]) }; },
    onDidDispose: (fn) => { subs.dispose.push(fn); return { dispose() {} }; },
    onDidChangeModel: (fn) => { subs.model.push(fn); return { dispose() {} }; },
    onDidChangeModelContent: (fn) => { subs.content.push(fn); return { dispose() {} }; },
    getDomNode: () => null,
    /** Simula que el usuario escribe en el find widget. */
    setSearch(patch) { Object.assign(state, patch); stateSubs.slice().forEach((f) => f({})); },
  };
  return editor;
}

/** Carga el script clásico y devuelve servicio + utilidades del entorno. */
function load_({ models, fileMap } = {}) {
  const dom = makeDom_();
  const winListeners = [];
  const createSubs = [];
  const monaco = {
    KeyCode: { KeyF: 36 }, KeyMod: { CtrlCmd: 2048, Alt: 512, Shift: 1024 },
    editor: {
      getModels: () => models.filter((m) => !m.isDisposed()),
      onDidCreateModel: (fn) => { createSubs.push(fn); return { dispose() {} }; },
    },
  };
  const map = new Map(fileMap || []);
  const gasFileMap = Object.assign(new EventTarget(), {
    has: (k) => map.has(k), get: (k) => map.get(k), set: (k, v) => map.set(k, v),
    get size() { return map.size; }, entries: () => map.entries(),
  });
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    HTMLElement: dom.FakeEl,
    document: dom.document,
    innerWidth: 1280, innerHeight: 800,
    addEventListener: (t, fn) => winListeners.push({ t, fn }),
    removeEventListener: (t, fn) => {
      const i = winListeners.findIndex((l) => l.t === t && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
    monaco,
    gasFileMap,
    DomUtils: {
      t: (key, fb = '', ...subs) => subs.reduce((s, v, i) => s.split(`$${i + 1}`).join(String(v)), fb),
      escapeHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      setHTML: (el, html) => { if (el) el._html = String(html); },
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx, { filename: 'gas-native-search.js' });
  return { ctx, dom, winListeners, createSubs, map, svc: ctx.gasNativeSearch, GasNativeSearch: ctx.GasNativeSearch };
}

/** Proyecto típico: tres archivos con distintas coincidencias. */
function project_() {
  const a = makeModel_('function foo() {}\nfoo();\nfoo();');
  const b = makeModel_('const x = 1;');
  const c = makeModel_('// foo\nconst food = 2;');
  const preview = makeModel_('foo foo foo', { scheme: 'gas-preview' });
  const fileMap = [[String(a.uri), 'Code.gs'], [String(b.uri), 'Util.gs'], [String(c.uri), 'Lib.gs']];
  return { a, b, c, preview, models: [a, b, c, preview], fileMap };
}

/** Engancha el servicio a un editor sobre `model` y devuelve todo. */
function attached_(proj, model = proj.a) {
  const env = load_({ models: proj.models, fileMap: proj.fileMap });
  const editor = makeEditor_(env.dom, model);
  env.ctx.jsWireMonacoEditor = editor;
  env.svc.enable();
  // Barra del widget creada a mano (el `_ensureUi_` real necesita DOM real).
  const svc = env.svc;
  const { FakeEl, registry } = env.dom;
  svc._ensureUi_ = function () {
    if (registry.has('qc__nativeSearchButtons')) return;
    const wrap = new FakeEl('div'); wrap.id = 'qc__nativeSearchButtons';
    const file = new FakeEl('span'); file.id = 'qc__nativeSearchFile';
    const pos = new FakeEl('span'); pos.id = 'qc__nativeSearchPos';
    editor.root.appendChild(wrap);
    wrap.appendChild(file);
    wrap.appendChild(pos);
    for (const id of ['qc__nativeSearchPrev', 'qc__nativeSearchNext', 'qc__nativeSearchMatchesBtn', 'qc__nativeSearchTrigger']) {
      const b = new FakeEl('button'); b.id = id; wrap.appendChild(b);
    }
  };
  const badge = () => ({
    file: registry.get('qc__nativeSearchFile')?.textContent,
    pos: registry.get('qc__nativeSearchPos')?.textContent,
    hidden: registry.get('qc__nativeSearchButtons')?.classList.contains('qc__nativeSearchBar--hidden'),
  });
  return { ...env, editor, badge };
}

// ── Parámetros y cálculo de coincidencias ───────────────────────────────────

test('_buildSearchParams_ traslada flags y separadores de palabra', () => {
  const { svc } = load_({ models: [] });
  const p = svc._buildSearchParams_({ searchString: 'foo', isRegex: 1, matchCase: 0, wholeWord: true });
  assert.equal(p.searchString, 'foo');
  assert.equal(p.isRegex, true);
  assert.equal(p.matchCase, false);
  assert.equal(typeof p.wholeWord, 'string');
  assert.ok(p.wholeWord.includes('.') && p.wholeWord.includes('('));
  const empty = svc._buildSearchParams_(null);
  assert.equal(empty.searchString, '');
  assert.equal(empty.wholeWord, null);
});

test('_findAllMatches_ ignora vista previa (gas-preview) y modelos fuera de gasFileMap', () => {
  const proj = project_();
  const stray = makeModel_('foo');            // modelo interno no mapeado
  proj.models.push(stray);
  const { svc } = load_({ models: proj.models, fileMap: proj.fileMap });
  const res = svc._findAllMatches_({ searchString: 'foo', isRegex: false, matchCase: false, wholeWord: null });
  const uris = new Set(res.map((m) => m.uri));
  assert.ok(!uris.has(String(proj.preview.uri)));
  assert.ok(!uris.has(String(stray.uri)));
  assert.equal(res.length, 5); // 3 en Code.gs + 2 en Lib.gs ("foo", "food")
});

test('_findAllMatches_ respeta palabra completa, mayúsculas y regex; vacía o inválida no rompe', () => {
  const proj = project_();
  const { svc } = load_({ models: proj.models, fileMap: proj.fileMap });
  const base = { isRegex: false, matchCase: false, wholeWord: null };
  const ww = svc._buildSearchParams_({ searchString: 'foo', wholeWord: true });
  assert.equal(svc._findAllMatches_(ww).length, 4); // "food" queda fuera
  assert.equal(svc._findAllMatches_({ ...base, searchString: 'FOO', matchCase: true }).length, 0);
  assert.equal(svc._findAllMatches_({ ...base, searchString: 'fo+d', isRegex: true }).length, 1);
  assert.equal(svc._findAllMatches_({ ...base, searchString: '' }).length, 0);
  assert.doesNotThrow(() => svc._findAllMatches_({ ...base, searchString: '(', isRegex: true }));
});

test('_findAllMatches_ sin gasFileMap poblado cae a todos los modelos salvo la vista previa', () => {
  const proj = project_();
  const { svc } = load_({ models: proj.models, fileMap: [] });
  const res = svc._findAllMatches_({ searchString: 'foo', isRegex: false, matchCase: false, wholeWord: null });
  assert.equal(res.length, 5);
});

test('_groupByFile_ agrupa, cuenta y nombra por gasFileMap (o por path)', () => {
  const proj = project_();
  const { svc } = load_({ models: proj.models, fileMap: proj.fileMap.slice(0, 1) });
  const g = svc._groupByFile_([
    { model: proj.a, uri: String(proj.a.uri), range: {} },
    { model: proj.a, uri: String(proj.a.uri), range: {} },
    { model: proj.c, uri: String(proj.c.uri), range: {} },
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].name, 'Code.gs');
  assert.equal(g[0].count, 2);
  assert.equal(g[1].name, proj.c.uri.path.slice(1));
});

// ── Navegación ──────────────────────────────────────────────────────────────

test('_goToAdjacentFile_ salta al primer match del siguiente archivo y envuelve', () => {
  const proj = project_();
  const { svc, editor } = attached_(proj);
  editor.state.searchString = 'foo';
  svc._goToAdjacentFile_('next');
  assert.equal(editor.getModel(), proj.c);
  const pos = editor.calls.find((c) => c[0] === 'setPosition')[1];
  assert.deepEqual({ ...pos }, { lineNumber: 1, column: 4 }); // "// foo" → inicio exacto del match
  assert.ok(editor.calls.some((c) => c[0] === 'trigger' && c[1] === 'editor.action.nextMatchFindAction'));
  svc._goToAdjacentFile_('next');            // envolvente al inicio
  assert.equal(editor.getModel(), proj.a);
  svc._goToAdjacentFile_('previous');        // envolvente al final
  assert.equal(editor.getModel(), proj.c);
});

test('_goToAdjacentFile_ sin búsqueda no hace nada', () => {
  const proj = project_();
  const { svc, editor } = attached_(proj);
  svc._goToAdjacentFile_('next');
  assert.equal(editor.calls.filter((c) => c[0] === 'setModel').length, 0);
});

// ── Refresco del badge ──────────────────────────────────────────────────────

test('el badge muestra archivo y posición tras escribir en el find widget', async () => {
  const proj = project_();
  const { editor, badge } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  assert.deepEqual(badge(), { file: 'Code.gs', pos: '1/2 files', hidden: false });
});

test('búsqueda vacía oculta el badge y cierra el popover de archivos', async () => {
  const proj = project_();
  const { svc, editor, badge, dom } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc._openPopover_({ autoFocusFilter: false });
  assert.ok(dom.registry.has('qc__nativeSearchPopover'));
  editor.setSearch({ searchString: '' });
  await sleep(120);
  assert.equal(badge().hidden, true);
  assert.ok(!dom.registry.has('qc__nativeSearchPopover'));
});

test('teardown libera acciones, suscripciones, timers y listeners del popover', async () => {
  const proj = project_();
  const { svc, editor, dom, winListeners } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc._openPopover_({ autoFocusFilter: false });
  editor.setSearch({ searchString: 'fo' });   // deja un debounce pendiente
  svc.disable();
  assert.equal(editor.stateSubs.length, 0);
  assert.equal(editor.calls.filter((c) => c[0] === 'disposeAction').length, 2);
  assert.equal(svc._debounceTimer, null);
  assert.equal(dom.docListeners.filter((l) => l.t === 'mousedown' || l.t === 'keydown').length, 0);
  assert.equal(winListeners.length, 0);
});

// ── Regresiones de fallos corregidos ──────────────────────────────────────────────

test('BUG: archivo activo sin coincidencias muestra "1/N files" en vez de no posicionado', async () => {
  const proj = project_();
  const { editor, badge } = attached_(proj, proj.b);  // Util.gs no contiene "foo"
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  const b = badge();
  assert.equal(b.file, '—');
  assert.notEqual(b.pos, '1/2 files', 'dice "1/2" aunque el archivo activo no está entre los resultados');
});

test('BUG: cambiar de archivo (sidebar de GAS) sin evento del find state deja el badge desfasado', async () => {
  const proj = project_();
  const { editor, badge } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  editor.setModel(proj.c);                    // GAS cambia de archivo; mismo nº de matches → Monaco no emite
  await sleep(120);
  assert.equal(badge().file, 'Lib.gs');
});

test('BUG: editar o crear otro archivo no refresca recuentos (sin onDidChangeContent/onDidCreateModel/gasFileMap change)', async () => {
  const proj = project_();
  const { editor, badge, svc } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  proj.b.setValue('foo();');                  // otro archivo ahora coincide
  await sleep(120);
  assert.equal(svc._lastGroups.length, 3);
  assert.equal(badge().pos, '1/3 files');
});

test('BUG: editor sin modelo (swap de GAS) lanza TypeError dentro del debounce', () => {
  const proj = project_();
  const { svc, editor } = attached_(proj);
  editor.state.searchString = 'foo';
  editor.getModel = () => null;
  assert.doesNotThrow(() => svc._refreshUi_());
  assert.doesNotThrow(() => svc._goToAdjacentFile_('next'));
});

test('BUG: el popover de coincidencias del archivo no se refresca al cambiar de archivo y salta a un rango ajeno', async () => {
  const proj = project_();
  const other = makeModel_('x\nx\nx\nx\n   foo bar foo');
  proj.models.push(other);
  proj.fileMap.push([String(other.uri), 'Other.gs']);
  const { svc, editor, dom } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc._openMatchesPopover_();                 // lista las 3 líneas de Code.gs
  const pop = dom.registry.get('qc__nativeSearchMatchesPopover');
  const buttons = pop.querySelectorAll('.qc__nativeSearchMatch-item');
  editor.setModel(other);                     // Other.gs también tiene 2 matches
  editor.setSearch({});                       // aunque llegue un evento del state…
  await sleep(120);
  editor.calls.length = 0;
  buttons[2].click();                         // …el botón conserva el rango de Code.gs (línea 3)
  const pos = editor.calls.find((c) => c[0] === 'setPosition')?.[1];
  assert.notEqual(pos?.lineNumber, 3, 'salta a la línea 3 de Other.gs, que no tiene coincidencia');
});

test('BUG: vaciar la búsqueda no cierra el popover de coincidencias del archivo', async () => {
  const proj = project_();
  const { svc, editor, dom } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc._openMatchesPopover_();
  assert.ok(dom.registry.has('qc__nativeSearchMatchesPopover'));
  editor.setSearch({ searchString: '' });
  await sleep(120);
  assert.ok(!dom.registry.has('qc__nativeSearchMatchesPopover'));
});

test('BUG: el snippet resalta la primera aparición, no la coincidencia real', () => {
  const { svc } = load_({ models: [] });
  // Match real en la segunda "foo" (columna 9): debe resaltarse esa.
  const html = svc._renderSnippet_('let a = foo + FOO;', 'FOO', 15);
  assert.equal(html, 'let a = foo + <mark>FOO</mark>;');
  // Línea larga: se recorta antes del match real (prefijo "…") y se resalta ese.
  const long = 'foo' + ' '.repeat(120) + 'foo';
  const out = svc._renderSnippet_(long, 'foo', 124);
  assert.ok(out.startsWith('…'));
  assert.ok(out.endsWith('<mark>foo</mark>'));
  assert.equal(out.split('<mark>').length, 2);
  // El texto se parte en crudo y cada trozo se escapa.
  assert.equal(svc._renderSnippet_('a<b>"x"', '"x"', 5), 'a&lt;b&gt;<mark>&quot;x&quot;</mark>');
});

test('BUG: match multilínea (regex con \\n) calcula mal matchText', () => {
  const proj = project_();
  const { svc, editor } = attached_(proj);
  editor.state.searchString = 'foo\\(\\);\\nfoo';
  editor.state.isRegex = true;
  proj.a.findMatches = () => [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 4 } }];
  const [m] = svc._currentFileMatches_();
  assert.equal(m.matchText, 'foo();', 'debería cubrir hasta el fin de la línea inicial');
});

test('BUG: el orden de archivos sigue getModels(), no el del proyecto (gasFileMap/sidebar)', async () => {
  const proj = project_();
  // Sidebar: Lib.gs antes que Code.gs, pero Monaco creó antes el modelo de Code.gs.
  proj.fileMap = [[String(proj.c.uri), 'Lib.gs'], [String(proj.a.uri), 'Code.gs'], [String(proj.b.uri), 'Util.gs']];
  const { svc } = attached_(proj);
  const groups = svc._groupByFile_(svc._findAllMatches_({ searchString: 'foo', isRegex: false, matchCase: false, wholeWord: null }));
  assert.deepEqual([...groups.map((g) => g.name)], ['Lib.gs', 'Code.gs']);
});

test('BUG: el popover de archivos usa grupos obsoletos y salta a un modelo ya liberado', async () => {
  const proj = project_();
  const { svc, editor, dom } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  proj.c.dispose();                           // el usuario borra Lib.gs
  svc._openPopover_({ autoFocusFilter: false });
  const pop = dom.registry.get('qc__nativeSearchPopover');
  assert.ok(!pop._html.includes('Lib.gs'), 'el popover sigue listando el archivo borrado');
  const btn = pop._lastButtons?.find((b) => b.dataset.idx === '1');
  btn?.click();
  assert.ok(!editor.calls.some((c) => c[0] === 'setModel' && c[1] === proj.c), 'setModel con modelo liberado');
});

test('BUG: el auto-expand del reemplazo se repite en cada tecla (ya no se expande nunca)', async () => {
  const proj = project_();
  const { editor } = attached_(proj);
  let clicks = 0;
  editor.toggle.click = () => { clicks++; editor.toggle.classList.remove('codicon-find-collapsed'); };
  editor.toggle.classList.add('codicon-find-collapsed');
  editor.setSearch({ searchString: 'f' });
  await sleep(120);
  editor.toggle.classList.add('codicon-find-collapsed');   // el usuario lo colapsa
  editor.setSearch({ searchString: 'fo' });
  await sleep(120);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  assert.equal(clicks, 0, 'la barra vive fuera de replace-part: no hace falta expandir Reemplazar');
});

test('BUG: teardown no suelta _lastGroups (retiene modelos y editor previo)', async () => {
  const proj = project_();
  const { svc, editor } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc.disable();
  assert.equal(svc._lastGroups.length, 0);
});

// ── Fuentes de refresco, límites y seguridad ────────────────────────────────

test('F1: crear un modelo o un cambio de gasFileMap refresca los recuentos', async () => {
  const proj = project_();
  const { editor, svc, createSubs, map, ctx } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  assert.equal(svc._lastGroups.length, 2);
  const d = makeModel_('foo');
  proj.models.push(d);
  map.set(String(d.uri), 'New.gs');
  createSubs.forEach((f) => f(d));
  await sleep(120);
  assert.equal(svc._lastGroups.length, 3);
  // Modelo ya existente que entra al mapa: solo llega el evento 'change'.
  const e = makeModel_('foo');
  proj.models.push(e);
  map.set(String(e.uri), 'Late.gs');
  ctx.gasFileMap.dispatchEvent(new Event('change'));
  await sleep(120);
  assert.equal(svc._lastGroups.length, 4);
  // El modelo creado tras el enganche también se vigila.
  d.setValue('nada');
  await sleep(120);
  assert.equal(svc._lastGroups.length, 3);
});

test('F1: ediciones con el widget oculto no recalculan', async () => {
  const proj = project_();
  const { editor, svc } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  editor.state.isRevealed = false;
  let calls = 0;
  const orig = svc._findAllMatches_.bind(svc);
  svc._findAllMatches_ = (p) => { calls++; return orig(p); };
  proj.b.setValue('foo');
  await sleep(120);
  assert.equal(calls, 0);
});

test('F1: teardown suelta la suscripción a gasFileMap', async () => {
  const proj = project_();
  const { editor, svc, ctx } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc.disable();
  let refreshed = 0;
  svc._refreshUi_ = () => { refreshed++; };
  ctx.gasFileMap.dispatchEvent(new Event('change'));
  await sleep(120);
  assert.equal(refreshed, 0);
  assert.equal(svc._modelSubs.size, 0);
});

test('F17: _findAllMatches_ tolera modelos que lanzan y pasa limitResultCount', () => {
  const proj = project_();
  const { svc } = load_({ models: proj.models, fileMap: proj.fileMap });
  const limits = [];
  const origA = proj.a.findMatches;
  proj.a.findMatches = (...args) => { limits.push(args[6]); return origA(...args); };
  const origC = proj.c.findMatches;
  proj.c.findMatches = (...args) => { limits.push(args[6]); return origC(...args); };
  proj.b.findMatches = () => { throw new Error('boom'); };
  const res = svc._findAllMatches_({ searchString: 'foo', isRegex: false, matchCase: false, wholeWord: null });
  assert.equal(res.length, 5);
  assert.deepEqual(limits, [1000, 997]);
});

test('F17: _findAllMatches_ corta al superar el presupuesto de tiempo', () => {
  const proj = project_();
  const { svc } = load_({ models: proj.models, fileMap: proj.fileMap });
  const origA = proj.a.findMatches;
  proj.a.findMatches = (...args) => { const t = Date.now(); while (Date.now() - t < 60) { /* regex lenta */ } return origA(...args); };
  const res = svc._findAllMatches_({ searchString: 'foo', isRegex: false, matchCase: false, wholeWord: null });
  assert.equal(res.length, 3, 'Lib.gs no se recorre tras agotar el presupuesto');
});

test('SEC1: _countHtml_ parte el texto crudo y no rompe entidades', () => {
  const { svc, ctx } = load_({ models: [] });
  ctx.DomUtils.escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  ctx.DomUtils.t = () => "l'3 <b>files";
  assert.equal(svc._countHtml_(3, 'file'), 'l&#39;<strong>3</strong> &lt;b&gt;files');
  ctx.DomUtils.t = () => '<i>sin número';
  assert.equal(svc._countHtml_(3, 'file'), '&lt;i&gt;sin número');
});

test('SEC2: _iconForFile_ solo acepta SVG de gasFolders', () => {
  const { svc, ctx } = load_({ models: [] });
  ctx.gasFolders = { _renderFileSvg_: () => '<img src=x onerror=alert(1)>' };
  assert.ok(svc._iconForFile_('a.gs').startsWith('<svg'));
  assert.ok(!svc._iconForFile_('a.gs').includes('onerror'));
  ctx.gasFolders = { _renderFileSvg_: () => ({ toString: () => '<svg/>' }) };
  assert.equal(svc._iconForFile_('a.gs'), svc._fileSvg_());
  ctx.gasFolders = { _renderFileSvg_: () => '<svg data-ok="1"></svg>' };
  assert.equal(svc._iconForFile_('a.gs'), '<svg data-ok="1"></svg>');
});

test('F8: la barra se inserta como hija del widget, después de .replace-part', () => {
  const proj = project_();
  const env = load_({ models: proj.models, fileMap: proj.fileMap });
  const editor = makeEditor_(env.dom, proj.a);
  env.ctx.jsWireMonacoEditor = editor;
  env.svc.enable();
  const replacePart = editor.root._sub['.replace-part'];
  const positions = [];
  replacePart.parentNode = editor.root;
  replacePart.insertAdjacentElement = (where, el) => { positions.push(where); editor.root.appendChild(el); };
  // El DOM falso devuelve un nodo para cualquier id: la barra aún no existe.
  const baseQs = editor.root.querySelector.bind(editor.root);
  editor.root.querySelector = (sel) => (sel === '#qc__nativeSearchButtons'
    ? env.dom.registry.get('qc__nativeSearchButtons') || null
    : baseQs(sel));
  env.svc._ensureUi_();
  const bar = env.dom.registry.get('qc__nativeSearchButtons');
  assert.ok(bar);
  assert.equal(bar.parent, editor.root);
  assert.deepEqual(positions, ['afterend']);
  assert.ok(!replacePart.children.includes(bar));
});

test('F14: popover de archivos sin resultados ni filtro muestra "sin coincidencias"', async () => {
  const proj = project_();
  const { svc, editor, dom } = attached_(proj);
  editor.setSearch({ searchString: 'zzz' });
  await sleep(120);
  svc._openPopover_({ autoFocusFilter: false });
  const pop = dom.registry.get('qc__nativeSearchPopover');
  assert.ok(pop._html.includes('No matches in the project'));
  assert.ok(!pop._html.includes('No files match this filter'));
});

test('F15: el filtro ignora la composición IME y repinta solo la lista', async () => {
  const proj = project_();
  const { svc, editor, dom } = attached_(proj);
  editor.setSearch({ searchString: 'foo' });
  await sleep(120);
  svc._openPopover_({ autoFocusFilter: false });
  const pop = dom.registry.get('qc__nativeSearchPopover');
  const before = pop._html;
  const input = pop.querySelector('#qc__nativeSearchPopoverFilter');
  input.dispatch('input', { target: { value: 'Li' }, isComposing: true });
  assert.equal(svc._popoverFilter, '');
  input.dispatch('compositionend', { target: { value: 'Lib' } });
  assert.equal(svc._popoverFilter, 'Lib');
  assert.equal(pop._html, before, 'no se repinta el popover completo');
  const list = pop.querySelector('.qc__nativeSearchPopover-list');
  assert.ok(list._html.includes('<mark>Lib</mark>'));
  assert.ok(!list._html.includes('Code.gs'));
});

test('D3: rutas largas separan carpeta (truncable) y nombre base', () => {
  const { svc } = load_({ models: [] });
  const html = svc._pathHtml_('src/utils/<x>.gs', 'ut');
  assert.equal(html, '<span class="qc__nativeSearchPath-dir"><bdi>src/<mark>ut</mark>ils/</bdi></span><span class="qc__nativeSearchPath-base">&lt;x&gt;.gs</span>');
  assert.equal(svc._pathHtml_('Code.gs'), '<span class="qc__nativeSearchPath-base">Code.gs</span>');
});
