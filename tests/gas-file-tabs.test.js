// Tests de las pestañas de archivos (gas-file-tabs.js): sincronía con el
// árbol de GAS, cambio por clic sintético con respaldo setModel, cierre,
// renombres/bajas, punto de "sin guardar", vista previa, menú y teardown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'extension', 'js', 'services', 'gas-file-tabs.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── DOM mínimo ──────────────────────────────────────────────────────────────

/** Lista de listeners con soporte de captura (document y window). */
function makeTarget_() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, opts) { listeners.push({ type, fn, capture: opts === true || !!opts?.capture }); },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || !!opts?.capture;
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent(ev) { listeners.filter((l) => l.type === ev.type).forEach((l) => l.fn(ev)); return true; },
  };
}

function makeDom_() {
  let documentElement = null;

  class FakeNode {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.attrs = {};
      this.children = [];
      this.parentNode = null;
      this.events = [];
      this.listeners = {};
      this.sel = [];
      this._html = '';
      this.rect = { left: 0, right: 100, top: 0, bottom: 32, width: 100, height: 32 };
      const props = {};
      this.style = {
        setProperty: (k, v) => { props[k] = v; },
        removeProperty: (k) => { delete props[k]; },
        getPropertyValue: (k) => props[k] || '',
      };
      const cls = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { const v = on ?? !cls.has(c); if (v) cls.add(c); else cls.delete(c); return v; },
      };
    }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = v; }
    get parentElement() { return this.parentNode instanceof FakeNode ? this.parentNode : null; }
    get isConnected() {
      for (let n = this; n; n = n.parentNode) if (n === documentElement) return true;
      return false;
    }
    get nextSibling() {
      const sib = this.parentNode?.children || [];
      return sib[sib.indexOf(this) + 1] || null;
    }
    appendChild(c) { c.remove?.(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) {
      c.remove?.();
      c.parentNode = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    }
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    dispatchEvent(ev) { this.events.push(ev.type); (this.listeners[ev.type] || []).forEach((f) => f(ev)); return true; }
    matches(sel) { return sel.split(',').some((s) => this.sel.includes(s.trim())); }
    closest(sel) { for (let n = this; n instanceof FakeNode; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelector(sel) { return this.qs?.(sel) ?? null; }
    querySelectorAll(sel) { return this.qsa?.(sel) ?? []; }
    attachShadow() {
      const root = new FakeNode('#shadow');
      root.activeElement = null;
      root.adoptedStyleSheets = [];
      this.shadowRoot = root;
      return root;
    }
    getBoundingClientRect() { return this.rect; }
    focus() {}
    scrollIntoView() {}
  }

  documentElement = new FakeNode('html');
  const body = documentElement.appendChild(new FakeNode('body'));
  const docTarget = makeTarget_();
  const tree = { ul: new FakeNode('ul'), lis: [] };
  tree.ul.qs = (sel) => (sel === 'li[role="option"]' ? tree.lis[0] || null : null);
  body.appendChild(tree.ul);

  const document = {
    ...docTarget,
    documentElement,
    body,
    createElement: (t) => new FakeNode(t),
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'ul[role="listbox"] li[role="option"][data-res-id]') return tree.lis.filter((li) => li.isConnected);
      if (sel === 'ul[role="listbox"]') return [tree.ul];
      return [];
    },
  };

  // Editor: wrapper > ancla (.LjDxcd) > contenedor de Monaco.
  const wrapper = body.appendChild(new FakeNode('div'));
  const anchor = wrapper.appendChild(new FakeNode('div'));
  anchor.sel = ['.LjDxcd'];
  const container = anchor.appendChild(new FakeNode('div'));
  return { FakeNode, document, body, tree, wrapper, anchor, container };
}

// ── Monaco mínimo ───────────────────────────────────────────────────────────

let uriSeq = 0;
function makeModel_({ scheme = 'inmemory' } = {}) {
  const n = ++uriSeq;
  const uri = { scheme, path: `/${n}`, toString: () => `${scheme}://model/${n}` };
  let version = 1;
  const history = [1];
  const subs = new Set();
  return {
    uri,
    subs,
    isDisposed: () => false,
    getAlternativeVersionId: () => version,
    onDidChangeContent(fn) { subs.add(fn); return { dispose: () => subs.delete(fn) }; },
    edit() { version = history.length + 1; history.push(version); subs.forEach((f) => f({})); },
    undo() { history.pop(); version = history[history.length - 1]; subs.forEach((f) => f({})); },
  };
}

