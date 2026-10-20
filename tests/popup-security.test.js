// Seguridad y accesibilidad del popup: escape de temas (ThemeCard, Html.js)
// y diálogo de confirmación (Escape y trampa de foco).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeColor, safeColorList } from '../src/js/utils/Html.js';

test('escapeHtml y safeColor neutralizan nombres y colores maliciosos', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(safeColor('#1e1e1e'), '#1e1e1e');
  assert.equal(safeColor('#abc'), '#abc');
  assert.equal(safeColor('#11223344'), '#11223344');
  assert.equal(safeColor('red;}</style><script>', 'x'), 'x');
  assert.equal(safeColor('url(https://evil)'), '');
  assert.deepEqual(safeColorList('#fff, bad ,#000000'), ['#fff', '#000000']);
});

test('ThemeCard escapa el nombre y descarta colores no hex', async () => {
  globalThis.HTMLElement = class {
    constructor() { this._attrs = {}; }
    attachShadow() { this.shadowRoot = { innerHTML: '' }; return this.shadowRoot; }
    getAttribute(k) { return this._attrs[k] ?? null; }
    hasAttribute(k) { return k in this._attrs; }
  };
  globalThis.customElements = { define() {} };
  const { ThemeCard } = await import('../src/components/ThemeCard.js');
  const card = new ThemeCard();
  card._attrs = {
    name: '"><img src=x onerror=alert(1)>',
    colors: '#1e1e1e,red;}</style><script>alert(1)</script>,#d4d4d4,#ce9178',
  };
  card.render_();
  const html = card.shadowRoot.innerHTML;
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /aria-label="&quot;&gt;&lt;img/);
  assert.match(html, /background: #1e1e1e;/);
  assert.equal((html.match(/class="qc__dot"/g) || []).length, 3);
});

/** DOM mínimo para ConfirmDialog con listeners de document capturados. */
function fakeConfirmDom() {
  const docListeners = [];
  const el = (id) => ({
    id, textContent: '', onclick: null,
    classList: { set: new Set(['hidden']), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    focus() { doc.activeElement = this; },
  });
  const nodes = Object.fromEntries(['qc__confirm', 'qc__confirm-text', 'qc__confirm-ok', 'qc__confirm-cancel'].map((id) => [id, el(id)]));
  const opener = el('opener');
  const doc = {
    activeElement: opener,
    getElementById: (id) => nodes[id],
    addEventListener: (type, fn) => docListeners.push([type, fn]),
    removeEventListener: (type, fn) => { const i = docListeners.findIndex((l) => l[1] === fn); if (i >= 0) docListeners.splice(i, 1); },
  };
  nodes['qc__confirm'].contains = (n) => n === nodes['qc__confirm-ok'] || n === nodes['qc__confirm-cancel'];
  const key = (k, shiftKey = false) => {
    const e = { key: k, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    docListeners.filter((l) => l[0] === 'keydown').forEach((l) => l[1](e));
    return e;
  };
  return { doc, nodes, opener, key, docListeners };
}

test('ConfirmDialog: Tab/Shift+Tab quedan dentro y Escape resuelve false', async () => {
  const dom = fakeConfirmDom();
  globalThis.document = dom.doc;
  const { ConfirmDialog } = await import('../src/js/utils/ConfirmDialog.js');
  const { nodes, key } = dom;
  const p = ConfirmDialog('¿Borrar?');
  assert.equal(nodes['qc__confirm'].classList.contains('hidden'), false);
  assert.equal(dom.doc.activeElement, nodes['qc__confirm-cancel']);

  assert.equal(key('Tab', true).defaultPrevented, true);
  assert.equal(dom.doc.activeElement, nodes['qc__confirm-ok']);
  assert.equal(key('Tab').defaultPrevented, true);
  assert.equal(dom.doc.activeElement, nodes['qc__confirm-cancel']);

  key('Escape');
  assert.equal(await p, false);
  assert.equal(nodes['qc__confirm'].classList.contains('hidden'), true);
  assert.equal(dom.docListeners.length, 0, 'libera el listener');
  assert.equal(dom.doc.activeElement, dom.opener, 'devuelve el foco');

  const p2 = ConfirmDialog('¿Seguro?');
  nodes['qc__confirm-ok'].onclick();
  assert.equal(await p2, true);
});