function makeEnv_({ names = ['Code.gs', 'Util.gs', 'Page.html', 'appsscript.json'] } = {}) {
  const dom = makeDom_();
  const models = names.map(() => makeModel_());
  const fileMap = new Map(names.map((n, i) => [String(models[i].uri), n]));
  const changeSubs = new Set();
  const disposeSubs = new Set();
  const createSubs = new Set();
  const editor = {
    _model: models[0],
    layouts: 0,
    getModel() { return this._model; },
    setModel(m) { this._model = m; changeSubs.forEach((f) => f({ newModelUrl: m.uri })); },
    onDidChangeModel(fn) { changeSubs.add(fn); return { dispose: () => changeSubs.delete(fn) }; },
    onDidDispose(fn) { disposeSubs.add(fn); return { dispose: () => disposeSubs.delete(fn) }; },
    getContainerDomNode: () => dom.container,
    layout() { this.layouts++; },
    focus() {},
  };
  const gas = { ignoreClicks: false };
  const byResId = new Map();
  const makeLi = (resId, title, model) => {
    const li = new dom.FakeNode('li');
    li.attrs = { role: 'option', 'data-res-id': resId, 'aria-selected': 'false', 'aria-label': title };
    const titleDiv = new dom.FakeNode('div');
    titleDiv.attrs.title = title;
    li.renaming = false;
    li.nativeDirty = false;
    li.dirtyDot = new dom.FakeNode('span');
    li.qs = (sel) => {
      if (sel === 'div[title]') return titleDiv;
      if (sel === 'input') return li.renaming ? new dom.FakeNode('input') : null;
      if (sel === '.dirty-dot') return li.nativeDirty ? li.dirtyDot : null;
      return null;
    };
    li.titleDiv = titleDiv;
    li.addEventListener('click', () => { if (!gas.ignoreClicks) gas.select(resId); });
    byResId.set(resId, { li, model });
    dom.tree.ul.appendChild(li);
    dom.tree.lis.push(li);
    return li;
  };
  gas.select = (resId) => {
    for (const li of dom.tree.lis) li.attrs['aria-selected'] = String(li.attrs['data-res-id'] === resId);
    editor.setModel(byResId.get(resId).model);
  };
  gas.remove = (resId) => {
    const { li } = byResId.get(resId);
    li.remove();
    dom.tree.lis = dom.tree.lis.filter((x) => x !== li);
  };
  names.forEach((n, i) => makeLi(`r${i}`, n, models[i]));
  dom.tree.lis[0].attrs['aria-selected'] = 'true';

  const disposedMonaco = { count: 0 };
  const winTarget = makeTarget_();
  const copied = [];
  const toasts = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: dom.document,
    ...winTarget,
    module: { exports: {} },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.active = false; ctx.__observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    __observers: [],
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: (node) => ({ filter: 'none', position: 'static', top: '0px', backgroundColor: node?.bg || 'rgba(0, 0, 0, 0)', color: '' }),
    location: { pathname: '/home/projects/abc/edit' },
    MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    jsWireMonacoEditor: editor,
    gasFileMap: { get: (uri) => fileMap.get(uri) },
    monaco: {
      editor: {
        getModels: () => [...models],
        onDidCreateModel(fn) { createSubs.add(fn); return { dispose: () => { createSubs.delete(fn); disposedMonaco.count++; } }; },
        onWillDisposeModel() { return { dispose: () => { disposedMonaco.count++; } }; },
      },
    },
    DomUtils: {
      escapeHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      setHTML(el, html) { el._html = html; },
      t(_k, fallback, ...subs) { return subs.reduce((s, v, i) => s.split(`$${i + 1}`).join(String(v)), fallback); },
      debug() {},
    },
    GasUi: {
      adopt: () => true,
      icon: (name) => `<svg data-icon="${name}"></svg>`,
      positionPopover: () => true,
      toast: (_t, opts) => toasts.push(opts),
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const { GasFileTabs } = ctx.module.exports;
  GasFileTabs.SWITCH_FALLBACK_MS = 20;
  GasFileTabs.SAVE_SETTLE_MS = 20;
  GasFileTabs.DELETE_GRACE_MS = 0;
  const svc = new GasFileTabs();
  const ids = () => [...svc.tabs.map((t) => t.resId)];
  const html = () => svc._bar?._html || '';
  return { dom, ctx, svc, editor, models, gas, byResId, ids, html, copied, toasts, createSubs, disposedMonaco, GasFileTabs };
}

/** Selecciona en el árbol (como si el usuario hiciera clic) y sincroniza. */
function openFromTree_(env, resId) {
  env.gas.select(resId);
  env.svc.refresh();
}

// ── Casos ───────────────────────────────────────────────────────────────────

test('al activar crea la pestaña del archivo activo y monta la barra antes del ancla', () => {
  const env = makeEnv_();
  env.svc.enable();
  assert.deepEqual(env.ids(), ['r0']);
  assert.equal(env.svc.activeResId, 'r0');
  const host = env.dom.wrapper.children[0];
  assert.equal(host.id, 'qc__fileTabsHost');
  assert.equal(host.nextSibling, env.dom.anchor, 'hermano anterior del contenedor del editor');
  assert.match(env.html(), /role="tab"[^>]*data-res-id="r0"[^>]*aria-selected="true" tabindex="0"/);
  assert.ok(!/tab__close/.test(env.html()), 'la única pestaña no tiene ×');
  env.svc.disable();
});

test('al cargar sin aria-selected deduce la pestaña del archivo abierto por el modelo', () => {
  const env = makeEnv_();
  env.dom.tree.lis.forEach((li) => { li.attrs['aria-selected'] = 'false'; });
  env.editor._model = env.models[1];
  env.svc.enable();
  assert.deepEqual(env.ids(), ['r1']);
  assert.equal(env.svc.activeResId, 'r1');
  assert.match(env.html(), /data-res-id="r1"[^>]*aria-selected="true"/);
  env.svc.disable();
});

test('la deducción inicial se corrige cuando el árbol marca otro archivo', () => {
  const env = makeEnv_();
  env.dom.tree.lis.forEach((li) => { li.attrs['aria-selected'] = 'false'; });
  env.editor._model = env.models[1];
  env.svc.enable();
  assert.deepEqual(env.ids(), ['r1']);
  // GAS marca tarde el archivo real (el mapeo de nombres había fallado).
  env.dom.tree.lis[2].attrs['aria-selected'] = 'true';
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r2']);
  assert.equal(env.svc.activeResId, 'r2');
  env.svc.disable();
});

test('si GAS desplaza el contenedor con overflow oculto, la barra vuelve a verse entera', () => {
  const env = makeEnv_();
  env.svc.enable();
  const wrapper = env.svc._host.parentElement;
  env.ctx.getComputedStyle = (node) => ({
    filter: 'none', position: 'static', top: '0px', backgroundColor: 'rgba(0, 0, 0, 0)', color: '',
    overflowY: node === wrapper ? 'hidden' : 'visible',
  });
  wrapper.scrollTop = 13; // Monaco tomó el foco y el navegador desplazó el contenedor.
  wrapper.contains = (n) => n === env.svc._host;
  const onScroll = env.dom.document.listeners.find((l) => l.type === 'scroll' && l.capture);
  assert.ok(onScroll, 'escucha scroll en captura');
  onScroll.fn({ target: wrapper });
  assert.equal(wrapper.scrollTop, 0);
  env.svc.disable();
  assert.ok(!env.dom.document.listeners.some((l) => l.type === 'scroll'), 'sin fuga del listener scroll');
});

test('el icono de la pestaña es el mismo SVG de color del árbol (gasFolders) y se filtra', () => {
  const env = makeEnv_();
  env.ctx.gasFolders = { _renderFileSvg_: (type) => `<svg data-tree="${type}"></svg>` };
  env.svc.enable();
  openFromTree_(env, 'r2');
  assert.match(env.html(), /<svg data-tree="gs">/);
  assert.match(env.html(), /<svg data-tree="html">/);
  env.ctx.gasFolders = { _renderFileSvg_: () => '<svg onload="x()"></svg>' };
  assert.match(env.GasFileTabs._fileIconHtml_('a.gs'), /data-icon="code"/, 'SVG sospechoso → icono genérico');
  delete env.ctx.gasFolders;
  assert.match(env.GasFileTabs._fileIconHtml_('a.json'), /data-icon="file"/);
  env.svc.disable();
});

test('abrir otro archivo no cierra la pestaña inicial deducida (caso real de GAS)', () => {
  const env = makeEnv_();
  // GAS abre Code.gs al cargar pero nunca lo marca con aria-selected.
  env.dom.tree.lis.forEach((li) => { li.attrs['aria-selected'] = 'false'; });
  env.svc.enable();
  assert.deepEqual(env.ids(), ['r0']);
  env.models[0].edit();
  // El usuario abre Util.gs desde el árbol: cambia árbol y modelo.
  openFromTree_(env, 'r1');
  assert.deepEqual(env.ids(), ['r0', 'r1'], 'la pestaña inicial sigue abierta');
  assert.equal(env.svc.activeResId, 'r1');
  env.svc.disable();
});

test('la deducción inicial se conserva si el árbol confirma el mismo archivo', () => {
  const env = makeEnv_();
  env.dom.tree.lis.forEach((li) => { li.attrs['aria-selected'] = 'false'; });
  env.editor._model = env.models[1];
  env.svc.enable();
  env.dom.tree.lis[1].attrs['aria-selected'] = 'true';
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r1']);
  openFromTree_(env, 'r2');
  assert.deepEqual(env.ids(), ['r1', 'r2'], 'después de confirmar ya no es provisional');
  env.svc.disable();
});

test('abrir un archivo inserta la pestaña a la derecha de la activa', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r0');
  openFromTree_(env, 'r2');
  assert.deepEqual(env.ids(), ['r0', 'r2', 'r1']);
  assert.equal(env.svc.activeResId, 'r2');
  assert.match(env.html(), /tab__close/);
  env.svc.disable();
});

test('cerrar la activa elige la vecina derecha y luego la izquierda; la última no se cierra', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2'); // [r0, r1, r2]
  openFromTree_(env, 'r1'); // activa r1
  assert.equal(env.svc.closeTab('r1'), true);
  assert.deepEqual(env.ids(), ['r0', 'r2']);
  assert.equal(env.svc.activeResId, 'r2');
  assert.ok(env.byResId.get('r2').li.events.includes('click'), 'clic sintético en el li vecino');
  env.svc.refresh();
  assert.equal(env.svc.closeTab('r2'), true);
  assert.equal(env.svc.activeResId, 'r0');
  env.svc.refresh();
  assert.equal(env.svc.closeTab('r0'), false);
  assert.deepEqual(env.ids(), ['r0']);
  env.svc.disable();
});

test('cerrar una pestaña inactiva no cambia de archivo', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const clicks = env.byResId.get('r0').li.events.length;
  env.svc.closeTab('r0');
  assert.deepEqual(env.ids(), ['r1']);
  assert.equal(env.svc.activeResId, 'r1');
  assert.equal(env.byResId.get('r0').li.events.length, clicks);
  env.svc.disable();
});

test('renombrar actualiza el nombre y borrar quita la pestaña', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const li = env.byResId.get('r1').li;

  li.renaming = true;
  li.titleDiv.attrs.title = 'Ut';
  env.svc.refresh();
  assert.equal(env.svc.tabs[1].name, 'Util.gs', 'durante la edición no se toca el nombre');

  li.renaming = false;
  li.titleDiv.attrs.title = 'lib/Helpers.gs';
  env.svc.refresh();
  assert.equal(env.svc.tabs[1].name, 'lib/Helpers.gs');
  assert.match(env.html(), /title="lib\/Helpers\.gs"/);

  env.gas.remove('r1');
  env.gas.select('r0');
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r0']);
  env.svc.disable();
});

test('un li ausente solo se da por borrado tras el periodo de gracia', async () => {
  const env = makeEnv_();
  env.GasFileTabs.DELETE_GRACE_MS = 40;
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r0');
  env.gas.remove('r1');
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r0', 'r1'], 'GAS puede estar re-renderizando');
  await sleep(90);
  assert.deepEqual(env.ids(), ['r0']);
  env.svc.disable();
});

test('árbol vacío (re-render de GAS) no borra pestañas', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const saved = env.dom.tree.lis;
  env.dom.tree.lis = [];
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r0', 'r1']);
  env.dom.tree.lis = saved;
  env.svc.disable();
});

test('el clic dispara el li correcto; si el árbol no cambia reintenta más fuerte y avisa sin setModel', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.gas.ignoreClicks = true;
  assert.equal(env.svc.activate('r0'), true);
  const li = env.byResId.get('r0').li;
  assert.deepEqual(li.events, ['mousedown', 'mouseup', 'click']);
  assert.deepEqual(env.byResId.get('r2').li.events, []);
  assert.equal(env.svc.activeResId, 'r0', 'resaltado inmediato');
  await sleep(30);
  assert.deepEqual(li.events.slice(3), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], 'reintento con puntero');
  assert.deepEqual(li.titleDiv.events, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], 'también sobre div[title]');
  await sleep(40);
  assert.equal(env.editor.getModel(), env.models[1], 'sin setModel a espaldas de GAS');
  assert.equal(env.svc.activeResId, 'r1', 'manda el árbol');
  assert.equal(env.toasts.at(-1)?.kind, 'error');
  assert.match(env.toasts.at(-1).text, /Couldn't open Code\.gs/);
  env.svc.disable();
});

test('el clic sintético solo va a un li conectado con el mismo data-res-id', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const li = env.byResId.get('r0').li;
  const before = li.events.length;
  assert.equal(env.svc._clickTreeItem_(li, 'r9'), false);
  li.remove();
  assert.equal(env.svc._clickTreeItem_(li, 'r0'), false);
  assert.equal(li.events.length, before);
  env.svc.disable();
});

test('en el respaldo a document se ignoran los li de paneles con aria-hidden', () => {
  const env = makeEnv_();
  const li = env.byResId.get('r3').li;
  li.closest = (sel) => (sel === '[aria-hidden="true"]' ? {} : null);
  env.svc.enable();
  assert.equal(env.svc._readTree_().items.has('r3'), false);
  assert.equal(env.svc._readTree_().items.has('r0'), true);
  env.svc.disable();
});

test('sin li ni modelo conocido, el cambio falla con aviso y el árbol vuelve a mandar', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.gas.ignoreClicks = true;
  env.svc.tabs[0].model = null;
  env.svc.tabs[0].name = 'Missing.gs';
  env.svc.activate('r0');
  await sleep(80);
  assert.equal(env.editor.getModel(), env.models[1]);
  assert.equal(env.svc.activeResId, 'r1');
  assert.equal(env.toasts.at(-1)?.kind, 'error');
  env.svc.disable();
});

test('el punto de sin guardar se activa al editar, se limpia al deshacer y tras Ctrl+S', async () => {
  const env = makeEnv_();
  env.svc.enable();
  const model = env.models[0];
  model.edit();
  assert.equal(env.svc.isDirty('r0'), true);
  assert.match(env.html(), /class="tab is-active is-dirty"/);
  assert.match(env.html(), /aria-label="Code\.gs, unsaved changes"/);
  model.undo();
  assert.equal(env.svc.isDirty('r0'), false);
  model.edit();
  assert.equal(env.svc.isDirty('r0'), true);
  // Ctrl+S (también el sintético de _saveProject_) en captura sobre document.
  env.dom.document.dispatchEvent({ type: 'keydown', key: 's', code: 'KeyS', ctrlKey: true });
  assert.equal(env.svc.isDirty('r0'), true, 'se espera a que GAS guarde');
  await sleep(50);
  assert.equal(env.svc.isDirty('r0'), false);
  assert.ok(!/is-dirty/.test(env.html()));
  model.edit();
  assert.equal(env.svc.isDirty('r0'), true, 'nueva línea base tras guardar');
  env.svc.disable();
});

test('los modelos gas-preview y los cambios durante _switching se ignoran', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const preview = makeModel_({ scheme: 'gas-preview' });
  env.createSubs.forEach((f) => f(preview));
  assert.equal(preview.subs.size, 0, 'no se escucha el modelo de vista previa');
  env.ctx.gasDiffPreview = { _switching: true };
  env.editor.setModel(preview);
  env.ctx.gasDiffPreview._switching = false;
  env.svc.refresh();
  assert.deepEqual(env.ids(), ['r0', 'r1']);
  assert.equal(env.svc.activeResId, 'r1');
  assert.equal(env.svc.tabs[1].model, env.models[1], 'no se asocia el modelo de vista previa');
  preview.edit();
  assert.equal(env.svc.isDirty('r1'), false);
  env.svc.disable();
});

test('nombres duplicados muestran la carpeta atenuada y todo se escapa', () => {
  const env = makeEnv_({ names: ['a/Util.gs', 'b/Util.gs', '<img src=x onerror=alert(1)>.gs'] });
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2');
  const out = env.html();
  assert.match(out, /<span class="tab__hint">a<\/span>/);
  assert.match(out, /<span class="tab__hint">b<\/span>/);
  assert.ok(!out.includes('<img'), 'sin HTML sin escapar');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;\.gs/);
  env.svc.disable();
});

test('menú contextual: cerrar otras y cerrar a la derecha', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2');
  openFromTree_(env, 'r3'); // [r0, r1, r2, r3], activa r3
  assert.equal(env.svc._runMenuAction_('closeRight', 'r1'), true);
  assert.deepEqual(env.ids(), ['r0', 'r1']);
  assert.equal(env.svc.activeResId, 'r1', 'la activa estaba a la derecha');
  env.svc.refresh();
  assert.equal(env.svc._runMenuAction_('closeRight', 'r1'), false, 'nada a la derecha');
  openFromTree_(env, 'r2'); // [r0, r1, r2]
  assert.equal(env.svc._runMenuAction_('closeOthers', 'r2'), true);
  assert.deepEqual(env.ids(), ['r2']);
  assert.equal(env.svc.activeResId, 'r2');
  env.svc.disable();
});

test('menú contextual: se monta en body, copia el nombre y Escape lo cierra sin fugas', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  const before = env.ctx.listeners.length;
  env.svc._openMenu_('r1', env.svc.constructor._pointAnchor_(10, 10));
  assert.ok(!env.dom.body.children.some((c) => c.id === 'qc__fileTabsMenuHost'), 'se abre en el siguiente frame');
  await sleep(5);
  const host = env.dom.body.children.find((c) => c.id === 'qc__fileTabsMenuHost');
  assert.ok(host, 'host del menú en body');
  const menu = host.shadowRoot.children[0];
  assert.match(menu.className, /gt-menu/);
  assert.match(menu._html, /data-action="closeOthers"/);
  assert.ok(env.ctx.listeners.length > before);
  env.svc._onMenuKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(env.dom.body.children.includes(host), false);
  assert.equal(env.ctx.listeners.length, before, 'listeners de window liberados');
  assert.equal(env.svc._runMenuAction_('copyName', 'r1'), true);
  await sleep(0);
  assert.deepEqual(env.copied, ['Util.gs']);
  assert.equal(env.toasts.length, 1);
  env.svc.disable();
});

test('reordenar: moveTab, drop y Ctrl+Shift+→ sobre la pestaña enfocada', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2'); // [r0, r1, r2]
  assert.equal(env.svc.moveTab('r0', 1), true);
  assert.deepEqual(env.ids(), ['r1', 'r0', 'r2']);
  assert.equal(env.svc.moveTab('r2', 1), false, 'sin dar la vuelta');
  env.svc._dropAt_('r1', 3);
  assert.deepEqual(env.ids(), ['r0', 'r2', 'r1']);
  const el = { getAttribute: () => 'r0', closest: () => el };
  let prevented = false;
  env.svc._onBarKeyDown({ key: 'ArrowRight', ctrlKey: true, shiftKey: true, target: el,
    preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.ok(prevented);
  assert.deepEqual(env.ids(), ['r2', 'r0', 'r1']);
  env.svc._onBarKeyDown({ key: 'Delete', target: el, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(env.ids(), ['r2', 'r1']);
  env.svc.disable();
});

test('GAS_HidePanels oculta la barra y GAS_ReturnToEditor la muestra', () => {
  const env = makeEnv_();
  env.svc.enable();
  const host = env.dom.wrapper.children[0];
  env.dom.document.dispatchEvent({ type: 'GAS_HidePanels' });
  assert.equal(host.style.display, 'none');
  env.dom.document.dispatchEvent({ type: 'GAS_ReturnToEditor' });
  assert.equal(host.style.display, 'block');
  env.svc.disable();
});

test('teardown sin fugas: DOM, listeners, observers y suscripciones', async () => {
  const env = makeEnv_();
  const docBefore = env.dom.document.listeners.length;
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.svc._openMenu_('r1', env.svc.constructor._pointAnchor_(0, 0));
  await sleep(5);
  assert.ok(env.dom.body.children.some((c) => c.id === 'qc__fileTabsMenuHost'));
  assert.ok(env.dom.document.listeners.length > docBefore);
  env.svc.disable();
  assert.equal(env.dom.document.listeners.length, docBefore, 'listeners de document liberados');
  assert.equal(env.ctx.listeners.length, 0, 'listeners de window liberados');
  assert.equal(env.dom.wrapper.children.includes(env.dom.anchor), true);
  assert.equal(env.dom.wrapper.children.length, 1, 'barra desmontada');
  assert.ok(!env.dom.body.children.some((c) => c.id === 'qc__fileTabsMenuHost'), 'menú desmontado');
  assert.ok(env.ctx.__observers.every((o) => !o.active), 'observers desconectados');
  assert.ok(env.models.every((m) => m.subs.size === 0), 'onDidChangeContent liberados');
  assert.equal(env.createSubs.size, 0, 'onDidCreateModel liberado');
  assert.equal(env.svc.tabs.length, 0, 'sin persistencia');
  // Reactivar empieza de cero con el archivo activo.
  env.svc.enable();
  assert.deepEqual(env.ids(), ['r1']);
  env.svc.disable();
});

test('bootstrap: toggle desactivado por defecto, pausa global y deltas en pausa', () => {
  const env = makeEnv_();
  const svc = env.ctx.gasFileTabs;
  const fire = (type, detail) => env.dom.document.dispatchEvent({ type, detail: JSON.stringify(detail) });
  fire('GAS_TransferData', { settings: { 'global-enable': true } });
  assert.equal(svc.enabled, false, 'desactivado por defecto');
  fire('GAS_SettingsUpdated', { 'gas-file-tabs': true });
  assert.equal(svc.enabled, true);
  fire('GAS_SettingsUpdated', { 'global-enable': false, 'gas-file-tabs': true });
  assert.equal(svc.enabled, false);
  fire('GAS_SettingsUpdated', { 'gas-file-tabs': true });
  assert.equal(svc.enabled, false, 'un delta en pausa no lo activa');
  fire('GAS_SettingsUpdated', { 'global-enable': true, 'gas-file-tabs': true });
  assert.equal(svc.enabled, true);
  env.dom.document.dispatchEvent({ type: 'GAS_GlobalDisable' });
  assert.equal(svc.enabled, false);
});

// ── Regresiones (antes `todo`) ──────────────────────────────────────────────

test('BUG: si el árbol ya marca la pestaña pero el editor muestra otro modelo, se restaura', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r0');                 // [r0, r1], activa r0, modelos asociados
  env.gas.ignoreClicks = true;
  // GAS marca r1 en el árbol, pero el editor sigue en Code.gs (setModel ajeno).
  for (const li of env.dom.tree.lis) li.attrs['aria-selected'] = String(li.attrs['data-res-id'] === 'r1');
  env.svc.activate('r1');
  await sleep(30);
  env.svc.refresh();
  assert.equal(env.editor.getModel(), env.models[1], 'el editor vuelve a Util.gs');
  assert.equal(env.svc.tabs.find((t) => t.resId === 'r1').model, env.models[1]);
  assert.equal(env.svc.tabs.find((t) => t.resId === 'r0').model, env.models[0], 'sin asociaciones cruzadas');
  env.svc.disable();
});

test('BUG: un clic del usuario en el árbol durante la espera cancela el cambio pendiente', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.gas.ignoreClicks = true;              // GAS lento: no refleja el clic en 20 ms
  env.svc.activate('r0');
  env.gas.ignoreClicks = false;
  openFromTree_(env, 'r2');                 // el usuario elige otro archivo en el árbol
  await sleep(80);
  env.svc.refresh();
  assert.equal(env.editor.getModel(), env.models[2]);
  assert.equal(env.svc.activeResId, 'r2');
  assert.equal(env.byResId.get('r0').li.events.length, 3, 'sin reintento tras cancelar');
  env.svc.disable();
});

test('BUG: si el árbol cambia antes que el modelo, la pestaña nueva no roba el modelo anterior', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  // GAS marca r2 en el árbol pero aún no cambió el modelo (carga asíncrona).
  for (const li of env.dom.tree.lis) li.attrs['aria-selected'] = String(li.attrs['data-res-id'] === 'r2');
  env.svc.refresh();
  env.editor.setModel(env.models[2]);
  env.svc.refresh();
  env.models[1].edit();                     // Util.gs cambia (p. ej. el agente)
  assert.equal(env.svc.isDirty('r1'), true);
  assert.equal(env.svc.tabs.find((t) => t.resId === 'r2').model, env.models[2]);
  env.svc.disable();
});

test('BUG: cambio de proyecto (GAS_HidePanels sin GAS_ReturnToEditor) vuelve a mostrar la barra', () => {
  const env = makeEnv_();
  env.svc.enable();
  const host = env.dom.wrapper.children[0];
  env.dom.document.dispatchEvent({ type: 'GAS_HidePanels' });   // onProjectChange
  assert.equal(host.style.display, 'none');
  env.svc.setEditor({ ...env.editor });                          // editor del proyecto nuevo
  env.svc.refresh();
  assert.equal(host.style.display, 'block');
  env.svc.disable();
});

test('fuera de la ruta /edit un editor nuevo no muestra la barra oculta', () => {
  const env = makeEnv_();
  env.svc.enable();
  const host = env.dom.wrapper.children[0];
  env.dom.document.dispatchEvent({ type: 'GAS_HidePanels' });
  env.ctx.location.pathname = '/home/projects/abc/executions';
  env.svc.setEditor({ ...env.editor });
  assert.equal(host.style.display, 'none');
  env.svc.disable();
});

test('BUG: lo editado durante la espera tras Ctrl+S no queda absorbido en la línea base', async () => {
  const env = makeEnv_();
  env.svc.enable();
  env.dom.document.dispatchEvent({ type: 'keydown', key: 's', code: 'KeyS', ctrlKey: true });
  await sleep(5);
  env.models[0].edit();                     // el usuario sigue escribiendo
  await sleep(50);
  assert.equal(env.svc.isDirty('r0'), true);
  env.svc.disable();
});

// ── R2: pestañas con cambios sin guardar ────────────────────────────────────

/** Fragmento HTML de una pestaña concreta. */
function tabHtml_(env, resId) {
  const out = env.html();
  const i = out.indexOf(`data-res-id="${resId}"`);
  const j = out.indexOf('role="tab"', i);
  return out.slice(i, j < 0 ? undefined : j);
}

test('una pestaña con cambios no se puede cerrar: sin ×, toast y las acciones masivas la saltan', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2');
  openFromTree_(env, 'r3');                 // [r0, r1, r2, r3], activa r3
  env.models[1].edit();                     // Util.gs con cambios
  assert.ok(!tabHtml_(env, 'r1').includes('tab__close'), 'r1 sin ×');
  assert.ok(tabHtml_(env, 'r1').includes('tab__dot'), 'r1 con ●');
  assert.ok(tabHtml_(env, 'r0').includes('tab__close'));
  assert.equal(env.svc.closeTab('r1'), false);
  assert.equal(env.toasts.at(-1).text, 'Save the changes to Util.gs before closing');
  assert.equal(env.svc._runMenuAction_('close', 'r1'), false);
  assert.equal(env.svc.closeToRight('r0'), true);
  assert.deepEqual(env.ids(), ['r0', 'r1']);
  assert.equal(env.toasts.at(-1).text, 'A tab with unsaved changes stayed open');
  env.svc.refresh();
  openFromTree_(env, 'r2');
  assert.equal(env.svc.closeOthers('r2'), true);
  assert.deepEqual(env.ids(), ['r2', 'r1'], 'r1 con cambios se queda');
  env.svc.disable();
});

test('la × es un span aria-hidden (sin control anidado en role=tab)', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  assert.match(env.html(), /<span class="tab__close" aria-hidden="true"/);
  assert.ok(!/<button/.test(env.html()));
  env.svc.disable();
});

test('nombres duplicados en la raíz muestran "/" como pista', () => {
  const env = makeEnv_({ names: ['Util.gs', 'lib/Util.gs'] });
  env.svc.enable();
  openFromTree_(env, 'r1');
  assert.match(env.html(), /<span class="tab__hint">\/<\/span>/);
  assert.match(env.html(), /<span class="tab__hint">lib<\/span>/);
  env.svc.disable();
});

// ── R1: lista de pestañas ocultas ───────────────────────────────────────────

/** Simula una barra desbordada: cada pestaña mide 100 px y la barra 250 px. */
function overflowBar_(env, scrollLeft = 0) {
  const bar = env.svc._bar;
  bar.scrollWidth = env.svc.tabs.length * 100;
  bar.clientWidth = 250;
  bar.scrollLeft = scrollLeft;
  bar.rect = { left: 0, right: 250, top: 0, bottom: 32, width: 250, height: 32 };
  bar.qsa = (sel) => (sel === '.tab' ? env.svc.tabs.map((t, i) => {
    const el = new env.dom.FakeNode('div');
    el.attrs['data-res-id'] = t.resId;
    el.rect = { left: i * 100 - scrollLeft, right: (i + 1) * 100 - scrollLeft, top: 0, bottom: 32, width: 100, height: 32 };
    return el;
  }) : []);
}

test('al desbordar aparece el botón con el contador de ocultas y el difuminado', () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2');
  openFromTree_(env, 'r3');
  const more = env.svc._more;
  env.svc._updateOverflow_();
  assert.equal(more.hidden, true, 'sin desbordamiento no se ve');
  overflowBar_(env, 0);
  env.svc._updateOverflow_();
  assert.equal(more.hidden, false);
  assert.match(more._html, /more__count">2</, 'r2 (parcial) y r3 ocultas');
  assert.equal(more.getAttribute('aria-label'), 'Show all open tabs (2 hidden)');
  assert.ok(env.svc._bar.classList.contains('has-end'));
  assert.ok(!env.svc._bar.classList.contains('has-start'));
  overflowBar_(env, 150);
  env.svc._updateOverflow_();
  assert.ok(env.svc._bar.classList.contains('has-start'));
  env.svc.disable();
});

test('la lista muestra ocultas y visibles, activa, ●, × solo si se puede cerrar y abre al elegir', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  openFromTree_(env, 'r2');
  openFromTree_(env, 'r3');                 // [r0, r1, r2, r3], activa r3
  env.models[1].edit();
  overflowBar_(env, 0);
  env.svc._onMoreClick();
  await sleep(5);
  const m = env.svc._menu;
  assert.equal(m.kind, 'list');
  assert.equal(m.input, null, 'sin buscador con pocas pestañas');
  const out = m.list._html;
  assert.ok(out.indexOf('>Hidden<') < out.indexOf('data-res-id="r2"'));
  assert.ok(out.indexOf('>Visible<') < out.indexOf('data-res-id="r0"'));
  assert.ok(out.indexOf('data-res-id="r2"') < out.indexOf('>Visible<'), 'ocultas antes que visibles');
  assert.match(out, /aria-checked="true"\s+data-res-id="r3"/);
  const r1 = out.slice(out.indexOf('data-res-id="r1"'), out.indexOf('</div>', out.indexOf('data-res-id="r1"')));
  assert.ok(r1.includes('row__dot'), '● en la que tiene cambios');
  assert.ok(!/data-close="r1"/.test(out), 'sin × en la que tiene cambios');
  assert.match(out, /data-close="r0"/);
  assert.equal(env.svc._closeFromList_('r0'), true);
  assert.ok(env.svc._menu, 'la lista sigue abierta tras cerrar una fila');
  env.svc._pickFromList_('r2');
  assert.equal(env.svc._menu, null);
  assert.equal(env.svc.activeResId, 'r2');
  env.svc.disable();
});

test('la lista incluye buscador con más de 8 pestañas y filtra por nombre', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `File${i}.gs`);
  const env = makeEnv_({ names });
  env.svc.enable();
  for (let i = 1; i < 10; i++) openFromTree_(env, `r${i}`);
  env.svc._openList_();
  await sleep(5);
  assert.ok(env.svc._menu.input, 'buscador');
  env.svc._onListFilter({ target: { value: 'file7' } });
  assert.match(env.svc._menu.list._html, /data-res-id="r7"/);
  assert.ok(!/data-res-id="r3"/.test(env.svc._menu.list._html));
  env.svc._onListFilter({ target: { value: 'zzz' } });
  assert.match(env.svc._menu.list._html, /No matching tabs/);
  env.svc.disable();
});

test('S3/U1: el menú ignora teclas ajenas y no se cierra por el scroll programático', async () => {
  const env = makeEnv_();
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.svc._openMenu_('r1', env.svc.constructor._pointAnchor_(0, 0));
  await sleep(5);
  let prevented = false;
  env.svc._onMenuKey({ key: 'ArrowDown', composedPath: () => [], preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, false, 'tecla fuera del menú');
  env.svc._onBarScroll();
  assert.ok(env.svc._menu, 'scroll justo tras abrir no lo cierra');
  env.svc._menu.openedAt = 0;
  env.svc._programmaticScrollAt = 0;
  env.svc._onBarScroll();
  assert.equal(env.svc._menu, null, 'scroll del usuario sí');
  env.svc._openMenu_('r1', env.svc.constructor._pointAnchor_(0, 0));
  await sleep(5);
  env.svc._onMenuFocusOut({ relatedTarget: null });
  assert.equal(env.svc._menu, null, 'focusout fuera del host lo cierra');
  env.svc.disable();
});

// ── R3: indicador nativo de GAS ─────────────────────────────────────────────

test('con DIRTY_SELECTOR el ● sale del árbol y toma su color visible', () => {
  const env = makeEnv_();
  env.GasFileTabs.DIRTY_SELECTOR = '.dirty-dot';
  env.svc.enable();
  openFromTree_(env, 'r1');
  env.models[0].edit();
  assert.equal(env.svc.isDirty('r0'), true, 'antes de ver el indicador nativo: versiones');
  const li = env.byResId.get('r1').li;
  li.nativeDirty = true;
  li.dirtyDot.bg = 'rgb(227, 116, 0)';
  env.svc.refresh();
  assert.equal(env.svc.isDirty('r1'), true);
  assert.equal(env.svc.isDirty('r0'), false, 'manda el árbol, no las versiones');
  assert.equal(env.svc._host.style.getPropertyValue('--tab-dirty-color'), 'rgb(227, 116, 0)');
  assert.match(env.html(), /aria-label="Util\.gs, unsaved changes"/);
  assert.match(env.html(), /title="Unsaved changes"/);
  assert.equal(env.svc.closeTab('r1'), false);
  li.nativeDirty = false;
  env.svc.refresh();
  assert.equal(env.svc.isDirty('r1'), false);
  env.svc.disable();
});

test('la barra se limita al ancho visible cuando el editor de GAS desborda la ventana', () => {
  const env = makeEnv_();
  env.svc.enable();
  const host = env.svc._host;
  env.dom.anchor.rect = { left: 280, right: 1200, top: 32, bottom: 600, width: 920, height: 568 };
  env.dom.document.documentElement.clientWidth = 508;
  env.svc._fitVisibleWidth_();
  assert.equal(host.style.width, '228px', 'ventana de 508 px menos el árbol (280 px)');
  env.dom.document.documentElement.clientWidth = 1600;
  env.svc._fitVisibleWidth_();
  assert.equal(host.style.width, '920px', 'con ventana ancha iguala el ancho del editor');
  env.svc.disable();
  assert.ok(!env.ctx.listeners.some((l) => l.type === 'resize' && l.fn === env.svc._onWindowResize), 'sin fuga del listener resize');
});

test('el ancho sigue al editor (no al padre que se ajusta a la barra) al plegar o ampliar', () => {
  const env = makeEnv_();
  env.svc.enable();
  const host = env.svc._host;
  // Padre de GAS que mide lo que mida la barra: no debe usarse como referencia.
  Object.defineProperty(host.parentElement, 'rect', {
    configurable: true,
    get: () => ({ left: 290, right: 290 + (parseFloat(host.style.width) || 290), top: 0, bottom: 600, width: 0, height: 600 }),
  });
  env.dom.document.documentElement.clientWidth = 1912;
  env.dom.anchor.rect = { left: 290, right: 1912, top: 32, bottom: 600, width: 1622, height: 568 };
  env.svc._fitVisibleWidth_();
  assert.equal(host.style.width, '1622px');
  // Se pliega el panel de archivos: el editor empieza más a la izquierda.
  env.dom.anchor.rect = { left: 60, right: 1912, top: 32, bottom: 600, width: 1852, height: 568 };
  env.svc._fitVisibleWidth_();
  assert.equal(host.style.width, '1852px');
  env.svc.disable();
});

test('ancla absoluta: corrige el hueco o el solape con la barra sin acumularlo', () => {
  const env = makeEnv_();
  const anchor = env.dom.anchor;
  anchor.style.top = '';
  env.ctx.getComputedStyle = (node) => ({
    filter: 'none',
    position: node === anchor ? 'absolute' : 'static',
    top: node === anchor ? (anchor.style.top || '0px') : '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)', color: '',
  });
  env.svc.enable();
  env.svc._host.rect = { left: 0, right: 800, top: 100, bottom: 132, width: 800, height: 32 };
  // GAS dejó el editor 32 px por debajo de la barra (hueco).
  anchor.rect = { left: 0, right: 800, top: 164, bottom: 600, width: 800, height: 436 };
  anchor.style.top = '64px';
  env.svc._fitAnchor_();
  assert.equal(anchor.style.top, '32px', 'cierra el hueco');
  anchor.rect = { ...anchor.rect, top: 132 };
  env.svc._fitAnchor_();
  assert.equal(anchor.style.top, '32px', 'alineado: no vuelve a sumar');
  env.svc.disable();
  assert.equal(anchor.style.top, '64px', 'se restaura el valor que tenía GAS al desmontar');
});

test('selector nativo real: círculo naranja de GAS, color desde fill y oculto = guardado', () => {
  const env = makeEnv_();
  const { GasFileTabs, ctx } = env;
  assert.match(GasFileTabs.DIRTY_SELECTOR, /svg\.NSy2Hd/);
  assert.match(GasFileTabs.DIRTY_SELECTOR, /circle\[fill="#EA8600" i\]/);
  assert.equal(GasFileTabs._invertColor_('#EA8600'), 'rgb(21, 121, 255)');
  // Nodo SVG falso dentro de un li: el color sale del fill del círculo exterior.
  const li = { tagName: 'LI', parentElement: null };
  const svg = {
    tagName: 'svg', parentElement: li, hidden: false,
    querySelector: (sel) => (sel === 'circle[fill]' ? { getAttribute: () => '#EA8600' } : null),
    getAttribute: () => null,
  };
  ctx.getComputedStyle = (n) => ({ filter: 'none', display: n?.hidden ? 'none' : 'inline', visibility: 'visible' });
  assert.equal(GasFileTabs._visibleNode_(svg), svg);
  svg.hidden = true;
  assert.equal(GasFileTabs._visibleNode_(svg), null, 'GAS oculta el indicador al guardar');
  svg.hidden = false;
  env.svc.enable();
  env.svc._syncDirtyColor_(svg);
  assert.equal(env.svc._host.style.getPropertyValue('--tab-dirty-color'), '#EA8600');
  env.svc.disable();
});

test('el color del indicador se invierte si el árbol está invertido (modo oscuro)', () => {
  const { GasFileTabs } = makeEnv_();
  assert.equal(GasFileTabs._invertColor_('rgb(227, 116, 0)'), 'rgb(28, 139, 255)');
  assert.equal(GasFileTabs._invertColor_('rgba(255, 0, 0, 0.5)'), 'rgba(0, 255, 255, 0.5)');
});
